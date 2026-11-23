import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { prisma } from '../db/client';
import { classifyReply, generateDraftReply, generateHandoffDraftReply, getHandoffType, type ExampleReply, type Classification, type HandoffType, type DraftGenerationMeta } from './claude.service';
import { logEvent } from './monitoring.service';
import { scheduleLeverRefresh } from './leverRealtime.service';
import { scheduleGemEnrichment } from './gemEnrichment.service';
import { decrypt, encrypt } from '../lib/crypto';
import { safeError, isAuthRevokedError, MailboxNeedsReauthError } from '../lib/safeError';
import { markMailboxNeedsReauth, AUTH_STATUS_NEEDS_REAUTH, AUTH_STATUS_OK } from './mailboxAuth.service';
import {
  isInternalAddress,
  isMailboxOwnAddress,
  mailboxOwnAddresses,
  sendAsEmailsFromGmail,
} from '../lib/senderIdentity';
import { COMPANY_DOMAIN, isCompanyEmail } from '../lib/accessPolicy';
import { createError } from '../middleware/error';
import { composeDraftHtml, encodeHeaderValue, escapeHtml, isRfcMessageId, sanitizeReferences, stripHeaderBreaks } from '../lib/draftBody';
import { normalizeEmail, resolveCandidateStatus, shouldSkipNotRecruiting, LOW_CONFIDENCE_THRESHOLD } from '../lib/candidateState';
import { loopInSentence } from '../lib/handoffLoopIn';
import { ccFirstName, resolveDraftCc, NO_CC } from './draftCc.service';
import type { Mailbox, EmailThread, Prisma } from '@prisma/client';
import { LIVE_DRAFT_STATUSES, CANCELABLE_DRAFT_STATUSES } from '../lib/draftStatus';

/**
 * Serialize an OAuth2 / service-account credentials object for storage.
 * Encrypts at rest with AES-256-GCM (see ../lib/crypto).
 */
export function serializeCredentials(creds: Record<string, unknown>): string {
  return encrypt(JSON.stringify(creds));
}

/**
 * Decrypt a mailbox's stored credentials. Throws when they can't be decrypted
 * or parsed (audit B6 / L9) — the old plaintext-JSON fallback is gone (all
 * prod rows were verified encrypted) and a broken row now surfaces as an error
 * instead of an empty credential set. The message never includes the payload.
 */
export function parseCredentials(mailbox: Mailbox): Record<string, unknown> {
  const raw = mailbox.credentials;
  if (typeof raw !== 'string' || raw.length === 0) {
    return {};
  }

  let plaintext: string;
  try {
    plaintext = decrypt(raw);
  } catch (err) {
    throw new Error(
      `[Gmail] Failed to decrypt credentials for mailbox ${mailbox.id}: ` +
        (err instanceof Error ? err.message : 'unknown error')
    );
  }
  try {
    return JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new Error(`[Gmail] Decrypted credentials for mailbox ${mailbox.id} are not valid JSON`);
  }
}

function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );
}

function getAuthenticatedClient(credentials: Record<string, unknown>): OAuth2Client {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(credentials);
  return oauth2Client;
}

/**
 * Return an authenticated Gmail client for any mailbox, handling both
 * OAuth mailboxes (personal) and service-account DWD mailboxes (workspace).
 *
 * OAuth mailboxes get their access token resolved up front (a no-op when the
 * stored one is still valid) so a revoked refresh token surfaces here as
 * invalid_grant: the mailbox is flipped to NEEDS_REAUTH and every caller gets
 * a MailboxNeedsReauthError. Mailboxes already in NEEDS_REAUTH fail fast
 * without calling Google until a human reconnects them.
 */
async function getGmailClient(mailbox: Mailbox): Promise<ReturnType<typeof google.gmail>> {
  if (mailbox.authStatus === AUTH_STATUS_NEEDS_REAUTH) {
    throw new MailboxNeedsReauthError(mailbox.emailAddress);
  }
  const credentials = parseCredentials(mailbox);
  if (credentials.type === 'service_account') {
    return createServiceAccountClient(mailbox.emailAddress);
  }
  const auth = getAuthenticatedClient(credentials);
  try {
    await auth.getAccessToken();
  } catch (err) {
    if (isAuthRevokedError(err)) {
      await markMailboxNeedsReauth(mailbox, err, 'getGmailClient');
      throw new MailboxNeedsReauthError(mailbox.emailAddress);
    }
    throw err;
  }
  return google.gmail({ version: 'v1', auth });
}

export function getAuthUrl(state: string): string {
  const oauth2Client = createOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    // Needed so we can fetch the connected user's real display name
    // (e.g. "Ethan Maenza") and store it on Mailbox.displayName. Phase J
    // derives the draft signing persona from this field.
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    // Needed to read Gmail send-as signatures for handoff draft templates.
    'https://www.googleapis.com/auth/gmail.settings.basic',
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state,
    prompt: 'consent',
  });
}

/**
 * Fetch the OAuth user's profile (name, email, picture) via the userinfo
 * endpoint. Requires the userinfo.profile scope. Returns null if the call
 * fails (e.g. user granted older scopes without userinfo.profile).
 */
export async function fetchUserInfo(
  oauth2Client: OAuth2Client
): Promise<{ name?: string; email?: string; picture?: string; givenName?: string } | null> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const res = await oauth2.userinfo.get();
    return {
      name: res.data.name ?? undefined,
      email: res.data.email ?? undefined,
      picture: res.data.picture ?? undefined,
      givenName: res.data.given_name ?? undefined,
    };
  } catch (err) {
    console.warn('[Gmail] userinfo.get failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function handleCallback(
  code: string,
  opts: { actorUserId: string | null } = { actorUserId: null }
): Promise<Mailbox> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const emailAddress = (profile.data.emailAddress ?? '').toLowerCase();
  // L6: only company Workspace mailboxes may be connected. Checked before any
  // DB read/write so a personal account's tokens are never stored.
  if (!isCompanyEmail(emailAddress)) {
    throw createError(`Only @${COMPANY_DOMAIN} mailboxes can be connected`, 403);
  }
  // Baseline historyId so the first incremental sync isn't empty.
  const baselineHistoryId = profile.data.historyId ?? null;

  // Pull the real display name (e.g. "Ethan Maenza") via userinfo. Falls back
  // to the email if the scope wasn't granted or the call fails.
  const userInfo = await fetchUserInfo(oauth2Client);
  const resolvedDisplayName =
    userInfo?.name && userInfo.name.trim().length > 0 ? userInfo.name.trim() : emailAddress;

  const encryptedCreds = serializeCredentials(tokens as Record<string, unknown>);

  // Decide whether this is a fresh connect or a credential refresh. Refresh is
  // when the row already exists, isActive, AND has a live Gmail watch — in
  // that case the prior baseline is still meaningful and a backfill may be
  // in flight, so overwriting lastHistoryId would lose messages between the
  // old baseline and now. Only reset baseline on a genuinely-new connect.
  const existing = await prisma.mailbox.findUnique({ where: { emailAddress } });
  const wasNeedsReauth = existing?.authStatus === AUTH_STATUS_NEEDS_REAUTH;

  // L6: isActive=false is only ever set by the admin-only DELETE route, so a
  // disabled mailbox stays disabled unless an admin reconnects it.
  const actor = opts.actorUserId
    ? await prisma.user.findUnique({ where: { id: opts.actorUserId }, select: { role: true } })
    : null;
  if (existing && !existing.isActive && actor?.role !== 'admin') {
    throw createError(
      'This mailbox was disconnected by an admin; ask an admin to reconnect it',
      403
    );
  }

  const isRefresh =
    !!existing &&
    existing.isActive &&
    !!existing.watchExpiry &&
    existing.watchExpiry.getTime() > Date.now();

  const mailbox = await prisma.mailbox.upsert({
    where: { emailAddress },
    update: {
      credentials: encryptedCreds,
      displayName: resolvedDisplayName,
      isActive: true,
      // Fresh OAuth tokens: the grant is healthy again.
      authStatus: AUTH_STATUS_OK,
      lastAuthError: null,
      lastAuthErrorAt: null,
      // Preserve baseline on refresh; reset only on a fresh (re)connect.
      ...(isRefresh ? {} : { lastHistoryId: baselineHistoryId }),
      updatedAt: new Date(),
    },
    create: {
      provider: 'GMAIL',
      emailAddress,
      displayName: resolvedDisplayName,
      credentials: encryptedCreds,
      lastHistoryId: baselineHistoryId,
      isActive: true,
    },
  });

  await logEvent(
    'MAILBOX_CONNECTED',
    {
      mailboxId: mailbox.id,
      emailAddress,
      displayName: resolvedDisplayName,
      mode: isRefresh ? 'refresh' : 'fresh',
      actorUserId: opts.actorUserId,
    },
    'INFO'
  );
  if (wasNeedsReauth) {
    await logEvent(
      'MAILBOX_AUTH_RESTORED',
      { mailboxId: mailbox.id, emailAddress, previousError: existing?.lastAuthError ?? null },
      'INFO'
    );
  }
  return mailbox;
}

// Domains and patterns that are obviously not candidate emails. Skips Claude
// classification to save tokens. When unsure we let Claude decide.
const SENDER_DOMAIN_BLACKLIST = new Set([
  'notifications.github.com',
  'github.com',
  'vercel.com',
  'noreply.github.com',
  'zoom.us',
  'docusign.com',
  'docusign.net',
  'pandadoc.net',
  'mailchimp.com',
  'beehiiv.com',
  'mail.beehiiv.com',
  'mercury.com',
  'posthog.com',
  'intercom-mail.com',
  'slack.com',
  'mailgun.org',
  'sendgrid.net',
  'amazonses.com',
  'linkedin.com',
  'e.linkedin.com',
  'em.linkedin.com',
  'calendar-notification.google.com',
  'group.calendar.google.com',
]);

export function shouldSkipClassification(opts: {
  fromAddress: string;
  fromName?: string | null;
  subject: string;
  mailboxEmail: string;
  /** Mailbox.sendAsAddresses — aliases are the mailbox's own outbound. */
  mailboxAliases?: string[];
}): boolean {
  const from = opts.fromAddress.toLowerCase().trim();
  const name = (opts.fromName ?? '').toLowerCase();
  const subject = opts.subject.toLowerCase();

  if (!from) return true;
  // outbound (primary address or any sendAs alias)
  if (isMailboxOwnAddress({ emailAddress: opts.mailboxEmail, sendAsAddresses: opts.mailboxAliases }, from)) {
    return true;
  }
  // Colleagues (incl. unconnected executive send-aliases) are never candidates.
  if (isInternalAddress(from, config.internalDomains)) return true;

  const domain = from.split('@')[1] ?? '';
  if (!domain) return true;
  if (SENDER_DOMAIN_BLACKLIST.has(domain)) return true;

  // Common newsletter / no-reply patterns
  if (from.startsWith('no-reply@') || from.startsWith('noreply@') || from.startsWith('do-not-reply@')) {
    return true;
  }
  if (name.includes('no reply') || name.includes('no-reply') || name.includes('notifications')) {
    return true;
  }
  if (subject.startsWith('[') && subject.includes(']')) {
    // ticketed/automated subjects like "[team-account] ..." or "[GitHub] ..."
    return true;
  }
  return false;
}

interface ParsedGmailMessage {
  externalMessageId: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
  bodyText: string;
  bodyHtml: string;
  receivedAt: Date;
  headers: {
    messageId: string;
    inReplyTo: string;
    references: string;
    cc: string;
  };
}

