import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCandidates,
  fetchMessages,
  updateCandidate,
  ignoreCandidate,
  type Candidate,
  type EmailThread,
} from '../lib/api';
import { cn, formatTimeAgo } from '../lib/utils';
import { ChevronDown, ChevronUp, RefreshCw, Mail, Building2, EyeOff } from 'lucide-react';

const STATUS_COLORS: Record<Candidate['status'], string> = {
  INTERESTED: 'bg-green-900/60 text-green-300 border border-green-700',
  NOT_INTERESTED: 'bg-red-900/60 text-red-300 border border-red-700',
  NEUTRAL: 'bg-gray-800 text-gray-300 border border-gray-600',
  PENDING: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
  REPLIED: 'bg-blue-900/60 text-blue-300 border border-blue-700',
  NEEDS_REVIEW: 'bg-amber-900/60 text-amber-300 border border-amber-600',
  IGNORED: 'bg-gray-900/60 text-gray-500 border border-gray-700',
};

const STATUS_LABELS: Record<Candidate['status'], string> = {
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not Interested',
  NEUTRAL: 'Neutral',
  PENDING: 'Pending',
  REPLIED: 'Replied',
  NEEDS_REVIEW: 'Needs Review',
  IGNORED: 'Ignored',
};

function ReplyStatusBadge({ candidate }: { candidate: Candidate }) {
  const derived: NonNullable<Candidate['replyStatus']> =
    candidate.replyStatus ??
    (candidate.repliedAt ? 'REPLIED' : candidate.threads?.length ? 'AWAITING_REPLY' : 'NEW');

  if (derived === 'REPLIED') {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/60 text-green-300 border border-green-700">
        Replied
      </span>
    );
  }
  if (derived === 'AWAITING_REPLY') {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-900/60 text-yellow-300 border border-yellow-700">
        Awaiting Reply
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-600">
      New
    </span>
  );
}

function ThreadView({ threadId }: { threadId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => fetchMessages(threadId),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 bg-gray-800 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const thread = data?.data as EmailThread | undefined;
  const messages = thread?.messages ?? [];

  return (
    <div className="p-4 space-y-3 max-h-64 overflow-y-auto">
      {messages.length === 0 ? (
        <p className="text-gray-500 text-sm">No messages yet</p>
      ) : (
        messages.map((msg) => (
          <div key={msg.id} className="bg-gray-800/60 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-gray-200">
                {msg.fromName ?? msg.fromAddress}
              </span>
              <span className="text-xs text-gray-500">{formatTimeAgo(msg.receivedAt)}</span>
            </div>
            <p className="text-xs text-gray-400 line-clamp-3">{msg.bodyText}</p>
          </div>
        ))
      )}
    </div>
  );
}

interface Props {
  mailboxId?: string;
}

export default function CandidateTable({ mailboxId }: Props) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const includeIgnored = statusFilter === 'IGNORED' || statusFilter === '__ALL__';
  const apiStatus =
    statusFilter === '__ALL__' || statusFilter === '' ? undefined : statusFilter;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['candidates', { mailboxId, status: statusFilter }],
    queryFn: () =>
      fetchCandidates({
        mailboxId,
        status: apiStatus,
        includeIgnored,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Candidate['status'] }) =>
      updateCandidate(id, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  const ignoreMutation = useMutation({
    mutationFn: (id: string) => ignoreCandidate(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const handleIgnore = (candidate: Candidate) => {
    const confirmed = window.confirm(
      `Ignore ${candidate.name}? They will be hidden from the dashboard and any pending drafts will be discarded.`
    );
    if (!confirmed) return;
    ignoreMutation.mutate(candidate.id);
  };

  const candidates = data?.data ?? [];

  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-red-400 mb-3">Failed to load candidates</p>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 mx-auto text-sm text-gray-400 hover:text-white"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
        >
          <option value="">Active (default)</option>
          <option value="__ALL__">All (incl. ignored)</option>
          <option value="PENDING">Pending</option>
          <option value="INTERESTED">Interested</option>
          <option value="NOT_INTERESTED">Not Interested</option>
          <option value="NEUTRAL">Neutral</option>
          <option value="REPLIED">Replied</option>
          <option value="NEEDS_REVIEW">Needs Review</option>
          <option value="IGNORED">Ignored</option>
        </select>
        <span className="text-gray-500 text-sm">
          {data?.meta.total ?? 0} candidates
        </span>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Name
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Email
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider hidden md:table-cell">
                Company
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Status
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Reply
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider hidden lg:table-cell">
                Last Activity
              </th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-800 animate-pulse rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              : candidates.map((candidate) => (
                  <>
                    <tr
                      key={candidate.id}
                      className="hover:bg-gray-800/40 cursor-pointer transition-colors"
                      onClick={() =>
                        setExpandedId(
                          expandedId === candidate.id ? null : candidate.id
                        )
                      }
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {expandedId === candidate.id ? (
                            <ChevronUp className="w-4 h-4 text-gray-500" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-500" />
                          )}
                          <span className="text-white font-medium text-sm">
                            {candidate.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-gray-300 text-sm">
                          <Mail className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                          {candidate.email}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {candidate.company ? (
                          <div className="flex items-center gap-1.5 text-gray-400 text-sm">
                            <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
                            {candidate.company}
                          </div>
                        ) : (
                          <span className="text-gray-600 text-sm">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded-full text-xs font-medium',
                            STATUS_COLORS[candidate.status]
                          )}
                        >
                          {STATUS_LABELS[candidate.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ReplyStatusBadge candidate={candidate} />
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-gray-400 text-sm">
                          {candidate.threads?.[0]
                            ? formatTimeAgo(candidate.threads[0].lastMessageAt)
                            : formatTimeAgo(candidate.updatedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <select
                            value={candidate.status}
                            onChange={(e) =>
                              updateMutation.mutate({
                                id: candidate.id,
                                status: e.target.value as Candidate['status'],
                              })
                            }
                            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
                          >
                            <option value="PENDING">Pending</option>
                            <option value="INTERESTED">Interested</option>
                            <option value="NOT_INTERESTED">Not Interested</option>
                            <option value="NEUTRAL">Neutral</option>
                            <option value="REPLIED">Replied</option>
                            <option value="NEEDS_REVIEW">Needs Review</option>
                            <option value="IGNORED">Ignored</option>
                          </select>
                          {candidate.status !== 'IGNORED' && (
                            <button
                              onClick={() => handleIgnore(candidate)}
                              disabled={
                                ignoreMutation.isPending &&
                                ignoreMutation.variables === candidate.id
                              }
                              title="Ignore candidate (mute future drafts; reversible)"
                              aria-label="Ignore candidate"
                              className="p-1.5 rounded-md text-gray-500 hover:bg-red-900/40 hover:text-red-400 transition-colors disabled:opacity-50"
                            >
                              <EyeOff className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedId === candidate.id &&
                      candidate.threads &&
                      candidate.threads.length > 0 && (
                        <tr key={`${candidate.id}-expanded`}>
                          <td
                            colSpan={7}
                            className="bg-gray-950/50 border-b border-gray-800"
                          >
                            <ThreadView threadId={candidate.threads[0].id} />
                          </td>
                        </tr>
                      )}
                  </>
                ))}
          </tbody>
        </table>

        {!isLoading && candidates.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            No candidates found
          </div>
        )}
      </div>
    </div>
  );
}
