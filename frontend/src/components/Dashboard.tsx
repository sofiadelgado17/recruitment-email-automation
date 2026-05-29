import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCandidates,
  fetchMailboxes,
  fetchDrafts,
  fetchSyncHealth,
  fetchMailboxSignatureHtml,
  approveDraft,
  resyncMailbox,
  reclassifyMailbox,
  debugCandidate,
  fixRepliedAt,
  type Candidate,
  type Mailbox,
  type EmailDraft,
  type MailboxSyncHealth,
  type ResyncResult,
} from '../lib/api';
import { cn } from '../lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Skeleton } from './ui/skeleton';
import {
  toastSuccess,
  toastError,
  extractApiErrorMessage,
  isAlreadyResolvedError,
} from '../lib/toast';
import {
  Mail,
  Clock,
  AlertCircle,
  FileText,
  AlertTriangle,
  Activity,
  Inbox,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Check,
  CheckCircle2,
  RefreshCw,
  Pen,
} from 'lucide-react';

interface Props {
  mailboxId?: string;
  onRefetchMailboxes: () => void;
  onSwitchToDrafts?: () => void;
  onSwitchToCandidates?: (filter?: string) => void;
  onOpenDraftForCandidate?: (candidateId: string) => void;
  onOpenDraft?: (draftId: string) => void;
}

// ---------- Action pill (the new hero) ----------

function ActionPill({
  count,
  label,
  hint,
  icon: Icon,
  tone,
  loading,
  onClick,
  testId,
}: {
  count: number;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'accent' | 'amber' | 'emerald';
  loading?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  const toneRing = {
    accent: 'hover:border-accent-400/50 group-hover:text-accent-500 dark:group-hover:text-accent-200',
    amber: 'hover:border-amber-400/50 group-hover:text-amber-700 dark:group-hover:text-amber-200',
    emerald: 'hover:border-emerald-400/50 group-hover:text-emerald-700 dark:group-hover:text-emerald-200',
  }[tone];
  const toneIcon = {
    accent: 'bg-accent-500/12 text-accent-600 dark:text-accent-300 ring-accent-500/20',
    amber: 'bg-amber-500/12 text-amber-700 dark:text-amber-300 ring-amber-500/20',
    emerald: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
  }[tone];
  const toneNumber = {
    accent: 'text-fg-strong group-hover:text-accent-600 dark:group-hover:text-accent-50',
    amber: 'text-fg-strong group-hover:text-amber-700 dark:group-hover:text-amber-50',
    emerald: 'text-fg-strong group-hover:text-emerald-700 dark:group-hover:text-emerald-50',
  }[tone];

  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-line bg-surface-raised/70 p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-surface-raised hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/40',
        toneRing
      )}
    >
      <div
        className={cn(
          'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition-transform group-hover:scale-105',
          toneIcon
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {loading ? (
            <Skeleton className="h-8 w-12" />
          ) : (
            <span
              className={cn(
                'font-display text-[34px] font-semibold leading-none tabular-nums tracking-tight transition-colors',
                toneNumber
              )}
            >
              {count}
            </span>
          )}
          <span className="text-[13px] font-medium text-fg-default">{label}</span>
        </div>
        <p className="mt-1.5 text-[11.5px] text-fg-muted">{hint}</p>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-fg-subtle transition-all group-hover:translate-x-0.5 group-hover:text-fg-default" />
    </button>
  );
}

// ---------- Quick triage row ----------