export function parseGmailMessage(
  msgId: string,
  fullMsgData: {
    threadId?: string | null;
    internalDate?: string | null;
    payload?: {
      headers?: Array<{ name?: string | null; value?: string | null }> | null;
      mimeType?: string | null;
      body?: { data?: string | null } | null;
      parts?: unknown[] | null;
    } | null;
  }
): ParsedGmailMessage {
  const headers = fullMsgData.payload?.headers ?? [];
  const getHeader = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const subject = getHeader('Subject') || '(no subject)';
  const fromRaw = getHeader('From');
  const toRaw = getHeader('To');
  const ccRaw = getHeader('Cc');
  const messageId = getHeader('Message-ID');
  const inReplyTo = getHeader('In-Reply-To');
  const references = getHeader('References');
  const dateStr = getHeader('Date');
  const threadId = fullMsgData.threadId ?? msgId;

  const fromMatch = fromRaw.match(/^(.*?)\s*<([^>]+)>$/) ?? [];
  const fromName = fromMatch[1]?.trim().replace(/^"|"$/g, '') || undefined;
  // Lowercased so Candidate.email matching is case-insensitive (M12).
  const fromAddress = normalizeEmail(fromMatch[2] ?? fromRaw);

  const toAddresses = toRaw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  let bodyText = '';
  let bodyHtml = '';

  const extractBody = (part: {
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: unknown[] | null;
  }): void => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (part.parts) {
      (part.parts as Parameters<typeof extractBody>[0][]).forEach(extractBody);
    }
  };

  if (fullMsgData.payload) {
    extractBody(fullMsgData.payload as Parameters<typeof extractBody>[0]);
  }

  return {
    externalMessageId: msgId,
    threadId,
    subject,
    fromAddress,
    fromName,
    toAddresses,
    bodyText,
    bodyHtml,
    // Prefer Gmail's authoritative internalDate (epoch ms, always present) over
    // the Date: header which can be spoofed, missing, or malformed. A bad Date:
    // header would default to new Date() (now), causing priorInbound checks to
    // incorrectly find all past messages as "before" an outbound, setting
    // repliedAt when no reply was sent.
    receivedAt: (() => {
      if (fullMsgData.internalDate) {
        const ms = parseInt(fullMsgData.internalDate, 10);
        if (!isNaN(ms)) return new Date(ms);
      }
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
      }
      return new Date();
    })(),
    headers: { messageId, inReplyTo, references, cc: ccRaw },
  };
}

/**
 * Draft generation metadata as EmailDraft columns (M14). Template fallbacks
 * have no meta and store nulls.
 */
export function draftMetaColumns(meta: DraftGenerationMeta | undefined | null): {
  model: string | null;
  promptVersion: string | null;
  usage: Prisma.InputJsonValue | undefined;
} {
  return {
    model: meta?.model ?? null,
    promptVersion: meta?.promptVersion ?? null,
    usage: meta?.usage ? (meta.usage as unknown as Prisma.InputJsonValue) : undefined,
  };
}

/**
 * Candidate row for an address, matched case-insensitively so rows written
 * before emails were lowercased (M12) are still found until the backfill runs.
 */
export async function findCandidateByEmail(email: string) {
  return prisma.candidate.findFirst({
    where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Move Candidate.lastOutboundAt forward to `at`, never backward: messages
 * are processed out of order by reconcile / resync / webhooks.
 */
async function advanceLastOutboundAt(candidateId: string, at: Date): Promise<void> {
  await prisma.candidate.updateMany({
    where: { id: candidateId, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: at } }] },
    data: { lastOutboundAt: at },
  });
}

// Thread-context window for the classifier. We send the first N (the original
// sourcing email + earliest replies, which carry intent) plus the last N
// (the most recent activity) so Claude sees the conversation arc instead of a
// recency-biased slice. Dedup if the thread is shorter than the sum.
const THREAD_CONTEXT_HEAD = 4;
const THREAD_CONTEXT_TAIL = 4;

/**
 * Pick the first HEAD and last TAIL messages from a chronologically-sorted
 * (oldest → newest) array, deduplicating any overlap. Returns messages in
 * chronological order. Used for the classifier prompt context.
 */
export function pickHeadTail<T>(messagesAsc: T[], head: number, tail: number): T[] {
  if (messagesAsc.length <= head + tail) return messagesAsc;
  const headSlice = messagesAsc.slice(0, head);
  const tailSlice = messagesAsc.slice(-tail);
  return [...headSlice, ...tailSlice];
}

/**
 * Classify a newly-stored inbound message and create/update the associated
 * Candidate. If INTERESTED, also generate a draft reply.
 *
 * Errors are swallowed (logged) so a bad message can't kill the rest of the
 * sync. The message itself is always already saved before this is called.
 */
/**
 * The draft that should stop classifyAndDraft from creating another one on
 * this thread, if any. A live (PENDING/APPROVED) draft always blocks. On a
 * hand-off inbox a SENT draft blocks too: once the candidate has been looped
 * in to the CC recipient, their next reply-all must not produce a second
 * "looping in Sofia" draft (M23).
 */
