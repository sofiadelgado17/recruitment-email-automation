import { useQuery } from '@tanstack/react-query';
import {
  fetchCandidates,
  fetchMailboxes,
  fetchDrafts,
  fetchSyncHealth,
  type Candidate,
  type Mailbox,
  type EmailDraft,
  type MailboxSyncHealth,
} from '../lib/api';
import { cn } from '../lib/utils';
import { Mail, Users, Send, Clock, AlertCircle, CheckCircle2, XCircle, MinusCircle, FileText, AlertTriangle, Activity } from 'lucide-react';

interface Props {
  mailboxId?: string;
  onRefetchMailboxes: () => void;
  onSwitchToDrafts?: () => void;
}

// ---------- helpers ----------

function statusColor(status: string) {
  switch (status) {
    case 'INTERESTED': return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'NOT_INTERESTED': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'REPLIED': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'PENDING': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'NEEDS_REVIEW': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case 'IGNORED': return 'bg-gray-700/40 text-gray-500 border-gray-700/40';
    default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
  }
}

function StatusBadge({ status }: { status: string }) {
  const Icon =
    status === 'INTERESTED' ? CheckCircle2 :
    status === 'NOT_INTERESTED' ? XCircle :
    status === 'REPLIED' ? Send :
    status === 'NEEDS_REVIEW' ? AlertTriangle :
    MinusCircle;

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border', statusColor(status))}>
      <Icon className="w-3 h-3" />
      {status.replace('_', ' ')}
    </span>
  );
}

// ---------- Metric Card ----------

function MetricCard({
  label,
  value,
  icon: Icon,
  color,
  loading,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  loading?: boolean;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-gray-400 text-sm">{label}</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 bg-gray-800 animate-pulse rounded" />
          ) : (
            <p className="text-3xl font-bold text-white mt-1">{value}</p>
          )}
        </div>
        <div className={cn('p-2.5 rounded-lg', color)}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
    </div>
  );
}

// ---------- Account Pipeline Card ----------

