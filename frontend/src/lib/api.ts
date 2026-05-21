import axios from 'axios';
import { getToken, clearToken, clearUser, type User } from './auth';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Inject Bearer token on every request if available
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401, clear auth state and bounce to /login — but skip /auth/* routes
// because login/signup pages display their own error messages.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url: string | undefined = error?.config?.url;
    if (status === 401 && url && !url.startsWith('/auth/')) {
      clearToken();
      clearUser();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);

export type { User };

// Types
export interface Mailbox {
  id: string;
  provider: 'GMAIL' | 'OUTLOOK' | 'IMAP';
  emailAddress: string;
  displayName?: string;
  isActive: boolean;
  watchExpiry?: string;
  createdAt: string;
  updatedAt: string;
  _count?: { threads: number; messages: number };
}

export type ReplyStatus = 'NEW' | 'AWAITING_REPLY' | 'REPLIED';

export interface Candidate {
  id: string;
  name: string;
  email: string;
  company?: string;
  title?: string;
  status:
    | 'PENDING'
    | 'INTERESTED'
    | 'NOT_INTERESTED'
    | 'NEUTRAL'
    | 'REPLIED'
    | 'NEEDS_REVIEW'
    | 'IGNORED';
  source?: string;
  notes?: string;
  mailboxId?: string;
  mailbox?: Pick<Mailbox, 'id' | 'emailAddress' | 'provider'>;
  threads?: EmailThread[];
  repliedAt?: string | null;
  replyStatus?: ReplyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmailThread {
  id: string;
  candidateId?: string;
  candidate?: Pick<Candidate, 'id' | 'name' | 'email' | 'status'>;
  mailboxId: string;
  mailbox?: Pick<Mailbox, 'id' | 'emailAddress' | 'provider'>;
  externalThreadId: string;
  subject: string;
  lastMessageAt: string;
  createdAt: string;
  messages?: EmailMessage[];
  drafts?: EmailDraft[];
  _count?: { messages: number; drafts: number };
}

export interface EmailMessage {
  id: string;
  threadId: string;
  mailboxId: string;
  externalMessageId: string;
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  receivedAt: string;
  headers: Record<string, string>;
  createdAt: string;
}

export interface OriginalMessage {
  id: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string;
}

export interface EmailDraft {
  id: string;
  threadId: string;
  thread?: EmailThread;
  inReplyToMessageId?: string;
  referencesHeader?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  classification: 'INTERESTED' | 'NOT_INTERESTED' | 'NEUTRAL';
  confidence: number;
  status: 'PENDING' | 'APPROVED' | 'SENT' | 'DISCARDED';
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
  originalMessage?: OriginalMessage | null;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: { connected: boolean; latencyMs?: number };
  claude: { available: boolean };
  mailboxes: Array<{
    id: string;
    emailAddress: string;
    provider: string;
    isActive: boolean;
    watchExpiry?: string;
  }>;
  recentLogs: Array<{
    id: string;
    event: string;
    level: string;
    createdAt: string;
    details: unknown;
  }>;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: { total: number; page: number; limit: number };
}

interface SingleResponse<T> {
  success: boolean;
  data: T;
}

// Candidates
export async function fetchCandidates(filters?: {
  status?: string;
  mailboxId?: string;
  page?: number;
  limit?: number;
  includeIgnored?: boolean;
}): Promise<PaginatedResponse<Candidate>> {
  const res = await api.get('/candidates', { params: filters });
  return res.data as PaginatedResponse<Candidate>;
}

export async function fetchCandidate(id: string): Promise<SingleResponse<Candidate>> {
  const res = await api.get(`/candidates/${id}`);
  return res.data as SingleResponse<Candidate>;
}

export async function updateCandidate(
  id: string,
  data: Partial<Candidate>
): Promise<SingleResponse<Candidate>> {
  const res = await api.patch(`/candidates/${id}`, data);
  return res.data as SingleResponse<Candidate>;
}

export async function ignoreCandidate(id: string): Promise<SingleResponse<Candidate>> {
  const res = await api.post(`/candidates/${id}/ignore`);
  return res.data as SingleResponse<Candidate>;
}

export async function unignoreCandidate(id: string): Promise<SingleResponse<Candidate>> {
  const res = await api.post(`/candidates/${id}/unignore`);
  return res.data as SingleResponse<Candidate>;
}

// Mailboxes
export async function fetchMailboxes(): Promise<SingleResponse<Mailbox[]>> {
  const res = await api.get('/mailboxes');
  return res.data as SingleResponse<Mailbox[]>;
}

export async function addGmailMailbox(): Promise<{ success: boolean; data: { authUrl: string } }> {
  const res = await api.post('/mailboxes/gmail/auth');
  return res.data as { success: boolean; data: { authUrl: string } };
}

export async function deleteMailbox(id: string): Promise<{ success: boolean; message: string }> {
  const res = await api.delete(`/mailboxes/${id}`);
  return res.data as { success: boolean; message: string };
}

// Threads
export async function fetchThreads(filters?: {
  mailboxId?: string;
  candidateId?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResponse<EmailThread>> {
  const res = await api.get('/emails/threads', { params: filters });
  return res.data as PaginatedResponse<EmailThread>;
}

export async function fetchMessages(
  threadId: string
): Promise<SingleResponse<EmailThread>> {
  const res = await api.get(`/emails/threads/${threadId}/messages`);
  return res.data as SingleResponse<EmailThread>;
}

// Drafts
export async function fetchDrafts(filters?: {
  status?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResponse<EmailDraft>> {
  const res = await api.get('/drafts', { params: filters });
  return res.data as PaginatedResponse<EmailDraft>;
}

export async function fetchDraft(id: string): Promise<SingleResponse<EmailDraft>> {
  const res = await api.get(`/drafts/${id}`);
  return res.data as SingleResponse<EmailDraft>;
}

export async function updateDraft(
  id: string,
  data: { bodyText?: string; bodyHtml?: string; subject?: string }
): Promise<SingleResponse<EmailDraft>> {
  const res = await api.patch(`/drafts/${id}`, data);
  return res.data as SingleResponse<EmailDraft>;
}

export async function approveDraft(id: string): Promise<{ success: boolean; message: string }> {
  const res = await api.post(`/drafts/${id}/approve`);
  return res.data as { success: boolean; message: string };
}

export async function discardDraft(id: string): Promise<{ success: boolean; message: string }> {
  const res = await api.post(`/drafts/${id}/discard`);
  return res.data as { success: boolean; message: string };
}

export async function sendDraft(id: string): Promise<{ success: boolean; message: string }> {
  const res = await api.post(`/drafts/${id}/send`);
  return res.data as { success: boolean; message: string };
}

export async function regenerateDraft(id: string): Promise<SingleResponse<EmailDraft>> {
  const res = await api.post(`/drafts/${id}/regenerate`);
  return res.data as SingleResponse<EmailDraft>;
}

// Health
export async function fetchHealth(): Promise<SingleResponse<HealthStatus>> {
  const res = await api.get('/health');
  return res.data as SingleResponse<HealthStatus>;
}

// Sync-health (per-mailbox observability for dashboard / debug)
export interface MailboxSyncHealth {
  mailboxId: string;
  emailAddress: string;
  displayName: string | null;
  isActive: boolean;
  watchExpiry: string | null;
  watchExpiresInHours: number | null;
  lastSyncedMessageAt: string | null;
  lastReconciliationAt: string | null;
  lastReconciliationFoundMissing: number;
  messagesLast24h: number;
  pendingDrafts: number;
  candidatesNeedsReview: number;
  webhookErrorsLast24h: number;
}

export async function fetchSyncHealth(): Promise<SingleResponse<MailboxSyncHealth[]>> {
  const res = await api.get('/internal/sync-health');
  return res.data as SingleResponse<MailboxSyncHealth[]>;
}

// Auth
interface AuthResponse {
  token: string;
  user: User;
}

export async function signup(
  email: string,
  password: string,
  name?: string
): Promise<AuthResponse> {
  const res = await api.post('/auth/signup', { email, password, name });
  const body = res.data as SingleResponse<AuthResponse>;
  return body.data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await api.post('/auth/login', { email, password });
  const body = res.data as SingleResponse<AuthResponse>;
  return body.data;
}

export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  const res = await api.post('/auth/google', { idToken });
  const body = res.data as SingleResponse<AuthResponse>;
  return body.data;
}

export async function getMe(): Promise<User> {
  const res = await api.get('/auth/me');
  const body = res.data as SingleResponse<{ user: User }>;
  return body.data.user;
}