export async function findBlockingDraft(
  threadId: string,
  isHandoffInbox: boolean
): Promise<{ id: string; status: string } | null> {
  const statuses: string[] = isHandoffInbox ? [...LIVE_DRAFT_STATUSES, 'SENT'] : [...LIVE_DRAFT_STATUSES];
  return prisma.emailDraft.findFirst({
    where: { threadId, status: { in: statuses } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function classifyAndDraft(opts: {
  mailbox: Mailbox;
  thread: EmailThread;
  parsed: ParsedGmailMessage;
}): Promise<void> {
  const { mailbox, thread, parsed } = opts;

  if (
    shouldSkipClassification({
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      subject: parsed.subject,
      mailboxEmail: mailbox.emailAddress,
      mailboxAliases: mailbox.sendAsAddresses,
    })
  ) {
    return;
  }

  // If the recruiter has explicitly ignored this candidate, the message is
  // already stored (we don't want to drop data) but we skip classification
  // and draft generation entirely. Equivalent to muting the sender.
  const existingCandidate = await findCandidateByEmail(parsed.fromAddress);
  if (existingCandidate?.status === 'IGNORED') {
    await logEvent(
      'MESSAGE_FROM_IGNORED_CANDIDATE',
      {
        mailboxId: mailbox.id,
        candidateId: existingCandidate.id,
        messageId: parsed.externalMessageId,
        // Intentionally omit fromAddress — that's candidate.email PII;
        // candidateId is the queryable id.
      },
      'INFO'
    );
    return;
  }

  // Pull every prior message in this thread (ordered oldest → newest) so we
  // can both (a) feed thread context into the classifier and (b) reuse the
  // list as the draft-generation history below.
  const allMessages = await prisma.emailMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { receivedAt: 'asc' },
  });

  // Previous messages = everything except the one we're classifying right now.
  // Take first 4 + last 4 (deduped if the thread is shorter) so Claude sees
  // both the conversation's origin (sourcing email, early replies) and the
  // most recent activity, rather than a purely-recent slice.
  const priorAsc = allMessages.filter(
    (m) => m.externalMessageId !== parsed.externalMessageId
  );
  const previousMessages = pickHeadTail(
    priorAsc,
    THREAD_CONTEXT_HEAD,
    THREAD_CONTEXT_TAIL
  ).map((m) => ({
    fromAddress: m.fromAddress,
    fromName: m.fromName,
    // Fall back through bodyHtml then a sentinel so Claude always gets
    // *some* text per message. A null/empty entry in the context array
    // poisons the classifier prompt.
    bodyText: m.bodyText || m.bodyHtml || `(no body, subject: ${m.subject ?? thread.subject})`,
    receivedAt: m.receivedAt,
  }));

  // Existing draft check happens BEFORE we burn Claude tokens — if there is
  // already a PENDING/APPROVED draft on this thread, we just log + bail.
  const isHandoffInbox =
    mailbox.emailAddress.toLowerCase() !== config.draftCcEmail.toLowerCase();
  const existingDraft = await findBlockingDraft(thread.id, isHandoffInbox);

  let classificationResult;
  try {
    const candidateName = parsed.fromName ?? parsed.fromAddress;
    // Three-step fallback with explicit empty-body sentinel. An empty
    // string would let Claude classify "no message" as NEUTRAL with high
    // confidence — wrong. The sentinel tells the model the body was empty.
    const primaryBody =
      parsed.bodyText ||
      parsed.bodyHtml ||
      parsed.subject ||
      '(empty inbound message body)';
    classificationResult = await classifyReply(
      primaryBody,
      candidateName,
      {
        subject: thread.subject,
        previousMessages,
      }
    );
  } catch (err) {
    // classifyReply is now fail-safe and shouldn't throw, but belt-and-braces:
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(
      'CLASSIFICATION_FAILED',
      { mailboxId: mailbox.id, messageId: parsed.externalMessageId, error: message },
      'WARN'
    );
    return;
  }

  const { classification, messageType, confidence, role } = classificationResult;
  let { needsReview } = classificationResult;

  // A thread the mailbox wrote on (outreach), one already linked to a
  // candidate, or mail from a known candidate is never dropped as noise (M15).
  const recruitingContext = {
    threadHasOutboundFromMailbox: allMessages.some((m) => isMailboxOwnAddress(mailbox, m.fromAddress)),
    threadLinkedToCandidate: !!thread.candidateId,
    knownCandidate: !!existingCandidate,
  };
  const inRecruitingContext =
    recruitingContext.threadHasOutboundFromMailbox ||
    recruitingContext.threadLinkedToCandidate ||
    recruitingContext.knownCandidate;

  // ---- Routing decisions ----------------------------------------------------
  // NO ROLE DETECTED: route to NEEDS_REVIEW so a recruiter can assign the role
  // manually. Previously this was a hard skip, but that silently lost replies
  // to vague outreach templates that never named a job title (e.g. "adding to
  // our marketing team"). A human always gets a chance to review before we act.
  // NOT_RECRUITING_RELATED messages still get their own gate below.
  if (role === null && messageType !== 'NOT_RECRUITING_RELATED' && !inRecruitingContext) {
    await logEvent(
      'MESSAGE_SKIPPED_NO_ROLE',
      { mailboxId: mailbox.id, messageId: parsed.externalMessageId, messageType, confidence },
      'INFO'
    );
    needsReview = true;
  }

  // NOT_RECRUITING_RELATED: don't pollute the candidate table, but only when
  // the classifier is sure and nothing ties the thread to recruiting (M15).
  // Otherwise a human reviews it.
  if (messageType === 'NOT_RECRUITING_RELATED' && !shouldSkipNotRecruiting({ confidence, ...recruitingContext })) {
    needsReview = true;
    await logEvent(
      'NOT_RECRUITING_ROUTED_TO_REVIEW',
      { mailboxId: mailbox.id, messageId: parsed.externalMessageId, confidence, ...recruitingContext },
      'INFO'
    );
  } else if (messageType === 'NOT_RECRUITING_RELATED') {
    await logEvent(
      'MESSAGE_SKIPPED_NOT_RECRUITING',
      {
        mailboxId: mailbox.id,
        messageId: parsed.externalMessageId,
        // Intentionally omit fromAddress — it's the candidate's email
        // (effectively candidate.email pre-creation). messageId + mailboxId
        // is enough to reconstruct the message if a recruiter needs to look.
        confidence,
      },
      'INFO'
    );
    return;
  }

  const lowConfidence = confidence < LOW_CONFIDENCE_THRESHOLD;
  // The candidate-level status we want to write. NEEDS_REVIEW for any low-trust
  // signal so a human looks before we auto-draft.
  const desiredStatus =
    needsReview || lowConfidence ? 'NEEDS_REVIEW' : classification;

  // Transition rules (no downgrade on logistics replies, confident declines
  // win, NEEDS_REVIEW clears) live in lib/candidateState (H6).
  const finalStatus = resolveCandidateStatus(existingCandidate?.status ?? null, desiredStatus, confidence);

  // Conversation state: the candidate's latest message (only moves forward).
  const lastInboundAt =
    existingCandidate?.lastInboundAt && existingCandidate.lastInboundAt > parsed.receivedAt
      ? existingCandidate.lastInboundAt
      : parsed.receivedAt;

  // Only overwrite role on existing candidates when we have a new value and
  // the row didn't already have one — avoids churning a manually-edited or
  // earlier-detected role on every follow-up reply.
  const shouldSetRoleOnUpdate =
    role !== null && existingCandidate && !existingCandidate.role;

  const candidate = await prisma.candidate.upsert({
    // The existing row's own spelling, so a not-yet-lowercased row is updated
    // rather than duplicated (M12).
    where: { email: existingCandidate?.email ?? parsed.fromAddress },
    update: {
      status: finalStatus,
      mailboxId: mailbox.id,
      lastInboundAt,
      updatedAt: new Date(),
      ...(shouldSetRoleOnUpdate ? { role } : {}),
    },
    create: {
      name: parsed.fromName ?? parsed.fromAddress,
      email: parsed.fromAddress,
      status: finalStatus,
      mailboxId: mailbox.id,
      firstMailboxId: mailbox.id,
      lastInboundAt,
      source: 'EMAIL_REPLY',
      role: role ?? null,
    },
  });

  // New candidate: check Lever now (background) instead of waiting for the
  // lever-sync crons, so the badge is right within seconds (H2).
  if (!existingCandidate) scheduleLeverRefresh(candidate.id, 'created');
  // ...and look them up in Gem, so Add to Lever opens with LinkedIn, title
  // and location already cached (H5). Skipped when nobody has Gem connected.
  if (!existingCandidate) scheduleGemEnrichment(candidate.id, 'created', { mailboxEmail: mailbox.emailAddress });

  if (role && (!existingCandidate || !existingCandidate.role)) {
    await logEvent(
      'CANDIDATE_ROLE_DETECTED',
      {
        mailboxId: mailbox.id,
        candidateId: candidate.id,
        role,
      },
      'INFO'
    );
  }

  // Attach the thread to the candidate if not already attached
  if (thread.candidateId !== candidate.id) {
    await prisma.emailThread.update({
      where: { id: thread.id },
      data: { candidateId: candidate.id },
    });
  }

  await logEvent(
    'CANDIDATE_CLASSIFIED',
    {
      mailboxId: mailbox.id,
      candidateId: candidate.id,
      classification,
      messageType,
      needsReview,
      confidence,
      finalStatus,
    },
    'INFO'
  );

  // ---- Draft skip checks ----------------------------------------------------
  // 1. Dedup: thread already has a live draft (PENDING or APPROVED).
  if (existingDraft) {
    await logEvent(
      'DRAFT_SKIPPED_DUPLICATE',
      {
        mailboxId: mailbox.id,
        candidateId: candidate.id,
        threadId: thread.id,
        existingDraftId: existingDraft.id,
        existingStatus: existingDraft.status,
      },
      'INFO'
    );
    return;
  }

  // 2. needsReview = true → human should look first.
  if (needsReview) {
    await logEvent(
      'DRAFT_SKIPPED_NEEDS_REVIEW',
      {
        mailboxId: mailbox.id,
        candidateId: candidate.id,
        threadId: thread.id,
        messageType,
        confidence,
      },
      'INFO'
    );
    return;
  }

  // 3. Confidence below threshold → human should look first.
  if (lowConfidence) {
    await logEvent(
      'DRAFT_SKIPPED_LOW_CONFIDENCE',
      {
        mailboxId: mailbox.id,
        candidateId: candidate.id,
        threadId: thread.id,
        confidence,
      },
      'INFO'
    );
    return;
  }

  // 4. OUT_OF_OFFICE auto-replies: candidate recorded, no draft.
  if (messageType === 'OUT_OF_OFFICE') {
    await logEvent(
      'DRAFT_SKIPPED_OUT_OF_OFFICE',
      { mailboxId: mailbox.id, candidateId: candidate.id, threadId: thread.id },
      'INFO'
    );
    return;
  }

  // 5. Only auto-draft for INTERESTED candidates.
  if (classification !== 'INTERESTED') return;


  // 6. For non-Sofia inboxes, use Claude to generate a tailored handoff reply
  //    that addresses anything specific the candidate said, then loops in Sofia.
  if (isHandoffInbox) {
    const signatureHtml = await fetchMailboxSignature(mailbox.id);
    const inReplyToMessageId = parsed.headers.messageId || null;
    const existingRefs = parsed.headers.references ?? '';
    const referencesHeader = existingRefs
      ? `${existingRefs} ${inReplyToMessageId ?? ''}`.trim()
      : inReplyToMessageId;

    const content = await composeHandoffDraftContent({
      mailbox,
      candidateName: candidate.name,
      candidateRole: candidate.role ?? null,
      threadId: thread.id,
      threadSubject: thread.subject,
      messages: allMessages,
      classification,
      signatureHtml,
      via: 'auto',
    });

    const createdHandoff = await createLiveDraft(
      {
        threadId: thread.id,
        inReplyToMessageId,
        referencesHeader,
        subject: content.subject,
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml,
        aiBodyText: content.bodyText,
        classification,
        confidence,
        classificationReason: classificationResult.reason ?? null,
        evidenceQuote: classificationResult.evidenceQuote ?? null,
        status: 'PENDING',
        ccEmail: draftCcAddressFor(mailbox.emailAddress) ?? NO_CC,
        ...draftMetaColumns(content.meta),
      },
      { mailboxId: mailbox.id, candidateId: candidate.id, threadId: thread.id }
    );
    if (!createdHandoff) return;

    await logEvent(
      'DRAFT_CREATED',
      { mailboxId: mailbox.id, candidateId: candidate.id, threadId: thread.id, messageType, confidence, via: content.template },
      'INFO'
    );
    return;
  }

  // 8. Sofia's inbox: use Claude with style examples, then append the mailbox signature.
  try {
    const [examples, signatureHtml] = await Promise.all([
      fetchExamplesForMailbox(mailbox.id, mailbox.emailAddress, classification),
      fetchMailboxSignature(mailbox.id),
    ]);
    const draftReply = await generateDraftReply(
      {
        subject: thread.subject,
        messages: allMessages.map((m) => ({
          fromAddress: m.fromAddress,
          fromName: m.fromName,
          bodyText: m.bodyText,
          receivedAt: m.receivedAt,
        })),
        candidateName: candidate.name,
        classification,
        examples,
        signatureHtml,
      },
      // Ghostwrite the draft as the mailbox owner (Paul / Em / etc.), not as a
      // fixed company-wide persona. Sofia is the CC recipient (Phase I), not
      // the sender persona.
      {
        email: mailbox.emailAddress,
        displayName: mailbox.displayName,
      }
    );

    // Append the real Gmail signature if we fetched one successfully.
    if (signatureHtml) {
      draftReply.bodyText = `${draftReply.bodyText}\n${htmlSignatureToPlainText(signatureHtml)}`;
      draftReply.bodyHtml = `${draftReply.bodyHtml ?? ''}${signatureHtml}`;
    }

    const inReplyToMessageId = parsed.headers.messageId || null;
    const existingRefs = parsed.headers.references ?? '';
    const referencesHeader = existingRefs
      ? `${existingRefs} ${inReplyToMessageId ?? ''}`.trim()
      : inReplyToMessageId;

    const created = await createLiveDraft(
      {
        threadId: thread.id,
        inReplyToMessageId,
        referencesHeader,
        subject: draftReply.subject,
        bodyText: draftReply.bodyText,
        bodyHtml: draftReply.bodyHtml,
        aiBodyText: draftReply.bodyText,
        classification,
        confidence,
        classificationReason: classificationResult.reason ?? null,
        evidenceQuote: classificationResult.evidenceQuote ?? null,
        status: 'PENDING',
        ccEmail: draftCcAddressFor(mailbox.emailAddress) ?? NO_CC,
        ...draftMetaColumns(draftReply.meta),
      },
      { mailboxId: mailbox.id, candidateId: candidate.id, threadId: thread.id }
    );
    if (!created) return;

    await logEvent(
      'DRAFT_CREATED',
      {
        mailboxId: mailbox.id,
        candidateId: candidate.id,
        threadId: thread.id,
        messageType,
        confidence,
      },
      'INFO'
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(
      'DRAFT_GENERATION_FAILED',
      { mailboxId: mailbox.id, threadId: thread.id, error: message },
      'WARN'
    );
  }
}

/**
 * Candidate-side effects of a message the mailbox sent: advance
 * lastOutboundAt, and when it answers a candidate message, set repliedAt and
 * supersede any live drafts on the thread (the recruiter replied by hand).
 */
export async function recordOutboundMessage(
  mailbox: Pick<Mailbox, 'id' | 'emailAddress'> & { sendAsAddresses?: string[] | null },
  thread: Pick<EmailThread, 'id' | 'candidateId'>,
  receivedAt: Date
): Promise<void> {
  if (thread.candidateId) {
    // Conversation state (H6): any recruiter message puts the ball in the
    // candidate's court.
    await advanceLastOutboundAt(thread.candidateId, receivedAt);

    // Only count this as a recruiter reply if the candidate already sent
    // at least one inbound message before this outbound message.
    // Without this check, the original outreach email would set repliedAt
    // and mark the candidate as "Replied" before they've said anything.
    // "Inbound" = not from this mailbox (primary or alias) and not from
    // a colleague on an internal domain.
    const priorInbound = await prisma.emailMessage.findFirst({
      where: {
        threadId: thread.id,
        receivedAt: { lt: receivedAt },
        AND: [
          ...mailboxOwnAddresses(mailbox).map((addr) => ({
            NOT: { fromAddress: { equals: addr, mode: 'insensitive' as const } },
          })),
          ...config.internalDomains.map((domain) => ({
            NOT: { fromAddress: { endsWith: `@${domain}`, mode: 'insensitive' as const } },
          })),
        ],
      },
    });

    if (priorInbound) {
      await prisma.candidate.update({
        where: { id: thread.candidateId },
        data: { repliedAt: receivedAt },
      });

      // Discard any cancelable live drafts on this thread (incl. a SCHEDULED
      // one-step send) — they're now stale because the recruiter already sent
      // a manual reply. An in-flight SENDING draft is left to finish.
      const superseded = await prisma.emailDraft.updateMany({
        where: {
          threadId: thread.id,
          status: { in: CANCELABLE_DRAFT_STATUSES },
        },
        data: { status: 'DISCARDED' },
      });
      // Implicit discards were unlogged, hiding ~all real discards (M14).
      if (superseded.count > 0) {
        await logEvent(
          'DRAFT_SUPERSEDED',
          { mailboxId: mailbox.id, threadId: thread.id, candidateId: thread.candidateId, reason: 'manual_reply', count: superseded.count },
          'INFO'
        );
      }
    }
  }
}

// Fetch a single message by Gmail message ID and persist it (idempotent — skips
// messages already stored). Used by both the 7-day fallback sync and the
// incremental history-based sync.
//
// After persisting, classifies inbound messages (calls classifyAndDraft) and
// for outbound messages from the mailbox owner sets Candidate.repliedAt so the
// dashboard can show reply status when the recruiter replies via Gmail or
// Superhuman directly.
//
// Outcome of one fetchAndStoreMessage call:
//   stored    — new row written (classification may have failed; the row's
//               processingState records that and the sweeper retries it)
//   exists    — already stored (pre-check, or lost a P2002 race)
//   gone      — Gmail 404 (deleted, or a draft that was sent/discarded);
//               tombstoned so reconcile skips it for 48h
//   failed    — fetch/store error; retry worthwhile (syncIncremental holds
//               its history cursor for these)
//   abandoned — failed MAX_FETCH_ATTEMPTS times; stop holding the cursor
export type StoreOutcome = 'stored' | 'exists' | 'gone' | 'failed' | 'abandoned';

export const MAX_FETCH_ATTEMPTS = 3;
const TOMBSTONE_TTL_MS = 48 * 60 * 60 * 1000;

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

function isGmailNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return (e?.code ?? e?.status ?? e?.response?.status) === 404;
}

async function recordFetchTombstone(
  mailboxId: string,
  externalMessageId: string,
  reason: 'NOT_FOUND' | 'FAILED',
  error: string
): Promise<number> {
  try {
    const row = await prisma.gmailFetchTombstone.upsert({
      where: { mailboxId_externalMessageId: { mailboxId, externalMessageId } },
      update: { reason, lastError: error.slice(0, 500), attempts: { increment: 1 } },
      create: { mailboxId, externalMessageId, reason, lastError: error.slice(0, 500) },
    });
    return row.attempts;
  } catch (err) {
    console.warn(`[Gmail] Failed to record tombstone for ${externalMessageId}:`, safeError(err));
    return 1;
  }
}

// Insert a live (PENDING) draft. The partial unique index
// EmailDraft_threadId_live_key (migration 9) rejects a second live draft on a
// thread, which happens when two messages on one thread are classified
// concurrently (webhook + reconcile) — both pass the existingDraft check
// before either inserts. Losing that race is not an error.
async function createLiveDraft(
  data: Parameters<typeof prisma.emailDraft.create>[0]['data'],
  log: { mailboxId: string; candidateId: string; threadId: string }
): Promise<boolean> {
  try {
    await prisma.emailDraft.create({ data });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await logEvent('DRAFT_SKIPPED_DUPLICATE', { ...log, race: true }, 'INFO');
    return false;
  }
}

/**
 * True when the sender and every To/Cc recipient are on an internal domain
 * (config.internalDomains; audit B6 / H8). Such mail on a thread with no candidate is internal
 * correspondence: it is stored as metadata only and never sent to Claude.
 * Recipient entries may be raw header fragments (`"Doe, Jane" <j@x>` split on
 * commas), so fragments without an address are ignored.
 */
export function isInternalOnlyMessage(msg: {
  fromAddress: string;
  toAddresses: string[];
  headers: { cc: string };
}): boolean {
  const isInternal = (addr: string) => isInternalAddress(addr, config.internalDomains);
  if (!isInternal(msg.fromAddress)) return false;
  const recipients = [...msg.toAddresses, msg.headers.cc]
    .flatMap((entry) => entry.split(','))
    .map((frag) => {
      const angle = frag.match(/<([^>]+)>/);
      return (angle ? angle[1] : frag).trim().toLowerCase();
    })
    .filter((addr) => addr.includes('@'));
  return recipients.every(isInternal);
}

/**
 * Drop the body of a just-classified message if its thread is still not
 * linked to a candidate (H8): the message was judged non-recruiting, spam,
 * no-role, or from an ignored sender. Subject/sender/headers are kept so
 * threading and audit still work.
 */
async function scrubBodyIfUnlinked(threadId: string, externalMessageId: string): Promise<void> {
  // One conditional write: only matches while the thread is still unlinked,
  // so a concurrent classification that links it keeps the body.
  await prisma.emailMessage.updateMany({
    where: { externalMessageId, threadId, thread: { candidateId: null } },
    data: { bodyText: null, bodyHtml: null },
  });
}

/** @internal exported for tests */
export async function fetchAndStoreMessage(
  gmail: ReturnType<typeof google.gmail>,
  mailbox: Mailbox,
  externalMessageId: string,
  opts: { skipClassification?: boolean; classifyCutoff?: Date } = {}
): Promise<StoreOutcome> {
  // Skip if already stored
  const existing = await prisma.emailMessage.findUnique({
    where: { externalMessageId },
  });
  if (existing) return 'exists';

  let storedMessageId: string | null = null;
  try {
    let fullMsg;
    try {
      fullMsg = await gmail.users.messages.get({
        userId: 'me',
        id: externalMessageId,
        format: 'full',
      });
    } catch (err) {
      if (!isGmailNotFound(err)) throw err;
      await recordFetchTombstone(mailbox.id, externalMessageId, 'NOT_FOUND', 'not found');
      await logEvent(
        'MESSAGE_FETCH_NOT_FOUND',
        { mailboxId: mailbox.id, messageId: externalMessageId },
        'INFO'
      );
      return 'gone';
    }

    const parsed = parseGmailMessage(externalMessageId, fullMsg.data);
    // Primary address or any stored sendAs alias (audit M11).
    const isOutbound = isMailboxOwnAddress(mailbox, parsed.fromAddress);

    // Upsert thread. lastMessageAt/subject only ever move forward (M24):
    // messages arrive out of order across webhook / reconcile / resync, so the
    // update is a conditional updateMany rather than an unconditional write.
    const thread = await prisma.emailThread.upsert({
      where: {
        mailboxId_externalThreadId: {
          mailboxId: mailbox.id,
          externalThreadId: parsed.threadId,
        },
      },
      update: {},
      create: {
        mailboxId: mailbox.id,
        externalThreadId: parsed.threadId,
        subject: parsed.subject,
        lastMessageAt: parsed.receivedAt,
      },
    });
    if (thread.lastMessageAt < parsed.receivedAt) {
      await prisma.emailThread.updateMany({
        where: { id: thread.id, lastMessageAt: { lt: parsed.receivedAt } },
        data: { subject: parsed.subject, lastMessageAt: parsed.receivedAt },
      });
    }

    // H8: internal-only mail on a thread with no candidate is stored as
    // metadata only and skips classification.
    const metadataOnly = !thread.candidateId && isInternalOnlyMessage(parsed);

    const tooOld = opts.classifyCutoff && parsed.receivedAt < opts.classifyCutoff;
    const willClassify = !isOutbound && !metadataOnly && !opts.skipClassification && !tooOld;

    // Store message. A P2002 here means a concurrent run (webhook vs
    // reconcile) stored it between our pre-check and now — that's success.
    try {
      const created = await prisma.emailMessage.create({
        data: {
          threadId: thread.id,
          mailboxId: mailbox.id,
          externalMessageId,
          fromAddress: parsed.fromAddress,
          fromName: parsed.fromName,
          toAddresses: JSON.stringify(parsed.toAddresses),
          subject: parsed.subject,
          bodyText: metadataOnly ? null : parsed.bodyText,
          bodyHtml: metadataOnly ? null : parsed.bodyHtml,
          receivedAt: parsed.receivedAt,
          headers: JSON.stringify(parsed.headers),
          processingState: willClassify ? 'STORED' : isOutbound ? 'PROCESSED' : 'SKIPPED',
          attempts: willClassify ? 1 : 0,
        },
      });
      storedMessageId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) return 'exists';
      throw err;
    }

    if (isOutbound) {
      await recordOutboundMessage(mailbox, thread, parsed.receivedAt);
      return 'stored';
    }

    if (metadataOnly) return 'stored';

    // Inbound: classify + maybe draft.
    // Skipped for old messages during bulk resync (stored for context only;
    // orphan bodies left this way are purged by the retention job).
    if (willClassify) {
      await classifyAndDraft({ mailbox, thread, parsed });
      await prisma.emailMessage.update({
        where: { id: storedMessageId },
        data: { processingState: 'PROCESSED' },
      });
      if (!thread.candidateId) await scrubBodyIfUnlinked(thread.id, externalMessageId);
    }
    return 'stored';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Gmail] Failed to process message ${externalMessageId}:`, safeError(err));
    await logEvent(
      'MESSAGE_PROCESSING_FAILED',
      {
        mailboxId: mailbox.id,
        messageId: externalMessageId,
        stored: storedMessageId !== null,
        error: message,
      },
      'WARN'
    );
    if (storedMessageId) {
      // The row exists, so reconcile won't refetch it; flag it for the
      // sweep-stuck-messages cron instead (M3).
      await prisma.emailMessage
        .update({ where: { id: storedMessageId }, data: { processingState: 'FAILED' } })
        .catch((e: unknown) => console.warn('[Gmail] Failed to mark message FAILED:', safeError(e)));
      return 'stored';
    }
    const attempts = await recordFetchTombstone(mailbox.id, externalMessageId, 'FAILED', message);
    return attempts >= MAX_FETCH_ATTEMPTS ? 'abandoned' : 'failed';
  }
}

/**
 * Full N-day fallback sync. Used:
 *   - As one-time backfill when `lastHistoryId` is null (no baseline yet).
 *   - Via the manual /api/mailboxes/:id/resync endpoint.
 *   - Via the OAuth-callback / workspace-connect auto-backfill.
 * Webhook-driven incremental sync uses `syncIncremental` instead.
 *
 * For every NEW inbound message we run classification + draft generation
 * inline (see fetchAndStoreMessage → classifyAndDraft). Outbound messages
 * from the recruiter update Candidate.repliedAt so the dashboard can show
 * reply status.
 *
 * After completion, stores the current historyId so future webhooks can run
 * incrementally.
 *
 * Messages are fetched in parallel (8 concurrent) with Gmail API pagination.
 * Claude classification/drafting only runs for messages newer than classifyDaysBack
 * (default 7 days) — older messages are stored for thread context but not acted on.
 */
// Run an async function over an array with at most `concurrency` tasks in-flight.
async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function syncMessages(
  mailboxId: string,
  opts: { maxResults?: number; daysBack?: number; classifyDaysBack?: number } = {}
): Promise<{ messagesSeen: number; messagesStored: number }> {
  const maxResults = opts.maxResults ?? 500;
  const daysBack = opts.daysBack ?? 7;
  // Only run Claude classification/drafting for messages within this recent
  // window. Older messages are stored for thread context but not acted on,
  // keeping bulk resyncs fast.
  const classifyDaysBack = opts.classifyDaysBack ?? 7;
  const classifyCutoff = new Date(Date.now() - classifyDaysBack * 24 * 60 * 60 * 1000);

  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !mailbox.isActive) return { messagesSeen: 0, messagesStored: 0 };

  const gmail = await getGmailClient(mailbox);

  // Paginate through all message IDs in the window (one fast list call per page).
  const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const allMessageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      // Drafts (incl. the app's own) and chats aren't mail we ingest, and
      // drafts 404 once sent/discarded (M25).
      q: `after:${after} -in:drafts -in:chats`,
      maxResults: 500,
      pageToken,
    });
    for (const msg of listRes.data.messages ?? []) {
      if (msg.id) allMessageIds.push(msg.id);
    }
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken && allMessageIds.length < maxResults);

  // Single batch query to find which IDs are already stored — avoids one
  // DB round-trip per message (previously 500 individual queries).
  const alreadyStored = await prisma.emailMessage.findMany({
    where: { externalMessageId: { in: allMessageIds } },
    select: { externalMessageId: true },
  });
  const storedSet = new Set(alreadyStored.map((m) => m.externalMessageId));
  const newMessageIds = allMessageIds.filter((id) => !storedSet.has(id));

  // Fetch + store only NEW messages in parallel (8 concurrent).
  // Messages older than classifyCutoff skip the Claude classify+draft step.
  let stored = 0;
  const storedResults = await pMap(
    newMessageIds,
    (msgId) => fetchAndStoreMessage(gmail, mailbox, msgId, { classifyCutoff }),
    12
  );
  for (const r of storedResults) if (r === 'stored') stored++;

  // After a full sync, capture the current historyId so subsequent webhooks
  // run incrementally.
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (profile.data.historyId) {
      await prisma.mailbox.update({
        where: { id: mailboxId },
        data: { lastHistoryId: profile.data.historyId },
      });
    }
  } catch (err) {
    console.warn(`[Gmail] Failed to capture historyId after full sync:`, safeError(err));
  }

  await logEvent(
    'MAILBOX_SYNCED',
    { mailboxId, messagesSeen: allMessageIds.length, newMessages: newMessageIds.length, messagesStored: stored },
    'INFO'
  );

  return { messagesSeen: allMessageIds.length, messagesStored: stored };
}

/**
 * Incremental sync using Gmail history.list. Only fetches messages added since
 * `mailbox.lastHistoryId`. Falls back to `syncMessages` (7-day scan) if no
 * baseline exists yet.
 *
 * Returns the number of new messages fetched.
 */
export async function syncIncremental(
  mailboxId: string,
  incomingHistoryId?: string
): Promise<number> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !mailbox.isActive) return 0;

  // No baseline → one-time 7-day backfill, then store latest historyId.
  if (!mailbox.lastHistoryId) {
    console.log(`[Gmail] No baseline historyId for ${mailbox.emailAddress}, running fallback sync`);
    await syncMessages(mailboxId);
    return 0;
  }

  const gmail = await getGmailClient(mailbox);

  const startHistoryId = mailbox.lastHistoryId;
  // message id → id of the first history record that added it, so a failed
  // fetch can hold the cursor just before that record (L1).
  const newMessageIds = new Map<string, string | undefined>();
  let latestHistoryId: string | undefined;
  let pageToken: string | undefined;

  try {
    do {
      const historyRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        // No historyTypes filter — we want messageAdded for inbound AND
        // outbound mail so we can track recruiter replies for repliedAt.
        pageToken,
        maxResults: 500,
      });

      const history = historyRes.data.history ?? [];
      for (const entry of history) {
        const added = entry.messagesAdded ?? [];
        for (const added_msg of added) {
          const msgId = added_msg.message?.id;
          if (msgId && !newMessageIds.has(msgId)) {
            newMessageIds.set(msgId, entry.id ?? undefined);
          }
        }
      }

      if (historyRes.data.historyId) {
        latestHistoryId = historyRes.data.historyId;
      }
      pageToken = historyRes.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Gmail returns 404 if startHistoryId is too old (Gmail retains ~30d of
    // history but in practice paused/idle mailboxes hit this earlier). Fall
    // back to the 7-day full sync — syncMessages updates mailbox.lastHistoryId
    // to the new baseline after it completes, so subsequent webhooks run
    // incrementally again.
    const errObj = err as {
      code?: number;
      status?: number;
      response?: { status?: number };
    };
    const status = errObj?.code ?? errObj?.status ?? errObj?.response?.status;
    if (status === 404) {
      await logEvent(
        'HISTORY_ID_EXPIRED',
        {
          mailboxId,
          emailAddress: mailbox.emailAddress,
          startHistoryId,
        },
        'WARN'
      );
      console.warn(
        `[Gmail] historyId expired for ${mailbox.emailAddress} (startHistoryId=${startHistoryId}), falling back to full sync`
      );
      const result = await syncMessages(mailboxId);
      return result.messagesStored;
    }
    throw err;
  }

  // Fetch and store each new message (with classification for inbound).
  // Retryable failures hold the cursor at the record before the earliest one
  // so the next push / run re-reads from there; already-stored messages in
  // that range are cheap 'exists' skips. 404s, P2002s and messages that hit
  // MAX_FETCH_ATTEMPTS don't hold it (reconcile + tombstones cover them).
  let holdBefore: bigint | null = null;
  let failedCount = 0;
  let stored = 0;
  for (const [msgId, recordId] of newMessageIds) {
    const outcome = await fetchAndStoreMessage(gmail, mailbox, msgId);
    if (outcome === 'stored') stored += 1;
    if (outcome === 'failed' || outcome === 'abandoned') failedCount += 1;
    if (outcome === 'failed' && recordId && /^\d+$/.test(recordId)) {
      const before = BigInt(recordId) - 1n;
      if (holdBefore === null || before < holdBefore) holdBefore = before;
    }
  }

  // The history list was read to the end, so Gmail's latest historyId (or
  // the push's, if Gmail returned none) is safe — unless a failure holds it.
  let newHistoryId = latestHistoryId ?? incomingHistoryId;
  if (holdBefore !== null) {
    newHistoryId =
      /^\d+$/.test(startHistoryId) && holdBefore <= BigInt(startHistoryId)
        ? startHistoryId
        : holdBefore.toString();
  }
  if (newHistoryId && newHistoryId !== startHistoryId) {
    await prisma.mailbox.update({
      where: { id: mailboxId },
      data: { lastHistoryId: newHistoryId },
    });
  }

  await logEvent(
    'MAILBOX_SYNCED_INCREMENTAL',
    {
      mailboxId,
      messageCount: newMessageIds.size,
      storedCount: stored,
      failedCount,
      startHistoryId,
      endHistoryId: newHistoryId,
    },
    'INFO'
  );

  return newMessageIds.size;
}

/**
 * Resolve a mailbox owner's real display name for backfill.
 *
 * Strategy (in order):
 *   1. Try userinfo via the stored OAuth credentials. Will fail if the user
 *      connected before Phase L added the userinfo.profile scope.
 *   2. Fall back to the most recent outbound `EmailMessage.fromName` for this
 *      mailbox (i.e. messages the owner has sent — their own client typically
 *      sets the From header to their real display name).
 *
 * Returns the resolved name + which source it came from, or null if neither
 * source produced a usable name. Callers decide what error to surface.
 */
export async function resolveMailboxDisplayName(
  mailbox: Mailbox
): Promise<{ displayName: string; source: 'userinfo' | 'sent_messages' } | null> {
  // 1. Try userinfo.
  try {
    const credentials = parseCredentials(mailbox);
    if (Object.keys(credentials).length > 0) {
      const oauth2Client = getAuthenticatedClient(credentials);
      const info = await fetchUserInfo(oauth2Client);
      if (info?.name && info.name.trim().length > 0) {
        return { displayName: info.name.trim(), source: 'userinfo' };
      }
    }
  } catch (err) {
    console.warn(
      `[Gmail] userinfo path failed for mailbox ${mailbox.id}:`,
      err instanceof Error ? err.message : err
    );
  }

  // 2. Fall back to inferring from sent messages. We look for outbound
  // messages where fromAddress matches the mailbox owner; their mail client
  // usually puts "Real Name <email>" in the From header, which we already
  // parsed into fromName at sync time.
  const recentOutbound = await prisma.emailMessage.findFirst({
    where: {
      mailboxId: mailbox.id,
      fromAddress: { equals: mailbox.emailAddress, mode: 'insensitive' },
      fromName: { not: null },
    },
    orderBy: { receivedAt: 'desc' },
    select: { fromName: true },
  });

  const inferred = recentOutbound?.fromName?.trim();
  if (inferred && inferred.length > 0 && inferred.toLowerCase() !== mailbox.emailAddress.toLowerCase()) {
    return { displayName: inferred, source: 'sent_messages' };
  }

  return null;
}

export async function watchMailbox(mailboxId: string): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !config.gmail.pubsubTopic) return;

  const gmail = await getGmailClient(mailbox);

  let res;
  try {
    res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: config.gmail.pubsubTopic,
        // No labelIds filter — we want notifications for both inbound and
        // outbound mail so we can track recruiter replies for repliedAt.
      },
    });
  } catch (err) {
    if (isAuthRevokedError(err)) {
      await markMailboxNeedsReauth(mailbox, err, 'watchMailbox');
      throw new MailboxNeedsReauthError(mailbox.emailAddress);
    }
    throw err;
  }

  const expiry = res.data.expiration
    ? new Date(parseInt(res.data.expiration))
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // The watch response returns the current historyId. Use it as the baseline
  // for incremental sync if we don't already have one.
  const baselineHistoryId = res.data.historyId ?? null;

  await prisma.mailbox.update({
    where: { id: mailboxId },
    data: {
      watchExpiry: expiry,
      // Only set the baseline if we don't have one yet — never overwrite an
      // existing historyId, otherwise we'd skip messages added between the
      // last sync and this watch renewal.
      ...(mailbox.lastHistoryId ? {} : { lastHistoryId: baselineHistoryId }),
    },
  });

  await logEvent('GMAIL_WATCH_SET', { mailboxId, expiry, baselineHistoryId }, 'INFO');
}

/**
 * Stop Gmail push notifications for a mailbox (L4). Called on disconnect so
 * Pub/Sub stops pushing for an address we no longer sync. Best-effort: a
 * failure is logged, never thrown — the soft-delete must still succeed, and
 * processWebhook ignores pushes for inactive mailboxes anyway.
 */
export async function stopMailboxWatch(mailboxId: string): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return;
  try {
    const gmail = await getGmailClient(mailbox);
    await gmail.users.stop({ userId: 'me' });
    await prisma.mailbox.update({ where: { id: mailboxId }, data: { watchExpiry: null } });
    await logEvent('GMAIL_WATCH_STOPPED', { mailboxId }, 'INFO');
  } catch (err) {
    const safe = safeError(err);
    console.warn(`[Gmail] Failed to stop watch for ${mailbox.emailAddress}:`, safe);
    await logEvent('GMAIL_WATCH_STOP_FAILED', { mailboxId, error: safe.message }, 'WARN');
  }
}

/**
 * Format a Date as `YYYY/MM/DD` (UTC) for use in Gmail's `q=after:` search
 * syntax. Gmail interprets `after:YYYY/MM/DD` as "messages received on or
 * after midnight of that day". Using UTC for the conversion avoids missing
 * mail near midnight in either direction.
 */
function gmailDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Reconcile one mailbox: list Gmail messages received in the last 24h and
 * compare against what we have stored. Any messageId Gmail reports but we
 * don't have gets re-ingested via fetchAndStoreMessage, which runs through
 * the same classification + draft generation path as the webhook. This is
 * the safety net for the Pub/Sub push pipeline (cold starts, watch expiry
 * windows, transient errors, Gmail history horizon).
 *
 * Returns counts so the caller can log them.
 */
export async function reconcileMailbox(
  mailboxId: string,
  opts: { deadline?: number } = {}
): Promise<{ scannedFromGmail: number; missingBefore: number; ingested: number }> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !mailbox.isActive) {
    return { scannedFromGmail: 0, missingBefore: 0, ingested: 0 };
  }

  const gmail = await getGmailClient(mailbox);

  // Gmail's `after:` only takes day precision, so subtracting 24h then taking
  // the date gives us a roughly 24–48h window depending on time of day. That
  // overlap is fine — fetchAndStoreMessage is idempotent.
  const after = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Drafts (incl. the app's own) and chats aren't ingestible mail and drafts
  // 404 once sent/discarded — without this they were "missing" every hour (M25).
  const q = `after:${gmailDateString(after)} -in:drafts -in:chats`;

  const messageIds: string[] = [];
  let pageToken: string | undefined;
  const MAX_PAGES = 5;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 500,
      pageToken,
    });
    const msgs = listRes.data.messages ?? [];
    for (const m of msgs) {
      if (m.id) messageIds.push(m.id);
    }
    pageToken = listRes.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  const scannedFromGmail = messageIds.length;
  if (scannedFromGmail === 0) {
    return { scannedFromGmail, missingBefore: 0, ingested: 0 };
  }

  // Find which of those we already have. Doing it with `in:` is bounded —
  // worst case ~2500 ids (5 pages × 500), which Postgres handles fine.
  // Global check: externalMessageId is unique across mailboxes, so a row
  // stored via another mailbox can't be inserted again anyway (M25).
  const existing = await prisma.emailMessage.findMany({
    where: { externalMessageId: { in: messageIds } },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));

  // Skip ids tombstoned in the last 48h: 404s and ids that failed
  // MAX_FETCH_ATTEMPTS times. Retryable FAILED ids are still attempted.
  const tombstones = await prisma.gmailFetchTombstone.findMany({
    where: {
      mailboxId: mailbox.id,
      externalMessageId: { in: messageIds.filter((id) => !existingSet.has(id)) },
      updatedAt: { gt: new Date(Date.now() - TOMBSTONE_TTL_MS) },
    },
    select: { externalMessageId: true, reason: true, attempts: true },
  });
  const tombstoned = new Set(
    tombstones
      .filter((t) => t.reason === 'NOT_FOUND' || t.attempts >= MAX_FETCH_ATTEMPTS)
      .map((t) => t.externalMessageId)
  );
  const missing = messageIds.filter((id) => !existingSet.has(id) && !tombstoned.has(id));

  let ingested = 0;
  for (const msgId of missing) {
    if (opts.deadline && Date.now() > opts.deadline) {
      console.warn(
        `[Gmail] reconcileMailbox(${mailbox.emailAddress}) deadline hit after ingesting ${ingested}/${missing.length}`
      );
      break;
    }
    const outcome = await fetchAndStoreMessage(gmail, mailbox, msgId);
    if (outcome === 'stored') ingested += 1;
  }

  return { scannedFromGmail, missingBefore: missing.length, ingested };
}

export async function renewGmailWatches(): Promise<number> {
  const mailboxes = await prisma.mailbox.findMany({
    where: {
      provider: 'GMAIL',
      isActive: true,
      // Revoked grants can't be renewed; the watchdog alerts on them instead.
      authStatus: { not: AUTH_STATUS_NEEDS_REAUTH },
    },
  });

  const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let renewed = 0;
  for (const mailbox of mailboxes) {
    if (!mailbox.watchExpiry || mailbox.watchExpiry < oneDayFromNow) {
      try {
        await watchMailbox(mailbox.id);
        renewed += 1;
        console.log(`[Gmail] Renewed watch for ${mailbox.emailAddress}`);
      } catch (err) {
        // Auth failures were already recorded (NEEDS_REAUTH + MAILBOX_AUTH_REVOKED)
        // by getGmailClient/watchMailbox; still record the renew failure itself.
        const safe = safeError(err);
        console.error(`[Gmail] Failed to renew watch for ${mailbox.emailAddress}:`, safe);
        await logEvent(
          'GMAIL_WATCH_RENEW_FAILED',
          {
            mailboxId: mailbox.id,
            emailAddress: mailbox.emailAddress,
            watchExpiry: mailbox.watchExpiry,
            authRevoked: isAuthRevokedError(err),
            error: safe.message,
            code: safe.code,
            status: safe.status,
          },
          'ERROR'
        );
      }
    }
  }
  return renewed;
}

export async function createServiceAccountClient(emailToImpersonate: string) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;

  if (!keyJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set — required for workspace OAuth");
  }

  const authOptions: {
    scopes: string[];
    subject: string;
    credentials: Record<string, unknown>;
  } = {
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    subject: emailToImpersonate,
    credentials: JSON.parse(keyJson) as Record<string, unknown>,
  };

  const auth = new google.auth.GoogleAuth(authOptions);
  const authClient = await auth.getClient();
  return google.gmail({ version: 'v1', auth: authClient as Parameters<typeof google.gmail>[0]['auth'] });
}

/**
 * The address createDraft CCs on a draft sent from `ownerEmail`, or null when
 * there is none (no CC configured, or the owner *is* the CC inbox). Exposed so
 * the UI shows the real CC instead of a hardcoded address (L17).
 */
export function draftCcAddressFor(ownerEmail: string): string | null {
  return resolveDraftCc(null, ownerEmail);
}

export interface GmailDraftInput {
  threadId: string;
  externalThreadId: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyToMessageId?: string;
  referencesHeader?: string;
  toAddress: string;
  /** The draft's stored EmailDraft.ccEmail (F4); null/undefined = configured default. */
  ccEmail?: string | null;
}

/** base64url RFC 2822 message for a draft, shared by create and update. */
async function buildDraftRaw(mailbox: Pick<Mailbox, 'id' | 'emailAddress'>, draft: GmailDraftInput): Promise<string> {
  // Build RFC 2822 email with proper threading headers
  // Every header value is CR/LF-stripped (and Subject RFC 2047-encoded) so
  // model- or user-supplied text can never inject extra headers (M10).
  const headers: string[] = [`To: ${stripHeaderBreaks(draft.toAddress)}`];

  // CC the draft's chosen admin (default sofia@archive.com) so they stay in
  // the loop on outbound recruiting traffic. Never CC the mailbox owner
  // itself, whichever CC was chosen, to avoid self-CC loops.
  const requested = (draft.ccEmail ?? config.draftCcEmail).trim();
  const ccAddress = resolveDraftCc(draft.ccEmail, mailbox.emailAddress);
  if (requested && !ccAddress) {
    await logEvent(
      'DRAFT_CC_SELF_SKIPPED',
      { mailboxId: mailbox.id, ownerAddress: mailbox.emailAddress.trim().toLowerCase(), ccAddress: requested },
      'INFO'
    );
  } else if (ccAddress) {
    headers.push(`Cc: ${stripHeaderBreaks(ccAddress)}`);
  }

  headers.push(`Subject: ${encodeHeaderValue(draft.subject)}`);
  headers.push('MIME-Version: 1.0');

  // CRITICAL: Set In-Reply-To and References for Superhuman threading
  // Only RFC Message-IDs (<id@host>) are valid here. Older manual drafts
  // stored the Gmail API message id, which mail clients can't thread on (M13);
  // Gmail still threads those via threadId below.
  if (isRfcMessageId(draft.inReplyToMessageId)) {
    headers.push(`In-Reply-To: ${draft.inReplyToMessageId.trim()}`);
  }
  const references = sanitizeReferences(draft.referencesHeader);
  if (references) {
    headers.push(`References: ${references}`);
  }

  let rawEmail: string;
  if (draft.bodyHtml) {
    // Send as HTML-only so every email client renders the styled version with
    // the signature logo and link. text/plain fallbacks cause clients to show
    // the plain-text part (which word-wraps mid-sentence).
    headers.push(`Content-Type: text/html; charset=utf-8`);
    rawEmail = headers.join('\r\n') + '\r\n\r\n' + draft.bodyHtml;
  } else {
    headers.push(`Content-Type: text/plain; charset=utf-8`);
    rawEmail = headers.join('\r\n') + '\r\n\r\n' + draft.bodyText;
  }
  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createDraft(mailboxId: string, draft: GmailDraftInput): Promise<string> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);
  const raw = await buildDraftRaw(mailbox, draft);

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        // CRITICAL: Always set threadId to preserve threading in Superhuman
        threadId: draft.externalThreadId,
      },
    },
  });

  return res.data.id ?? '';
}

/**
 * Replace an existing Gmail draft's message (e.g. after its CC changed, F4)
 * so what sits in the recruiter's Gmail Drafts matches the app.
 */
export async function updateDraft(mailboxId: string, externalDraftId: string, draft: GmailDraftInput): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);
  const raw = await buildDraftRaw(mailbox, draft);

  await gmail.users.drafts.update({
    userId: 'me',
    id: externalDraftId,
    requestBody: {
      id: externalDraftId,
      message: { raw, threadId: draft.externalThreadId },
    },
  });
}

export async function sendDraft(mailboxId: string, externalDraftId: string): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);

  await gmail.users.drafts.send({
    userId: 'me',
    requestBody: {
      id: externalDraftId,
    },
  });
}

/**
 * Send a reply directly (users.messages.send), with no Gmail draft in
 * between (U0 one-step send). Same RFC 2822 builder as createDraft, so the
 * threading headers and CC rules are identical.
 */
export async function sendMessage(
  mailboxId: string,
  draft: GmailDraftInput
): Promise<{ id: string; threadId: string }> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);
  const raw = await buildDraftRaw(mailbox, draft);

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: draft.externalThreadId },
  });

  return { id: res.data.id ?? '', threadId: res.data.threadId ?? draft.externalThreadId };
}

export async function deleteDraft(mailboxId: string, externalDraftId: string): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);

  await gmail.users.drafts.delete({ userId: 'me', id: externalDraftId });
}

const SOFIA_EMAIL = 'sofia@archive.com';

/**
 * Fetch up to 3 real sent replies from this mailbox (or Sofia's inbox, since
 * she handles continuations across all accounts) for the given classification.
 * These are passed as few-shot style examples to Claude so drafts mirror how
 * the recruiter actually writes instead of using the generic style guide.
 */
/**
 * Fetch the Gmail send-as signature for a mailbox.
 * Returns the HTML signature string, or null if unavailable
 * (e.g. the token predates the gmail.settings.basic scope).
 */
export async function fetchMailboxSignature(mailboxId: string): Promise<string | null> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return null;

  // Primary: use service-account DWD (works for workspace mailboxes without
  // re-authorization, as long as gmail.settings.basic is in the DWD scope list
  // under Google Admin Console > Security > API controls > Domain-wide delegation).
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (keyJson) {
    try {
      const saAuthOptions: { scopes: string[]; subject: string; credentials: Record<string, unknown> } = {
        scopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/gmail.settings.basic',
        ],
        subject: mailbox.emailAddress,
        credentials: JSON.parse(keyJson) as Record<string, unknown>,
      };
      const saAuth = new google.auth.GoogleAuth(saAuthOptions);
      const saClient = await saAuth.getClient();
      const saGmail = google.gmail({ version: 'v1', auth: saClient as Parameters<typeof google.gmail>[0]['auth'] });
      const res = await saGmail.users.settings.sendAs.list({ userId: 'me' });
      await persistSendAsAddresses(mailbox.id, res.data.sendAs);
      const primary =
        (res.data.sendAs ?? []).find((s) => s.isPrimary) ?? (res.data.sendAs ?? [])[0];
      if (primary?.signature) return primary.signature;
    } catch (err) {
      console.warn(
        `[Gmail] fetchMailboxSignature via service account failed for ${mailbox.emailAddress} — ` +
        `ensure gmail.settings.basic is granted in Google Admin DWD:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Second attempt: OAuth2 token (works for mailboxes re-authorized after gmail.settings.basic was added to scope).
  try {
    const credentials = parseCredentials(mailbox);
    const auth = getAuthenticatedClient(credentials);
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
    await persistSendAsAddresses(mailbox.id, res.data.sendAs);
    const primary =
      (res.data.sendAs ?? []).find((s) => s.isPrimary) ?? (res.data.sendAs ?? [])[0];
    if (primary?.signature) return primary.signature;
  } catch (err) {
    console.warn(
      `[Gmail] fetchMailboxSignature via OAuth failed for ${mailbox.emailAddress}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Last resort: fetch a recent sent message directly from Gmail using the
  // existing gmail.modify scope and extract the signature block from its HTML.
  // No extra scopes needed — we already have read access to all messages.
  return fetchSignatureFromGmailSent(mailbox);
}

/**
 * Store a mailbox's sendAs aliases (audit M11/H2). Best-effort: a failed
 * write must never break signature fetching or ingestion.
 */
async function persistSendAsAddresses(
  mailboxId: string,
  sendAs: Parameters<typeof sendAsEmailsFromGmail>[0]
): Promise<string[] | null> {
  const addresses = sendAsEmailsFromGmail(sendAs);
  if (addresses.length === 0) return null;
  try {
    await prisma.mailbox.update({
      where: { id: mailboxId },
      data: { sendAsAddresses: addresses, sendAsSyncedAt: new Date() },
    });
    return addresses;
  } catch (err) {
    console.warn(`[Gmail] Failed to persist sendAs list for mailbox ${mailboxId}:`, safeError(err));
    return null;
  }
}

/**
 * Re-read users.settings.sendAs.list for a mailbox and store the aliases.
 * Works with the gmail.modify scope we already hold. Returns the stored list,
 * or null when Gmail or the write failed (never throws).
 */
export async function refreshSendAsAddresses(mailboxId: string): Promise<string[] | null> {
  try {
    const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    if (!mailbox) return null;
    const gmail = await getGmailClient(mailbox);
    const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
    return await persistSendAsAddresses(mailbox.id, res.data.sendAs);
  } catch (err) {
    console.warn(`[Gmail] refreshSendAsAddresses failed for mailbox ${mailboxId}:`, safeError(err));
    return null;
  }
}

/**
 * Query Gmail's SENT folder for a Gmail-compose message and extract the
 * <div class="gmail_signature"> block. Works with the gmail.modify scope we
 * already have, so no additional OAuth grants or DWD changes are needed.
 *
 * Strategy:
 *  1. List the 50 most recent SENT messages.
 *  2. Fetch metadata (headers only) in parallel to detect which messages were
 *     composed in Gmail vs sent via the API. Gmail-composed messages are
 *     multipart/mixed or multipart/alternative; API-sent ones are text/html.
 *  3. Fetch full content for the gmail-composed candidates in parallel.
 *  4. Resolve any CID inline image references to data URIs so the signature
 *     logo renders when we re-use the HTML in new emails.
 */
async function fetchSignatureFromGmailSent(mailbox: Mailbox): Promise<string | null> {
  try {
    const credentials = parseCredentials(mailbox);
    let gmail: ReturnType<typeof google.gmail>;
    const credType = (credentials as Record<string, unknown>).type;
    if (credType === 'service_account') {
      const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
      if (!keyJson) {
        console.warn(`[Gmail] fetchSignatureFromGmailSent: no key JSON for ${mailbox.emailAddress}`);
        return null;
      }
      const saAuthOptions: { scopes: string[]; subject: string; credentials: Record<string, unknown> } = {
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        subject: mailbox.emailAddress,
        credentials: JSON.parse(keyJson) as Record<string, unknown>,
      };
      const saAuth = new google.auth.GoogleAuth(saAuthOptions);
      const saClient = await saAuth.getClient();
      gmail = google.gmail({ version: 'v1', auth: saClient as Parameters<typeof google.gmail>[0]['auth'] });
    } else {
      gmail = google.gmail({ version: 'v1', auth: getAuthenticatedClient(credentials) });
    }

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['SENT'],
      maxResults: 50,
    });
    const stubs = (listRes.data.messages ?? []).filter((s) => !!s.id);
    if (stubs.length === 0) return null;

    // Step 1: fetch metadata for all stubs in parallel to check Content-Type.
    const metaResults = await Promise.all(
      stubs.map((s) =>
        gmail.users.messages.get({ userId: 'me', id: s.id!, format: 'metadata', metadataHeaders: ['Content-Type'] })
          .catch(() => null)
      )
    );

    // Step 2: separate gmail-composed (multipart) from app-sent (text/html).
    // We check multipart first; if none found we fall back to any HTML message.
    const multipartIds: string[] = [];
    const htmlIds: string[] = [];
    for (const meta of metaResults) {
      if (!meta?.data.id) continue;
      const ct = (meta.data.payload?.headers ?? [])
        .find((h) => h.name?.toLowerCase() === 'content-type')?.value ?? '';
      if (ct.toLowerCase().startsWith('multipart/')) multipartIds.push(meta.data.id);
      else if (ct.toLowerCase().startsWith('text/html')) htmlIds.push(meta.data.id);
    }

    const candidateIds = multipartIds.length > 0 ? multipartIds.slice(0, 10) : htmlIds.slice(0, 5);

    // Step 3: fetch full content in parallel for candidates.
    const fullMessages = await Promise.all(
      candidateIds.map((id) =>
        gmail.users.messages.get({ userId: 'me', id, format: 'full' }).catch(() => null)
      )
    );

    for (const msg of fullMessages) {
      if (!msg?.data.payload) continue;
      const { html, cids } = extractHtmlAndCids(msg.data.payload);
      if (!html) continue;
      const resolvedHtml = resolveCidReferences(html, cids);
      const sig = extractGmailSignatureBlock(resolvedHtml);
      if (sig) {
        console.log(`[Gmail] fetchSignatureFromGmailSent: found signature for ${mailbox.emailAddress}`);
        return sig;
      }
    }

    console.warn(`[Gmail] fetchSignatureFromGmailSent: no signature found in SENT for ${mailbox.emailAddress}`);
    return null;
  } catch (err) {
    console.warn(
      `[Gmail] fetchSignatureFromGmailSent failed for ${mailbox.emailAddress}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Recursively extract the first text/html part and all inline CID image attachments. */
function extractHtmlAndCids(
  payload: import('googleapis').gmail_v1.Schema$MessagePart | null | undefined,
  cids: Record<string, { mimeType: string; data: string }> = {}
): { html: string | null; cids: Record<string, { mimeType: string; data: string }> } {
  if (!payload) return { html: null, cids };

  // Collect inline image attachments by their Content-ID header.
  if (payload.mimeType?.startsWith('image/') && payload.body?.data) {
    const contentIdHeader = (payload.headers ?? []).find(
      (h) => h.name?.toLowerCase() === 'content-id'
    );
    if (contentIdHeader?.value) {
      const cid = contentIdHeader.value.replace(/^<|>$/g, '');
      cids[cid] = { mimeType: payload.mimeType, data: payload.body.data };
    }
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    return { html, cids };
  }

  let html: string | null = null;
  for (const part of payload.parts ?? []) {
    const result = extractHtmlAndCids(part, cids);
    if (!html && result.html) html = result.html;
  }
  return { html, cids };
}

/** Replace cid: image references with inline data URIs so they render in new emails. */
function resolveCidReferences(
  html: string,
  cids: Record<string, { mimeType: string; data: string }>
): string {
  return html.replace(/src="cid:([^"]+)"/gi, (_match, cid: string) => {
    const attachment = cids[cid];
    if (attachment) {
      return `src="data:${attachment.mimeType};base64,${attachment.data}"`;
    }
    return `src="cid:${cid}"`;
  });
}

/**
 * Pull the <div class="gmail_signature"> block out of an email's HTML body.
 * Returns the inner HTML of the signature div, or null if not found.
 */
function extractGmailSignatureBlock(html: string): string | null {
  // Match the entire <div class="gmail_signature"...>...</div> block.
  // Gmail nests divs inside, so we use a simple "take until the matching closing
  // div" approach rather than a regex (which can't handle nesting properly).
  const startMarkers = [
    /class="[^"]*gmail_signature[^"]*"/i,
    /data-smartmail="gmail_signature"/i,
  ];

  for (const marker of startMarkers) {
    const markerMatch = marker.exec(html);
    if (!markerMatch) continue;

    // Walk backwards to find the opening <div tag before this attribute.
    const beforeMarker = html.slice(0, markerMatch.index);
    const lastDivOpen = beforeMarker.lastIndexOf('<div');
    if (lastDivOpen === -1) continue;

    // Now find the matching closing </div> by counting nesting depth.
    let depth = 0;
    let pos = lastDivOpen;
    while (pos < html.length) {
      const nextOpen = html.indexOf('<div', pos + 1);
      const nextClose = html.indexOf('</div>', pos + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        pos = nextOpen;
      } else {
        if (depth === 0) {
          // Extract everything INSIDE the outer div (skip the outer wrapper).
          const outerDiv = html.slice(lastDivOpen, nextClose + 6);
          const innerMatch = outerDiv.match(/^<div[^>]*>([\s\S]*)<\/div>$/i);
          return innerMatch ? innerMatch[1].trim() : outerDiv;
        }
        depth -= 1;
        pos = nextClose;
      }
    }
  }

  return null;
}

export function htmlSignatureToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Static hand-off reply ("I'm looping in <CC>…") used when Claude can't
 * produce one. The CC first name and hand-off type are passed through so the
 * fallback says the same thing the Claude prompt would (L12).
 * Pass signatureHtml (from fetchMailboxSignature) to include the real signature.
 */
export function buildHandoffDraftContent(
  candidateName: string,
  recruiterDisplayName: string | null,
  recruiterEmail: string,
  threadSubject: string,
  signatureHtml: string | null = null,
  opts: { ccName?: string; handoffType?: HandoffType } = {}
): { subject: string; bodyText: string; bodyHtml: string } {
  const firstName = candidateName.split(/\s+/)[0] ?? candidateName;
  const displaySeed = (recruiterDisplayName ?? '').trim();
  const looksLikeEmail = displaySeed.toLowerCase() === recruiterEmail.toLowerCase();
  const recruiterFirst =
    displaySeed.length > 0 && !looksLikeEmail
      ? (displaySeed.split(/\s+/)[0] ?? displaySeed)
      : ((recruiterEmail.split('@')[0] ?? '').split(/[._-]/)[0] ?? 'there');
  const ccName = opts.ccName?.trim() || 'Sofia';

  const subject = /^re:/i.test(threadSubject) ? stripHeaderBreaks(threadSubject) : `Re: ${stripHeaderBreaks(threadSubject)}`;

  const loopIn = loopInSentence(opts.handoffType ?? 'coordinator', ccName);

  const sigPlainText = signatureHtml ? '\n' + htmlSignatureToPlainText(signatureHtml) : '\n' + recruiterFirst;
  const sigHtmlBlock = signatureHtml
    ? `<div style="margin-top:8px">${signatureHtml}</div>`
    : `<span>${escapeHtml(recruiterFirst)}</span>`;

  const bodyText =
    `Hi ${firstName},\n\nI hope you're doing well.\n\n${loopIn}\n\nBest,${sigPlainText}`;

  // Use a simple inline-style layout that renders consistently across Gmail,
  // Superhuman, Outlook, and Apple Mail — no external CSS, no block elements
  // that add unwanted spacing. Line-height and margin on <p> kept minimal so
  // the email looks like a real person wrote it, not a newsletter.
  const bodyHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">` +
    `<p style="margin:0 0 14px 0">Hi ${escapeHtml(firstName)},</p>` +
    `<p style="margin:0 0 14px 0">I hope you're doing well.</p>` +
    `<p style="margin:0 0 14px 0">${escapeHtml(loopIn)}</p>` +
    `<p style="margin:0 0 6px 0">Best,</p>` +
    sigHtmlBlock +
    `</div>`;

  return { subject, bodyText, bodyHtml };
}

/**
 * Generate the hand-off ("looping in <CC>") reply for a non-CC inbox: Claude
 * first, falling back to the static template. Shared by auto-drafting, manual
 * generate and regenerate so all three behave and log the same way.
 * The fallback is logged as DRAFT_FALLBACK_TEMPLATE (WARN) and reported via
 * `template`, so it is never mistaken for Claude output (L12).
 */
export async function composeHandoffDraftContent(opts: {
  mailbox: Pick<Mailbox, 'id' | 'emailAddress' | 'displayName'> & { handoffProfile?: string | null };
  candidateName: string;
  candidateRole: string | null;
  threadId: string;
  threadSubject: string;
  messages: Array<{ fromAddress: string; fromName?: string | null; bodyText?: string | null; receivedAt: Date }>;
  classification: Classification;
  signatureHtml: string | null;
  via: string;
  /** The draft's stored ccEmail (regenerate keeps a changed CC, F4); omit for the default. */
  ccEmail?: string | null;
}): Promise<{
  subject: string;
  bodyText: string;
  bodyHtml: string;
  template: 'handoff_claude' | 'handoff_fallback_template';
  meta?: DraftGenerationMeta;
}> {
  const { mailbox, signatureHtml } = opts;
  // The person looped in is the draft's CC; a "No CC" draft still names the
  // default so the sentence reads naturally (the UI warns about the mismatch).
  const ccEmail = (resolveDraftCc(opts.ccEmail, mailbox.emailAddress) ?? config.draftCcEmail).toLowerCase();
  // First name only for the CC person so drafts say "Sofia" not "Sofia Delgado".
  const ccName = await ccFirstName(ccEmail);
  const handoffType = getHandoffType(mailbox.emailAddress, opts.candidateRole, mailbox.handoffProfile);
  const sigPlain = signatureHtml ? htmlSignatureToPlainText(signatureHtml) : null;

  try {
    const reply = await generateHandoffDraftReply(
      {
        subject: opts.threadSubject,
        messages: opts.messages.map((m) => ({
          fromAddress: m.fromAddress,
          fromName: m.fromName,
          bodyText: m.bodyText,
          receivedAt: m.receivedAt,
        })),
        candidateName: opts.candidateName,
        classification: opts.classification,
        signatureHtml,
        ccName,
        ccEmail,
        handoffType,
      },
      { email: mailbox.emailAddress, displayName: mailbox.displayName }
    );
    const bodyText = sigPlain ? `${reply.bodyText}\n${sigPlain}` : reply.bodyText;
    return {
      subject: reply.subject,
      bodyText,
      bodyHtml: composeDraftHtml(bodyText, signatureHtml, sigPlain),
      template: 'handoff_claude',
      meta: reply.meta,
    };
  } catch (err) {
    await logEvent(
      'DRAFT_FALLBACK_TEMPLATE',
      {
        mailboxId: mailbox.id,
        threadId: opts.threadId,
        via: opts.via,
        error: err instanceof Error ? err.message : String(err),
      },
      'WARN'
    );
    const content = buildHandoffDraftContent(
      opts.candidateName,
      mailbox.displayName,
      mailbox.emailAddress,
      opts.threadSubject,
      signatureHtml,
      { ccName, handoffType }
    );
    return { ...content, template: 'handoff_fallback_template' };
  }
}

/**
 * Drop the quoted history from a reply body so a style example is only what
 * the recruiter wrote: cut at the first "On … wrote:" / "-----Original
 * Message-----" line or the first ">"-quoted line.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex(
    (l) =>
      /^\s*>/.test(l) ||
      /^\s*On .+wrote:\s*$/i.test(l) ||
      /^\s*-+\s*Original Message\s*-+/i.test(l)
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
}

// A sent message this close to an app-sent draft's sentAt is that draft, not
// something the recruiter wrote themselves.
const APP_SENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Few-shot style examples for generateDraftReply (L11). Taken from the
 * recruiter's own sent Gmail replies (outbound EmailMessage rows that answer
 * a candidate message), not from the app's SENT drafts, which were the
 * model's own output. Replies the app sent are skipped. Falls back to
 * Sofia's mailbox when this one has none.
 */
export async function fetchExamplesForMailbox(
  mailboxId: string,
  mailboxEmail: string,
  classification: 'INTERESTED' | 'NOT_INTERESTED' | 'NEUTRAL'
): Promise<ExampleReply[]> {
  const mailboxIds = [mailboxId];
  if (mailboxEmail.toLowerCase() !== SOFIA_EMAIL) {
    const sofiaMailbox = await prisma.mailbox.findUnique({ where: { emailAddress: SOFIA_EMAIL } });
    if (sofiaMailbox) mailboxIds.push(sofiaMailbox.id);
  }

  const sentMessages = await prisma.emailMessage.findMany({
    where: {
      mailboxId: { in: mailboxIds },
      bodyText: { not: null },
      thread: { candidate: { status: classification } },
    },
    include: {
      mailbox: { select: { emailAddress: true } },
      thread: {
        include: {
          messages: {
            orderBy: { receivedAt: 'asc' },
            select: { fromAddress: true, bodyText: true, receivedAt: true },
          },
          candidate: { select: { name: true } },
          drafts: { where: { status: 'SENT' }, select: { sentAt: true } },
        },
      },
    },
    orderBy: { receivedAt: 'desc' },
    take: 40,
  });

  const examples: ExampleReply[] = [];
  for (const msg of sentMessages) {
    const owner = msg.mailbox.emailAddress.toLowerCase();
    if (msg.fromAddress.toLowerCase() !== owner) continue;

    const appSent = msg.thread.drafts.some(
      (d) => d.sentAt && Math.abs(d.sentAt.getTime() - msg.receivedAt.getTime()) < APP_SENT_WINDOW_MS
    );
    if (appSent) continue;

    const candidateMsg = [...msg.thread.messages]
      .reverse()
      .find((m) => m.receivedAt < msg.receivedAt && m.fromAddress.toLowerCase() !== owner);
    if (!candidateMsg?.bodyText) continue;

    const ourReply = stripQuotedReply(msg.bodyText ?? '');
    if (!ourReply) continue;

    examples.push({
      candidateName: msg.thread.candidate?.name ?? 'the candidate',
      candidateMessage: stripQuotedReply(candidateMsg.bodyText).slice(0, 800).trim(),
      ourReply: ourReply.slice(0, 600).trim(),
    });
    if (examples.length >= 3) break;
  }
  return examples;
}

function isHistoryIdNotNewer(incoming: string | undefined, stored: string | null): boolean {
  if (!incoming || !stored || !/^\d+$/.test(incoming) || !/^\d+$/.test(stored)) return false;
  return BigInt(incoming) <= BigInt(stored);
}

export async function processWebhook(data: { message: { data: string } }): Promise<void> {
  try {
    const decoded = Buffer.from(data.message.data, 'base64').toString('utf-8');
    const notification = JSON.parse(decoded) as { emailAddress: string; historyId: string };

    const mailbox = await prisma.mailbox.findUnique({
      where: { emailAddress: notification.emailAddress },
    });

    if (!mailbox) {
      console.warn(`[Gmail Webhook] No mailbox found for ${notification.emailAddress}`);
      // M27: runtime logs are kept <24h; persist so pushes for unknown /
      // deleted mailboxes are visible in SystemLog.
      await logEvent(
        'WEBHOOK_UNKNOWN_MAILBOX',
        { emailAddress: notification.emailAddress, historyId: notification.historyId },
        'WARN'
      );
      return;
    }

    // Disconnected (DELETE soft-deletes; users.stop is best-effort) or
    // revoked mailboxes: nothing to sync.
    if (!mailbox.isActive || mailbox.authStatus === AUTH_STATUS_NEEDS_REAUTH) {
      console.log(`[Gmail Webhook] Ignoring push for inactive mailbox ${mailbox.id}`);
      return;
    }

    // Pub/Sub at-least-once + one push per mailbox change: a push whose
    // historyId is not past our stored cursor has nothing new for us. This
    // replaces the per-instance in-memory cache, which never hit on
    // serverless (0 WEBHOOK_DUPLICATE_SKIPPED ever).
    if (isHistoryIdNotNewer(notification.historyId, mailbox.lastHistoryId)) {
      await logEvent(
        'WEBHOOK_STALE_SKIPPED',
        { mailboxId: mailbox.id, historyId: notification.historyId, lastHistoryId: mailbox.lastHistoryId },
        'INFO'
      );
      return;
    }

    // Incremental sync — only fetches messages added since lastHistoryId.
    // Falls back to syncMessages() if no baseline is set yet. Classification
    // and draft generation now happen per-message inside fetchAndStoreMessage,
    // so the webhook handler is a thin wrapper around the sync call.
    await syncIncremental(mailbox.id, notification.historyId);
  } catch (err) {
    console.error('[Gmail Webhook] Failed to process notification:', safeError(err));
    throw err;
  }
}

/**
 * Re-classify threads in a mailbox that need action but were never processed —
 * either because classifyAndDraft failed/was skipped, or because a candidate
 * replied after a webhook error.
 *
 * Covers two cases:
 *   1. Threads with no candidateId at all (fully orphaned)
 *   2. Threads that have a candidateId but no PENDING/APPROVED draft, and have
 *      a recent inbound reply that was never acted on
 *
 * Works entirely from data already in the DB — no Gmail API calls.
 */
export async function reclassifyOrphanedThreads(mailboxId: string): Promise<{ threadsFound: number; threadsClassified: number }> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return { threadsFound: 0, threadsClassified: 0 };

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Case 1: threads with no candidateId at all.
  const orphanedThreads = await prisma.emailThread.findMany({
    where: {
      mailboxId,
      candidateId: null,
      messages: { some: {} },
    },
    include: { messages: { orderBy: { receivedAt: 'asc' } } },
  });

  // Case 2: threads with a candidate but no pending/approved draft, where an
  // inbound reply arrived in the last 30 days (i.e. needs a response).
  const threadsNeedingDraft = await prisma.emailThread.findMany({
    where: {
      mailboxId,
      candidateId: { not: null },
      drafts: { none: { status: { in: LIVE_DRAFT_STATUSES } } },
      messages: {
        some: {
          fromAddress: { not: mailbox.emailAddress },
          receivedAt: { gte: thirtyDaysAgo },
        },
      },
    },
    include: { messages: { orderBy: { receivedAt: 'asc' } } },
  });

  const allThreads = [
    ...orphanedThreads,
    ...threadsNeedingDraft.filter((t) => !orphanedThreads.some((o) => o.id === t.id)),
  ];

  let classified = 0;
  for (const thread of allThreads) {
    const inbound = thread.messages
      .filter((m) => m.fromAddress.toLowerCase() !== mailbox.emailAddress.toLowerCase())
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    const latest = inbound[0];
    if (!latest) continue;
    // H8: a metadata-only message (body never stored, or scrubbed) can't be
    // meaningfully re-classified — skip rather than classify a bare subject.
    if (!thread.candidateId && !latest.bodyText && !latest.bodyHtml) continue;

    let toAddresses: string[] = [];
    let headers = { messageId: '', inReplyTo: '', references: '', cc: '' };
    try { toAddresses = JSON.parse(latest.toAddresses) as string[]; } catch { /* ignore */ }
    try { headers = JSON.parse(latest.headers) as typeof headers; } catch { /* ignore */ }

    const parsed: Parameters<typeof classifyAndDraft>[0]['parsed'] = {
      externalMessageId: latest.externalMessageId,
      threadId: thread.externalThreadId,
      subject: latest.subject,
      fromAddress: latest.fromAddress,
      fromName: latest.fromName ?? undefined,
      toAddresses,
      bodyText: latest.bodyText ?? '',
      bodyHtml: latest.bodyHtml ?? '',
      receivedAt: latest.receivedAt,
      headers,
    };

    try {
      await classifyAndDraft({ mailbox, thread, parsed });
      classified += 1;
    } catch (err) {
      console.error(`[reclassifyOrphanedThreads] Failed for thread ${thread.id}:`, safeError(err));
    }
  }

  await logEvent(
    'RECLASSIFY_ORPHANED_THREADS',
    { mailboxId, threadsFound: allThreads.length, threadsClassified: classified },
    'INFO'
  );

  return { threadsFound: allThreads.length, threadsClassified: classified };
}