function initialsFor(name?: string, email?: string): string {
  const seed = (name || email || '?').trim();
  return (
    seed
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

function firstNonEmptyLine(body: string): string {
  return body.split('\n').find((l) => l.trim().length > 0) ?? '';
}

function QuickTriageRow({
  draft,
  onApprove,
  onOpen,
  approving,
}: {
  draft: EmailDraft;
  onApprove: (id: string) => void;
  onOpen: (id: string) => void;
  approving: boolean;
}) {
  const candidate = draft.thread?.candidate;
  const name = candidate?.name ?? 'Unknown candidate';
  const role = candidate?.role;
  const subjectLine = firstNonEmptyLine(draft.bodyText) || draft.subject;
  return (
    <div
      className="group flex cursor-pointer items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-fg-strong/[0.02]"
      onClick={() => onOpen(draft.id)}
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent-500/80 to-accent-700/80 text-[11px] font-semibold text-white ring-1 ring-inset ring-fg-strong/[0.08]">
        {initialsFor(name, candidate?.email)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-medium text-fg-strong">{name}</p>
          {role ? (
            <span
              data-testid="role-pill"
              className="max-w-[160px] flex-shrink-0 truncate rounded-md bg-accent-500/8 px-1.5 py-0.5 text-[10.5px] font-medium text-accent-600 ring-1 ring-inset ring-accent-500/15 dark:text-accent-300"
              title={role}
            >
              {role}
            </span>
          ) : null}
        </div>
        <p className="truncate text-[12px] text-fg-muted">{subjectLine}</p>
      </div>
      <div
        className="flex flex-shrink-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => onApprove(draft.id)}
          disabled={approving}
          aria-label={`Approve draft for ${name}`}
          className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1 text-[12px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/20 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300 dark:hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          onClick={() => onOpen(draft.id)}
          aria-label={`Open draft for ${name} in pane`}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fg-strong/[0.06] hover:text-fg-strong"
        >
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}

// ---------- Account Pipelines (condensed row) ----------

function AccountRow({
  mailbox,
  candidateCount,
  pendingDraftCount,
  onSwitchToDrafts,
}: {
  mailbox: Mailbox;
  candidateCount: number;
  pendingDraftCount: number;
  onSwitchToDrafts?: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-fg-strong/[0.02]"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-500/10 text-accent-600 dark:text-accent-300 ring-1 ring-inset ring-accent-500/20">
        <Mail className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13px] font-medium text-fg-strong">
          {mailbox.emailAddress}
        </p>
        <p className="mt-0.5 text-[11.5px] text-fg-muted">
          <span className="tabular-nums">{candidateCount}</span>{' '}
          candidate{candidateCount !== 1 ? 's' : ''}
          <span className="mx-1.5 text-fg-subtle/40">·</span>
          <span className="tabular-nums">{pendingDraftCount}</span> pending draft{pendingDraftCount !== 1 ? 's' : ''}
        </p>
      </div>
      {pendingDraftCount > 0 && (
        <button
          onClick={onSwitchToDrafts}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-500/20 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
        >
          <AlertCircle className="h-3 w-3" />
          Review
        </button>
      )}
    </div>
  );
}

// ---------- Mailbox health helpers ----------

function watchExpiryTone(hours: number | null): string {
  if (hours === null) return 'text-fg-subtle';
  if (hours < 0) return 'text-rose-700 dark:text-rose-300';
  if (hours < 24) return 'text-amber-700 dark:text-amber-300';
  return 'text-fg-muted';
}

function formatWatchExpiry(h: number | null): string {
  if (h === null) return 'no watch';
  if (h < 0) return `−${Math.abs(Math.round(h))}h`;
  if (h < 1) return `< 1h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function summarizeHealth(data: MailboxSyncHealth[]): {
  tone: 'emerald' | 'amber' | 'rose' | 'neutral';
  label: string;
} {
  if (data.length === 0) return { tone: 'neutral', label: 'No mailbox health data' };
  const expiringSoon = data.filter(
    (d) => d.watchExpiresInHours !== null && d.watchExpiresInHours < 24
  ).length;
  const drift = data.some((d) => d.lastReconciliationFoundMissing > 0);
  const webhookErrors = data.some((d) => d.webhookErrorsLast24h > 0);

  if (webhookErrors) return { tone: 'rose', label: 'Webhook errors today' };
  if (drift) return { tone: 'amber', label: 'Drift detected' };
  if (expiringSoon > 0)
    return {
      tone: 'amber',
      label: `${expiringSoon} watch${expiringSoon === 1 ? '' : 'es'} expiring soon`,
    };
  return { tone: 'emerald', label: 'All mailboxes healthy' };
}

function HealthPill({
  summary,
}: {
  summary: ReturnType<typeof summarizeHealth>;
}) {
  const toneClass = {
    emerald: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300',
    rose: 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300',
    neutral: 'bg-fg-strong/[0.04] text-fg-muted ring-fg-strong/[0.06]',
  }[summary.tone];
  const Icon =
    summary.tone === 'emerald'
      ? CheckCircle2
      : summary.tone === 'rose'
        ? AlertCircle
        : summary.tone === 'amber'
          ? AlertTriangle
          : Activity;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 ring-inset',
        toneClass
      )}
    >
      <Icon className="h-3 w-3" />
      {summary.label}
    </span>
  );
}

function MailboxHealthAccordion({
  data,
  loading,
  error,
  onResync,
}: {
  data: MailboxSyncHealth[];
  loading: boolean;
  error?: boolean;
  onResync: (mailboxId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [resyncing, setResyncing] = useState<string | null>(null);
  const [reclassifying, setReclassifying] = useState<string | null>(null);
  const [reclassifyResult, setReclassifyResult] = useState<{ mailboxId: string; threadsFound: number; threadsClassified: number } | null>(null);
  const [sigPreview, setSigPreview] = useState<{ mailboxId: string; html: string | null } | null>(null);
  const [loadingSig, setLoadingSig] = useState<string | null>(null);
  const [debugEmail, setDebugEmail] = useState('');
  const [debugResult, setDebugResult] = useState<{ loading: boolean; data?: unknown; error?: string } | null>(null);

  const handleDebugEmail = async () => {
    if (!debugEmail.trim()) return;
    setDebugResult({ loading: true });
    try {
      const res = await debugCandidate(debugEmail.trim());
      setDebugResult({ loading: false, data: res.data });
    } catch (err: unknown) {
      setDebugResult({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const handlePreviewSig = async (mailboxId: string) => {
    if (sigPreview?.mailboxId === mailboxId) { setSigPreview(null); return; }
    setLoadingSig(mailboxId);
    try {
      const { signatureHtml } = await fetchMailboxSignatureHtml(mailboxId);
      setSigPreview({ mailboxId, html: signatureHtml });
    } catch {
      setSigPreview({ mailboxId, html: null });
    } finally {
      setLoadingSig(null);
    }
  };

  if (!loading && !error && data.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-raised/60">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mailbox-health-detail"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fg-strong/[0.02]"
      >
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300">
          <Activity className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg-strong">Mailbox health</p>
          <p className="mt-0.5 text-[11.5px] text-fg-muted">
            Watch tokens, reconciliation drift, webhook errors per mailbox.
          </p>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 flex-shrink-0 text-fg-muted transition-transform',
            open && 'rotate-180 text-fg-strong'
          )}
        />
      </button>
      {open && (
        <div id="mailbox-health-detail" className="border-t border-line">
          {loading ? (
            <Skeleton className="h-24 rounded-none" />
          ) : error ? (
            <p className="px-4 py-4 text-[13px] text-fg-muted">
              Could not load mailbox health data — the server returned an error. Check Vercel logs for details.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted">
                    <th className="px-4 py-2.5 text-left">Mailbox</th>
                    <th className="px-4 py-2.5 text-left">Watch expires</th>
                    <th className="hidden px-4 py-2.5 text-left sm:table-cell">
                      Total msgs
                    </th>
                    <th className="hidden px-4 py-2.5 text-left sm:table-cell">
                      Candidates
                    </th>
                    <th className="hidden px-4 py-2.5 text-left md:table-cell">
                      Last reconciled
                    </th>
                    <th className="px-4 py-2.5 text-left">Drift</th>
                    <th className="px-4 py-2.5 text-left">Errors / 24h</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {data.map((row) => {
                    const driftTone =
                      row.lastReconciliationFoundMissing > 0
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-fg-subtle';
                    const webhookErrTone =
                      row.webhookErrorsLast24h > 0
                        ? 'text-rose-700 dark:text-rose-300'
                        : 'text-fg-subtle';
                    const recon = row.lastReconciliationAt
                      ? new Date(row.lastReconciliationAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—';
                    return (
                      <tr
                        key={row.mailboxId}
                        className="transition-colors hover:bg-fg-strong/[0.02]"
                      >
                        <td className="px-4 py-2.5">
                          <p className="max-w-[220px] truncate font-mono text-[12px] text-fg-strong">
                            {row.emailAddress}
                          </p>
                          <p className="font-mono text-[10px] text-fg-subtle select-all">
                            {row.mailboxId}
                          </p>
                          {!row.isActive && (
                            <span className="text-[10px] text-rose-700 dark:text-rose-300">
                              inactive
                            </span>
                          )}
                          <button
                            onClick={() => {
                              setResyncing(row.mailboxId);
                              onResync(row.mailboxId);
                              setTimeout(() => setResyncing(null), 4000);
                            }}
                            disabled={resyncing === row.mailboxId}
                            className="mt-1 flex items-center gap-1 text-[10px] text-fg-muted hover:text-fg-strong disabled:opacity-50"
                          >
                            <RefreshCw className={cn('h-2.5 w-2.5', resyncing === row.mailboxId && 'animate-spin')} />
                            {resyncing === row.mailboxId ? 'Resyncing…' : 'Resync'}
                          </button>
                          <button
                            onClick={async () => {
                              setReclassifying(row.mailboxId);
                              setReclassifyResult(null);
                              try {
                                const res = await reclassifyMailbox(row.mailboxId);
                                setReclassifyResult({ mailboxId: row.mailboxId, ...res.data });
                              } catch {
                                // ignore
                              } finally {
                                setReclassifying(null);
                              }
                            }}
                            disabled={reclassifying === row.mailboxId}
                            className="mt-0.5 flex items-center gap-1 text-[10px] text-fg-muted hover:text-fg-strong disabled:opacity-50"
                            title="Re-classify threads that have messages but no linked candidate"
                          >
                            <RefreshCw className={cn('h-2.5 w-2.5', reclassifying === row.mailboxId && 'animate-spin')} />
                            {reclassifying === row.mailboxId ? 'Classifying…' : 'Re-classify unlinked'}
                          </button>
                          {reclassifyResult?.mailboxId === row.mailboxId && (
                            <span className="mt-0.5 text-[10px] text-fg-muted">
                              {reclassifyResult.threadsFound === 0
                                ? 'No orphaned threads found'
                                : `${reclassifyResult.threadsClassified}/${reclassifyResult.threadsFound} threads classified`}
                            </span>
                          )}
                          <button
                            onClick={() => handlePreviewSig(row.mailboxId)}
                            disabled={loadingSig === row.mailboxId}
                            className="mt-0.5 flex items-center gap-1 text-[10px] text-fg-muted hover:text-fg-strong disabled:opacity-50"
                          >
                            <Pen className="h-2.5 w-2.5" />
                            {loadingSig === row.mailboxId ? 'Loading…' : sigPreview?.mailboxId === row.mailboxId ? 'Hide sig' : 'Preview sig'}
                          </button>
                          {sigPreview?.mailboxId === row.mailboxId && (
                            <div className="mt-1.5 max-w-[280px] rounded border border-line bg-white p-2 text-[11px]">
                              {sigPreview.html ? (
                                <iframe
                                  srcDoc={`<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:sans-serif;font-size:13px">${sigPreview.html}</body></html>`}
                                  sandbox="allow-same-origin"
                                  className="w-full border-0"
                                  style={{ minHeight: 60 }}
                                  onLoad={(e) => {
                                    const iframe = e.currentTarget;
                                    const body = iframe.contentDocument?.body;
                                    if (body) iframe.style.height = `${body.scrollHeight + 8}px`;
                                  }}
                                  title="Signature preview"
                                />
                              ) : (
                                <span className="text-rose-600">No signature found — see notes below.</span>
                              )}
                            </div>
                          )}
                          {sigPreview?.mailboxId === row.mailboxId && !sigPreview.html && (
                            <p className="mt-1 max-w-[280px] text-[10px] text-fg-muted leading-snug">
                              Grant <code>gmail.settings.basic</code> in Google Admin Console → Security → API controls → Domain-wide delegation, then resync.
                            </p>
                          )}
                        </td>
                        <td
                          className={cn(
                            'px-4 py-2.5 font-mono tabular-nums',
                            watchExpiryTone(row.watchExpiresInHours)
                          )}
                        >
                          {formatWatchExpiry(row.watchExpiresInHours)}
                        </td>
                        <td className={cn('hidden px-4 py-2.5 font-mono tabular-nums sm:table-cell', row.totalMessages === 0 ? 'text-rose-600' : 'text-fg-default')}>
                          {row.totalMessages}
                        </td>
                        <td className="hidden px-4 py-2.5 font-mono tabular-nums text-fg-default sm:table-cell">
                          {row.totalCandidates}
                        </td>
                        <td className="hidden px-4 py-2.5 text-fg-muted md:table-cell">
                          {recon}
                        </td>
                        <td className={cn('px-4 py-2.5 font-mono tabular-nums', driftTone)}>
                          {row.lastReconciliationFoundMissing}
                        </td>
                        <td className={cn('px-4 py-2.5', webhookErrTone)}>
                          <span className="font-mono tabular-nums">{row.webhookErrorsLast24h}</span>
                          {row.lastWebhookError && (
                            <span className="ml-2 text-[11px] opacity-75 truncate max-w-[200px] inline-block align-middle" title={row.lastWebhookError}>
                              — {row.lastWebhookError.slice(0, 60)}{row.lastWebhookError.length > 60 ? '…' : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && (
            <div className="border-t border-line px-4 py-3 flex flex-col gap-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted">Find candidate by email</p>
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="e.g. sofiadelgadosandoval@gmail.com"
                  value={debugEmail}
                  onChange={(e) => setDebugEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleDebugEmail()}
                  className="flex-1 rounded border border-line bg-surface px-2.5 py-1.5 text-[12px] font-mono placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent-400"
                />
                <button
                  onClick={() => void handleDebugEmail()}
                  disabled={debugResult?.loading}
                  className="rounded border border-line px-3 py-1.5 text-[12px] text-fg-muted hover:bg-fg-strong/[0.04] hover:text-fg-strong disabled:opacity-50"
                >
                  {debugResult?.loading ? 'Searching…' : 'Search'}
                </button>
              </div>
              {debugResult && !debugResult.loading && (
                <div className="rounded border border-line bg-surface p-2 text-[11px] font-mono">
                  {debugResult.error ? (
                    <span className="text-rose-600">{debugResult.error}</span>
                  ) : (
                    <CandidateDebugResult data={debugResult.data} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CandidateDebugResult({ data }: { data: unknown }) {
  const d = data as {
    candidate?: { id: string; name: string; email: string; status: string; createdAt: string; threads?: { id: string; subject: string; messages?: unknown[]; drafts?: { id: string; status: string }[] }[] } | null;
    messagesFromEmail?: { externalMessageId: string; subject: string; receivedAt: string; mailboxId: string; thread: { id: string; candidateId: string | null; subject: string } }[];
    skipLogs?: { event: string; createdAt: string; details: string }[];
  };

  if (!d.candidate && (!d.messagesFromEmail || d.messagesFromEmail.length === 0)) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-rose-600 font-semibold">Not in DB — no candidate record and no stored messages from this email.</span>
        <span className="text-fg-muted">This means the reply was either: (a) never synced — try Resync all inboxes, or (b) the message exists in Gmail but couldn&apos;t be fetched.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {d.candidate ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-emerald-600 font-semibold">✓ Candidate found</span>
          <span>{d.candidate.name} &lt;{d.candidate.email}&gt;</span>
          <span>Status: <strong>{d.candidate.status}</strong> — created {new Date(d.candidate.createdAt).toLocaleString()}</span>
          {d.candidate.threads?.map((t) => (
            <div key={t.id} className="ml-2">
              <span className="text-fg-muted">Thread: &quot;{t.subject}&quot; — {t.messages?.length ?? 0} msgs, {t.drafts?.length ?? 0} drafts</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-amber-600 font-semibold">No candidate record for this email.</span>
      )}
      {d.messagesFromEmail && d.messagesFromEmail.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-fg-muted">Messages stored from this sender ({d.messagesFromEmail.length}):</span>
          {d.messagesFromEmail.map((m) => (
            <div key={m.externalMessageId} className="ml-2">
              <span>{new Date(m.receivedAt).toLocaleString()} — &quot;{m.subject}&quot;{m.thread.candidateId ? '' : ' — ⚠ no candidate linked'}</span>
            </div>
          ))}
        </div>
      )}
      {d.skipLogs && d.skipLogs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-amber-600 font-semibold">Classification events ({d.skipLogs.length}):</span>
          {d.skipLogs.map((l, i) => (
            <div key={i} className="ml-2">
              <span>{new Date(l.createdAt).toLocaleString()} — <strong>{l.event}</strong></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Section header ----------

function SectionHeader({
  icon: Icon,
  iconClass,
  title,
  count,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  title: string;
  count?: number;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset',
            iconClass
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <h2 className="font-display text-[15px] font-semibold tracking-tight text-fg-strong">
          {title}
        </h2>
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-fg-strong/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-fg-muted">
            {count}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}

// ---------- Empty state ----------

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <Empty
      className={cn(
        'rounded-xl border border-dashed border-line-strong bg-surface-raised/40 px-6',
        compact ? 'py-8' : 'py-12'
      )}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-fg-strong/[0.04] text-fg-muted">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="font-display text-[14.5px] font-medium text-fg-strong">
          {title}
        </EmptyTitle>
        <EmptyDescription className="max-w-xs text-[12.5px] leading-relaxed text-fg-muted">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      {action ? <div>{action}</div> : null}
    </Empty>
  );
}

// ---------- Resync All Button ----------

function FixRepliedAtButton() {
  const [state, setState] = useState<{ running: boolean; result?: string }>({ running: false });

  const handleFix = async () => {
    setState({ running: true });
    try {
      const res = await fixRepliedAt();
      setState({ running: false, result: `Fixed — cleared ${res.data.cleared} of ${res.data.checked} candidates` });
    } catch {
      setState({ running: false, result: 'Failed — check logs' });
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => void handleFix()}
        disabled={state.running}
        className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-fg-muted transition-colors hover:bg-fg-strong/[0.04] hover:text-fg-strong disabled:opacity-50"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', state.running && 'animate-spin')} />
        {state.running ? 'Fixing…' : 'Fix replied-at'}
      </button>
      {state.result && (
        <p className="text-right text-[11px] text-fg-muted">{state.result}</p>
      )}
    </div>
  );
}

function ResyncAllButton({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [resyncing, setResyncing] = useState(false);
  const [results, setResults] = useState<{ email: string; ok: boolean; data?: ResyncResult; error?: string }[] | null>(null);

  const handleResyncAll = async () => {
    setResyncing(true);
    setResults(null);
    const outcomes = await Promise.all(
      mailboxes.map(async (mb) => {
        try {
          const res = await resyncMailbox(mb.id);
          return { email: mb.emailAddress, ok: true, data: res.data };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { email: mb.emailAddress, ok: false, error: msg };
        }
      })
    );
    setResults(outcomes);
    setResyncing(false);
  };

  const allOk = results?.every((r) => r.ok);
  const anyFailed = results?.some((r) => !r.ok);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleResyncAll}
        disabled={resyncing}
        className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-fg-muted transition-colors hover:bg-fg-strong/[0.04] hover:text-fg-strong disabled:opacity-50"
      >
        {allOk ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
        ) : anyFailed ? (
          <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
        ) : (
          <RefreshCw className={cn('h-3.5 w-3.5', resyncing && 'animate-spin')} />
        )}
        {resyncing ? 'Resyncing…' : allOk ? 'Done — refresh page' : anyFailed ? 'Partial failure' : 'Resync all inboxes'}
      </button>
      {results && (
        <div className="flex flex-col gap-0.5 text-right">
          {results.map((r) => {
            const isAuthError = !r.ok && (r.error?.toLowerCase().includes('auth') || r.error?.toLowerCase().includes('oauth') || r.error?.toLowerCase().includes('credentials'));
            return (
              <div key={r.email} className="flex flex-col gap-0">
                <p className={`text-[11px] ${r.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {r.email.split('@')[0]}:{' '}
                  {r.ok
                    ? `✓ ${r.data?.messagesStored ?? 0} stored / ${r.data?.messagesSeen ?? 0} seen`
                    : `✗ ${r.error ?? 'failed'}`}
                </p>
                {isAuthError && (
                  <p className="text-[11px] text-amber-500">↳ Mailbox needs to be reconnected</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Main Dashboard ----------

export default function Dashboard({
  mailboxId,
  onSwitchToDrafts,
  onSwitchToCandidates,
  onOpenDraftForCandidate,
  onOpenDraft,
}: Props) {
  const queryClient = useQueryClient();

  const { data: candidatesData, isLoading: loadingCandidates } = useQuery({
    queryKey: ['candidates', { mailboxId }],
    queryFn: () => fetchCandidates({ mailboxId, limit: 500 }),
    staleTime: 30_000,
  });

  const { data: draftsData, isLoading: loadingDrafts } = useQuery({
    queryKey: ['drafts', { mailboxId }],
    queryFn: () => fetchDrafts({ limit: 500, mailboxId }),
    staleTime: 30_000,
  });

  const { data: mailboxesData, isLoading: loadingMailboxes } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: fetchMailboxes,
    staleTime: 60_000,
  });

  const { data: syncHealthData, isLoading: loadingSyncHealth, isError: syncHealthError } = useQuery({
    queryKey: ['sync-health'],
    queryFn: fetchSyncHealth,
    staleTime: 60_000,
    retry: 1,
  });

  const candidates = candidatesData?.data ?? [];
  const allDrafts = draftsData?.data ?? [];
  const mailboxes = mailboxesData?.data ?? [];
  const syncHealth = syncHealthData?.data ?? [];

  const awaitingReply = candidates.filter((c) => {
    const status =
      c.replyStatus ??
      (c.repliedAt ? 'REPLIED' : c.threads?.length ? 'AWAITING_REPLY' : 'NEW');
    return status === 'AWAITING_REPLY';
  }).length;
  const needsReview = candidates.filter((c) => c.status === 'NEEDS_REVIEW').length;
  const pendingDrafts = allDrafts.filter((d) => d.status === 'PENDING');
  const pendingDraftCount = pendingDrafts.length;

  // Top 5 most-recent pending drafts for the quick triage panel
  const triageDrafts = useMemo(
    () =>
      [...pendingDrafts]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
        .slice(0, 5),
    [pendingDrafts]
  );

  const mailboxCandidateMap: Record<string, Candidate[]> = {};
  for (const c of candidates) {
    if (!c.mailboxId) continue;
    if (!mailboxCandidateMap[c.mailboxId]) mailboxCandidateMap[c.mailboxId] = [];
    mailboxCandidateMap[c.mailboxId].push(c);
  }

  const pendingDraftCountByMailbox: Record<string, number> = {};
  for (const d of pendingDrafts) {
    const mbId = d.thread?.mailbox?.id;
    if (!mbId) continue;
    pendingDraftCountByMailbox[mbId] = (pendingDraftCountByMailbox[mbId] ?? 0) + 1;
  }

  const healthSummary = summarizeHealth(syncHealth);

  const approveMutation = useMutation({
    mutationFn: approveDraft,
    onSuccess: (_data, id) => {
      const d = pendingDrafts.find((x) => x.id === id);
      const who = d?.thread?.candidate?.name ?? 'candidate';
      toastSuccess(
        'Draft approved',
        `Saved as a Gmail draft — review in ${who}'s thread before sending.`
      );
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) => {
      if (isAlreadyResolvedError(err)) {
        toastSuccess('Already approved', 'This draft was approved in another session.');
        void queryClient.invalidateQueries({ queryKey: ['drafts'] });
        return;
      }
      toastError(
        'Could not approve draft',
        extractApiErrorMessage(err, 'Please try again.')
      );
    },
  });

  const handleOpenDraft = (draftId: string) => {
    if (onOpenDraft) {
      onOpenDraft(draftId);
      return;
    }
    const draft = pendingDrafts.find((d) => d.id === draftId);
    const cid = draft?.thread?.candidate?.id;
    if (cid && onOpenDraftForCandidate) {
      onOpenDraftForCandidate(cid);
      return;
    }
    onSwitchToDrafts?.();
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Hero — greeting + health pill */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-[28px]">
            Pipeline overview
          </h1>
          <p className="mt-1 text-[13.5px] text-fg-muted">
            Drafts to approve, replies waiting, and conversations needing
            attention.
          </p>
        </div>
        {!loadingSyncHealth && (
          syncHealthError
            ? <HealthPill summary={{ tone: 'neutral', label: 'Health data unavailable' }} />
            : <HealthPill summary={healthSummary} />
        )}
        {mailboxes.length > 0 && (
          <ResyncAllButton mailboxes={mailboxes} />
        )}
        <FixRepliedAtButton />
      </div>

      {/* Action pills — the new hero */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ActionPill
          testId="action-pill-drafts"
          count={pendingDraftCount}
          label="drafts pending"
          hint="Ready for one-click approval"
          icon={FileText}
          tone="accent"
          loading={loadingDrafts}
          onClick={onSwitchToDrafts}
        />
        <ActionPill
          testId="action-pill-awaiting"
          count={awaitingReply}
          label="awaiting reply"
          hint="Sent — no candidate response yet"
          icon={Clock}
          tone="amber"
          loading={loadingCandidates}
          onClick={() => onSwitchToCandidates?.('AWAITING_REPLY')}
        />
        <ActionPill
          testId="action-pill-review"
          count={needsReview}
          label="needs review"
          hint="Low-confidence classifications"
          icon={AlertTriangle}
          tone="emerald"
          loading={loadingCandidates}
          onClick={() => onSwitchToCandidates?.('NEEDS_REVIEW')}
        />
      </div>

      {/* Quick triage */}
      <section>
        <SectionHeader
          icon={Sparkles}
          iconClass="text-accent-600 dark:text-accent-300 bg-accent-500/10 ring-accent-500/20"
          title="Quick triage"
          count={pendingDraftCount}
          right={
            pendingDraftCount > 0 ? (
              <button
                onClick={onSwitchToDrafts}
                className="text-[12px] font-medium text-fg-muted transition-colors hover:text-fg-strong"
              >
                View all →
              </button>
            ) : null
          }
        />
        {loadingDrafts ? (
          <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface-raised/60">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-none" />
            ))}
          </div>
        ) : triageDrafts.length === 0 ? (
          <EmptyState
            compact
            icon={CheckCircle2}
            title="All caught up"
            description="No pending drafts right now. New drafts appear here as candidates reply."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface-raised/60">
            {triageDrafts.map((draft) => (
              <QuickTriageRow
                key={draft.id}
                draft={draft}
                onApprove={(id) => approveMutation.mutate(id)}
                onOpen={handleOpenDraft}
                approving={
                  approveMutation.isPending && approveMutation.variables === draft.id
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Account Pipelines (condensed) */}
      <section>
        <SectionHeader
          icon={Mail}
          iconClass="text-accent-600 dark:text-accent-300 bg-accent-500/10 ring-accent-500/20"
          title="Account pipelines"
          count={mailboxes.length}
        />
        {loadingMailboxes ? (
          <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface-raised/60">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-none" />
            ))}
          </div>
        ) : mailboxes.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No mailboxes connected"
            description="Connect a Gmail account to start syncing candidate replies and generating drafts automatically."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface-raised/60">
            {mailboxes.map((mailbox) => (
              <AccountRow
                key={mailbox.id}
                mailbox={mailbox}
                candidateCount={(mailboxCandidateMap[mailbox.id] ?? []).length}
                pendingDraftCount={pendingDraftCountByMailbox[mailbox.id] ?? 0}
                onSwitchToDrafts={onSwitchToDrafts}
              />
            ))}
          </div>
        )}
      </section>

      {/* Mailbox health (collapsible) */}
      <MailboxHealthAccordion
        data={syncHealth}
        loading={loadingSyncHealth}
        error={syncHealthError}
        onResync={async (mailboxId) => {
          try {
            await resyncMailbox(mailboxId);
            toastSuccess('Resync started', 'Checking the last 7 days of sent mail. Refresh the page in a minute to see updated drafts.');
          } catch {
            toastError('Resync failed', 'Could not trigger resync. Check that you are an admin.');
          }
        }}
      />
    </div>
  );
}