function AccountCard({
  mailbox,
  candidates,
  drafts,
  onSwitchToDrafts,
}: {
  mailbox: Mailbox;
  candidates: Candidate[];
  drafts: EmailDraft[];
  onSwitchToDrafts?: () => void;
}) {
  const interested = candidates.filter((c) => c.status === 'INTERESTED').length;
  const notInterested = candidates.filter((c) => c.status === 'NOT_INTERESTED').length;
  const replied = candidates.filter((c) => c.status === 'REPLIED').length;
  const pending = candidates.filter((c) => c.status === 'PENDING' || c.status === 'NEUTRAL').length;

  // Drafts pending for candidates in this mailbox
  const pendingDraftCount = drafts.filter((d) => {
    const threadMailbox = d.thread?.mailbox;
    return d.status === 'PENDING' && threadMailbox?.id === mailbox.id;
  }).length;

  const total = candidates.length;

  function Bar({ count, color }: { count: number; color: string }) {
    if (total === 0 || count === 0) return null;
    return (
      <div
        className={cn('h-2 rounded-full', color)}
        style={{ width: `${Math.max(4, (count / total) * 100)}%` }}
        title={`${count}`}
      />
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-blue-600/20 rounded-lg">
            <Mail className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <p className="text-white font-medium text-sm truncate max-w-[180px]">{mailbox.emailAddress}</p>
            <p className="text-gray-500 text-xs">{total} candidate{total !== 1 ? 's' : ''}</p>
          </div>
        </div>
        {pendingDraftCount > 0 && (
          <button
            onClick={onSwitchToDrafts}
            className="flex items-center gap-1 px-2 py-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded-full text-xs font-medium hover:bg-red-500/30 transition-colors"
          >
            <AlertCircle className="w-3 h-3" />
            {pendingDraftCount} need{pendingDraftCount === 1 ? 's' : ''} reply
          </button>
        )}
      </div>

      {/* Status bar */}
      <div className="space-y-2">
        <div className="flex gap-1 h-2 bg-gray-800 rounded-full overflow-hidden">
          <Bar count={interested} color="bg-green-500" />
          <Bar count={pending} color="bg-yellow-500" />
          <Bar count={replied} color="bg-blue-500" />
          <Bar count={notInterested} color="bg-red-500" />
        </div>
        <div className="flex gap-3 text-xs text-gray-500 flex-wrap">
          {interested > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />{interested} interested</span>}
          {pending > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />{pending} pending</span>}
          {replied > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />{replied} replied</span>}
          {notInterested > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{notInterested} not interested</span>}
        </div>
      </div>
    </div>
  );
}

// ---------- Mailbox Health ----------

function watchExpiryTone(hours: number | null): string {
  if (hours === null) return 'text-gray-500';
  if (hours < 0) return 'text-red-400';
  if (hours < 24) return 'text-amber-400';
  return 'text-gray-400';
}

function formatWatchExpiry(h: number | null): string {
  if (h === null) return 'no watch';
  if (h < 0) return `expired ${Math.abs(Math.round(h))}h ago`;
  if (h < 1) return `< 1h`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function MailboxHealthSection({
  data,
  loading,
}: {
  data: MailboxSyncHealth[];
  loading: boolean;
}) {
  if (!loading && data.length === 0) return null;
  const anyDrift = data.some((d) => d.lastReconciliationFoundMissing > 0);
  const anyWebhookErrors = data.some((d) => d.webhookErrorsLast24h > 0);

  return (
    <div>
      <h2 className="text-white font-semibold text-base mb-3 flex items-center gap-2">
        <Activity className="w-4 h-4 text-emerald-400" />
        Mailbox Health
        {anyDrift && (
          <span className="ml-1 px-2 py-0.5 bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-full text-xs font-medium">
            drift detected
          </span>
        )}
        {anyWebhookErrors && (
          <span className="ml-1 px-2 py-0.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded-full text-xs font-medium">
            webhook errors today
          </span>
        )}
      </h2>
      {loading ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 h-20 animate-pulse" />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">Mailbox</th>
                <th className="text-left px-4 py-2 font-medium">Watch expires</th>
                <th className="text-left px-4 py-2 font-medium hidden sm:table-cell">Msgs / 24h</th>
                <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Last reconciled</th>
                <th className="text-left px-4 py-2 font-medium">Missing found</th>
                <th className="text-left px-4 py-2 font-medium">Webhook errors / 24h</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.map((row) => {
                const driftTone =
                  row.lastReconciliationFoundMissing > 0 ? 'text-amber-400' : 'text-gray-500';
                const webhookErrTone =
                  row.webhookErrorsLast24h > 0 ? 'text-red-400' : 'text-gray-500';
                const recon = row.lastReconciliationAt
                  ? new Date(row.lastReconciliationAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '—';
                return (
                  <tr key={row.mailboxId} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-2">
                      <p className="text-white font-mono truncate max-w-[200px]">
                        {row.emailAddress}
                      </p>
                      {!row.isActive && (
                        <span className="text-red-400 text-[10px]">inactive</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2 font-mono',
                        watchExpiryTone(row.watchExpiresInHours)
                      )}
                    >
                      {formatWatchExpiry(row.watchExpiresInHours)}
                    </td>
                    <td className="px-4 py-2 text-gray-300 hidden sm:table-cell">
                      {row.messagesLast24h}
                    </td>
                    <td className="px-4 py-2 text-gray-400 hidden md:table-cell">{recon}</td>
                    <td className={cn('px-4 py-2 font-mono', driftTone)}>
                      {row.lastReconciliationFoundMissing}
                    </td>
                    <td className={cn('px-4 py-2 font-mono', webhookErrTone)}>
                      {row.webhookErrorsLast24h}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Main Dashboard ----------

export default function Dashboard({ mailboxId, onSwitchToDrafts }: Props) {
  const { data: candidatesData, isLoading: loadingCandidates } = useQuery({
    queryKey: ['candidates', { mailboxId }],
    queryFn: () => fetchCandidates({ mailboxId, limit: 1000 }),
    staleTime: 30_000,
  });

  const { data: draftsData, isLoading: loadingDrafts } = useQuery({
    queryKey: ['drafts'],
    queryFn: () => fetchDrafts({ limit: 1000 }),
    staleTime: 30_000,
  });

  const { data: mailboxesData, isLoading: loadingMailboxes } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: fetchMailboxes,
    staleTime: 60_000,
  });

  // Mailbox sync health (watch-expiry, reconciliation drift, message counts).
  // Tolerant of failure — if the endpoint 500s the section just stays empty.
  const { data: syncHealthData, isLoading: loadingSyncHealth } = useQuery({
    queryKey: ['sync-health'],
    queryFn: fetchSyncHealth,
    staleTime: 60_000,
    retry: false,
  });

  const candidates = candidatesData?.data ?? [];
  const allDrafts = draftsData?.data ?? [];
  const mailboxes = mailboxesData?.data ?? [];

  const total = candidates.length;
  const needReply = candidates.filter((c) => c.status === 'INTERESTED').length;
  const awaitingReply = candidates.filter((c) => {
    const status = c.replyStatus ?? (c.repliedAt ? 'REPLIED' : c.threads?.length ? 'AWAITING_REPLY' : 'NEW');
    return status === 'AWAITING_REPLY';
  }).length;
  const needsReview = candidates.filter((c) => c.status === 'NEEDS_REVIEW').length;
  const pendingDrafts = allDrafts.filter((d) => d.status === 'PENDING').length;

  // "Sent this week" = drafts sent within the last 7 days
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sentThisWeek = allDrafts.filter(
    (d) => d.status === 'SENT' && d.sentAt && new Date(d.sentAt) >= oneWeekAgo
  ).length;

  // Build per-mailbox candidate lists
  const mailboxCandidateMap: Record<string, Candidate[]> = {};
  for (const c of candidates) {
    if (!c.mailboxId) continue;
    if (!mailboxCandidateMap[c.mailboxId]) mailboxCandidateMap[c.mailboxId] = [];
    mailboxCandidateMap[c.mailboxId].push(c);
  }

  // Build a set of candidate emails that have a PENDING draft
  const candidateEmailsWithDraft = new Set<string>();
  for (const d of allDrafts) {
    if (d.status === 'PENDING' && d.thread?.candidate?.email) {
      candidateEmailsWithDraft.add(d.thread.candidate.email);
    }
  }

  // Priority queue: INTERESTED candidates sorted by updatedAt desc
  const priorityQueue = candidates
    .filter((c) => c.status === 'INTERESTED')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Map mailbox id -> mailbox
  const mailboxById: Record<string, Mailbox> = {};
  for (const m of mailboxes) {
    mailboxById[m.id] = m;
  }

  return (
    <div className="space-y-8">
      {/* Section 3: Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <MetricCard
          label="Total Candidates"
          value={total}
          icon={Users}
          color="bg-blue-600"
          loading={loadingCandidates}
        />
        <MetricCard
          label="Need Reply"
          value={needReply}
          icon={AlertCircle}
          color="bg-green-600"
          loading={loadingCandidates}
        />
        <MetricCard
          label="Awaiting Reply"
          value={awaitingReply}
          icon={Clock}
          color="bg-yellow-600"
          loading={loadingCandidates}
        />
        <MetricCard
          label="Needs Review"
          value={needsReview}
          icon={AlertTriangle}
          color="bg-amber-600"
          loading={loadingCandidates}
        />
        <MetricCard
          label="Drafts Pending"
          value={pendingDrafts}
          icon={FileText}
          color="bg-purple-600"
          loading={loadingDrafts}
        />
        <MetricCard
          label="Sent This Week"
          value={sentThisWeek}
          icon={Send}
          color="bg-teal-600"
          loading={loadingDrafts}
        />
      </div>

      {/* Section 1: Account Pipeline Cards */}
      <div>
        <h2 className="text-white font-semibold text-base mb-3 flex items-center gap-2">
          <Mail className="w-4 h-4 text-blue-400" />
          Account Pipelines
        </h2>
        {loadingMailboxes ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-5 h-28 animate-pulse" />
            ))}
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
            No mailboxes connected. Add a mailbox to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {mailboxes.map((mailbox) => (
              <AccountCard
                key={mailbox.id}
                mailbox={mailbox}
                candidates={mailboxCandidateMap[mailbox.id] ?? []}
                drafts={allDrafts}
                onSwitchToDrafts={onSwitchToDrafts}
              />
            ))}
          </div>
        )}
      </div>

      {/* Section 1b: Mailbox Health (watch-expiry + reconciliation drift) */}
      <MailboxHealthSection
        data={syncHealthData?.data ?? []}
        loading={loadingSyncHealth}
      />

      {/* Section 2: Priority Queue — Candidates Needing Replies */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold text-base flex items-center gap-2">
            <Clock className="w-4 h-4 text-yellow-400" />
            Candidates Needing Replies
            {needReply > 0 && (
              <span className="ml-1 px-2 py-0.5 bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-full text-xs font-medium">
                {needReply}
              </span>
            )}
          </h2>
          {pendingDrafts > 0 && (
            <button
              onClick={onSwitchToDrafts}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              View all drafts →
            </button>
          )}
        </div>

        {loadingCandidates ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-4 h-14 animate-pulse" />
            ))}
          </div>
        ) : priorityQueue.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
            No candidates currently need a reply.
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-4 py-3 text-gray-400 font-medium">Candidate</th>
                  <th className="text-left px-4 py-3 text-gray-400 font-medium hidden sm:table-cell">Recruiter Mailbox</th>
                  <th className="text-left px-4 py-3 text-gray-400 font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-gray-400 font-medium hidden md:table-cell">Notes</th>
                  <th className="text-left px-4 py-3 text-gray-400 font-medium">Draft</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {priorityQueue.map((candidate) => {
                  const mailbox = candidate.mailboxId ? mailboxById[candidate.mailboxId] : undefined;
                  const hasDraft = candidateEmailsWithDraft.has(candidate.email);
                  return (
                    <tr key={candidate.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-white font-medium">{candidate.name}</p>
                        <p className="text-gray-500 text-xs">{candidate.email}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {mailbox ? (
                          <span className="text-gray-300 text-xs font-mono">{mailbox.emailAddress}</span>
                        ) : (
                          <span className="text-gray-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={candidate.status} />
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {candidate.notes ? (
                          <span className="text-gray-400 text-xs line-clamp-2 max-w-xs">{candidate.notes}</span>
                        ) : (
                          <span className="text-gray-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {hasDraft ? (
                          <button
                            onClick={onSwitchToDrafts}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-full text-xs font-medium hover:bg-purple-500/30 transition-colors"
                          >
                            <FileText className="w-3 h-3" />
                            Draft Ready
                          </button>
                        ) : (
                          <span className="text-gray-600 text-xs">Pending</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