/**
 * Sweeper for M3: inbound messages are stored before classification, so a
 * crash, freeze or timeout between the two (or a thrown classify/draft step)
 * left a stored-but-never-classified row that nothing retried, because every
 * ingest path treats "row exists" as done. Re-runs classifyAndDraft for
 * inbound rows stuck in STORED/FAILED for longer than `minAgeMs` (so rows a
 * live run is still working on are left alone), up to MAX_FETCH_ATTEMPTS.
 *
 * Each row is claimed with a compare-and-set on `attempts`, so overlapping
 * sweeps (or a sweep racing the original run) process it at most once.
 * Duplicate drafts are additionally prevented by classifyAndDraft's
 * existing-draft check and the live-draft unique index.
 */
export async function sweepStuckMessages(
  opts: { minAgeMs?: number; maxAgeMs?: number; limit?: number; deadline?: number } = {}
): Promise<{ found: number; processed: number; failed: number; skipped: number }> {
  const now = Date.now();
  const minAgeMs = opts.minAgeMs ?? 10 * 60 * 1000;
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;

  const rows = await prisma.emailMessage.findMany({
    where: {
      processingState: { in: ['STORED', 'FAILED'] },
      attempts: { lt: MAX_FETCH_ATTEMPTS },
      createdAt: { lt: new Date(now - minAgeMs), gt: new Date(now - maxAgeMs) },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 20,
    include: { thread: true, mailbox: true },
  });

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const { mailbox, thread } = row as typeof row & { mailbox: Mailbox; thread: EmailThread };
    if (
      !mailbox ||
      !thread ||
      !mailbox.isActive ||
      mailbox.authStatus === AUTH_STATUS_NEEDS_REAUTH ||
      row.fromAddress.toLowerCase() === mailbox.emailAddress.toLowerCase()
    ) {
      skipped += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    const claim = await prisma.emailMessage.updateMany({
      where: { id: row.id, processingState: row.processingState, attempts: row.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (claim.count === 0) {
      skipped += 1;
      continue;
    }

    let toAddresses: string[] = [];
    let headers = { messageId: '', inReplyTo: '', references: '', cc: '' };
    try { toAddresses = JSON.parse(row.toAddresses) as string[]; } catch { /* ignore */ }
    try { headers = { ...headers, ...(JSON.parse(row.headers) as Partial<typeof headers>) }; } catch { /* ignore */ }

    try {
      await classifyAndDraft({
        mailbox,
        thread,
        parsed: {
          externalMessageId: row.externalMessageId,
          threadId: thread.externalThreadId,
          subject: row.subject,
          fromAddress: row.fromAddress,
          fromName: row.fromName ?? undefined,
          toAddresses,
          bodyText: row.bodyText ?? '',
          bodyHtml: row.bodyHtml ?? '',
          receivedAt: row.receivedAt,
          headers,
        },
      });
      await prisma.emailMessage.update({
        where: { id: row.id },
        data: { processingState: 'PROCESSED' },
      });
      if (!thread.candidateId) await scrubBodyIfUnlinked(thread.id, row.externalMessageId);
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Sweeper] Failed to classify message ${row.id}:`, safeError(err));
      await prisma.emailMessage.update({
        where: { id: row.id },
        data: { processingState: 'FAILED' },
      });
      if (attempts >= MAX_FETCH_ATTEMPTS) {
        await logEvent(
          'MESSAGE_PROCESSING_ABANDONED',
          { mailboxId: mailbox.id, messageId: row.externalMessageId, attempts, error: message },
          'ERROR'
        );
      }
    }
  }

  if (rows.length > 0) {
    await logEvent(
      'SWEEP_STUCK_MESSAGES',
      { found: rows.length, processed, failed, skipped },
      failed > 0 ? 'WARN' : 'INFO'
    );
  }
  return { found: rows.length, processed, failed, skipped };
}
