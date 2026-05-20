import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchDrafts,
  approveDraft,
  discardDraft,
  sendDraft,
  updateDraft,
  regenerateDraft,
  type EmailDraft,
  type OriginalMessage,
} from '../lib/api';
import axios from 'axios';
import { cn, formatTimeAgo } from '../lib/utils';
import { Check, X, Send, RefreshCw, ChevronDown, ChevronUp, Pencil } from 'lucide-react';

const PREVIEW_LINE_LIMIT = 12;

/**
 * Strip HTML tags from a string and collapse whitespace.
 * We never trust candidate HTML — so when bodyText is missing we degrade
 * gracefully by flattening the HTML to plain text instead of rendering it.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
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

function getOriginalBodyPlainText(original: OriginalMessage): string {
  if (original.bodyText && original.bodyText.trim().length > 0) {
    return original.bodyText;
  }
  if (original.bodyHtml) {
    return htmlToPlainText(original.bodyHtml);
  }
  return '';
}

function formatOriginalDate(value: string): string {
  const d = new Date(value);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function OriginalMessageBlock({ original }: { original: OriginalMessage }) {
  const [showFull, setShowFull] = useState(false);
  const body = getOriginalBodyPlainText(original);
  const lines = body.split('\n');
  const isLong = lines.length > PREVIEW_LINE_LIMIT;
  const visibleBody = showFull || !isLong ? body : lines.slice(0, PREVIEW_LINE_LIMIT).join('\n');

  const senderLabel = original.fromName
    ? `${original.fromName} <${original.fromAddress}>`
    : original.fromAddress;

  return (
    <div className="bg-gray-950/80 border border-gray-800 border-l-2 border-l-zinc-500 rounded-lg p-3 mb-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-2">
        Original message
      </div>
      <div className="font-mono text-xs text-gray-400 space-y-0.5 mb-2">
        <div>
          <span className="text-gray-500">From: </span>
          <span className="text-gray-300">{senderLabel}</span>
        </div>
        <div>
          <span className="text-gray-500">Date: </span>
          <span className="text-gray-300">{formatOriginalDate(original.receivedAt)}</span>
        </div>
        <div>
          <span className="text-gray-500">Subject: </span>
          <span className="text-gray-300">{original.subject}</span>
        </div>
      </div>
      {body ? (
        <>
          <pre className="text-gray-300 text-sm whitespace-pre-wrap font-sans leading-relaxed">
            {visibleBody}
          </pre>
          {isLong && (
            <button
              onClick={() => setShowFull((v) => !v)}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {showFull ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      ) : (
        <p className="text-gray-500 text-sm italic">(no message body)</p>
      )}
    </div>
  );
}

const CLASS_COLORS: Record<EmailDraft['classification'], string> = {
  INTERESTED: 'bg-green-900/60 text-green-300 border border-green-700',
  NOT_INTERESTED: 'bg-red-900/60 text-red-300 border border-red-700',
  NEUTRAL: 'bg-gray-800 text-gray-300 border border-gray-600',
};

type DraftStatus = 'PENDING' | 'APPROVED' | 'SENT';

interface Props {
  mailboxId?: string;
}

function DraftCard({
  draft,
  onApprove,
  onDiscard,
  onSend,
  onUpdate,
  onRegenerate,
  regenerating,
  regenerateError,
}: {
  draft: EmailDraft;
  onApprove: (id: string) => void;
  onDiscard: (id: string) => void;
  onSend: (id: string) => void;
  onUpdate: (id: string, body: string) => void;
  onRegenerate: (id: string) => void;
  regenerating: boolean;
  regenerateError: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(draft.bodyText);

  const candidate = draft.thread?.candidate;
  const subject = draft.subject;

  const handleSaveEdit = () => {
    onUpdate(draft.id, editedBody);
    setEditing(false);
  };

  const isPending = draft.status === 'PENDING';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div
        className="flex items-start justify-between p-4 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-medium text-sm">
              {candidate?.name ?? 'Unknown Candidate'}
            </span>
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium',
                CLASS_COLORS[draft.classification]
              )}
            >
              {draft.classification.replace('_', ' ')}
            </span>
            <span className="text-gray-500 text-xs">
              {Math.round(draft.confidence * 100)}% confidence
            </span>
          </div>
          <p className="text-gray-400 text-sm truncate">{subject}</p>
          <p className="text-gray-500 text-xs mt-1 line-clamp-2">{draft.bodyText}</p>
        </div>
        <div
          className="flex items-center gap-1 ml-4 flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-gray-600 text-xs mr-1">{formatTimeAgo(draft.createdAt)}</span>
          {isPending && (
            <>
              <button
                onClick={() => onApprove(draft.id)}
                disabled={regenerating}
                title="Approve draft"
                aria-label="Approve draft"
                className="p-1.5 rounded-md text-green-400 hover:bg-green-900/40 hover:text-green-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                onClick={() => onDiscard(draft.id)}
                disabled={regenerating}
                title="Discard draft"
                aria-label="Discard draft"
                className="p-1.5 rounded-md text-red-400 hover:bg-red-900/40 hover:text-red-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X className="w-4 h-4" />
              </button>
              <button
                onClick={() => onRegenerate(draft.id)}
                disabled={regenerating}
                title={regenerating ? 'Regenerating…' : 'Regenerate draft'}
                aria-label="Regenerate draft"
                className="p-1.5 rounded-md text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={cn('w-4 h-4', regenerating && 'animate-spin')} />
              </button>
              <button
                onClick={() => {
                  setExpanded(true);
                  setEditing(true);
                }}
                disabled={regenerating}
                title="Edit draft"
                aria-label="Edit draft"
                className="p-1.5 rounded-md text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Pencil className="w-4 h-4" />
              </button>
            </>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-gray-500 ml-1" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-500 ml-1" />
          )}
        </div>
      </div>
      {isPending && regenerateError && (
        <div className="px-4 pb-3 -mt-2">
          <p className="text-red-400 text-xs">{regenerateError}</p>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-gray-800">
          <div className="px-4 pt-3 -mb-1">
            <p className="text-gray-500 text-xs">Will Cc: sofia@archive.com</p>
          </div>
          <div className="p-4">
            {draft.originalMessage && <OriginalMessageBlock original={draft.originalMessage} />}
            {editing ? (
              <div className="space-y-3">
                <textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg p-3 focus:outline-none focus:border-blue-500 min-h-32 resize-y"
                  rows={8}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveEdit}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors"
                  >
                    Save Changes
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setEditedBody(draft.bodyText);
                    }}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-gray-800/50 rounded-lg p-3">
                <pre className="text-gray-300 text-sm whitespace-pre-wrap font-sans">
                  {draft.bodyText}
                </pre>
              </div>
            )}
          </div>

          {draft.status === 'APPROVED' && (
            <div className="flex items-center gap-2 px-4 pb-4">
              <button
                onClick={() => onSend(draft.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
                Send Now
              </button>
              <button
                onClick={() => onDiscard(draft.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/60 hover:bg-red-800 text-red-300 text-sm rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Discard
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EmailDrafts({ mailboxId: _mailboxId }: Props) {
  const queryClient = useQueryClient();
  const [activeStatus, setActiveStatus] = useState<DraftStatus>('PENDING');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['drafts', activeStatus],
    queryFn: () => fetchDrafts({ status: activeStatus, limit: 100 }),
    staleTime: 15_000,
  });

  const approveMutation = useMutation({
    mutationFn: approveDraft,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const discardMutation = useMutation({
    mutationFn: discardDraft,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const sendMutation = useMutation({
    mutationFn: sendDraft,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, bodyText }: { id: string; bodyText: string }) =>
      updateDraft(id, { bodyText }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: regenerateDraft,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const regenerateErrorMessage = (id: string): string | null => {
    if (regenerateMutation.variables !== id) return null;
    if (regenerateMutation.isPending || !regenerateMutation.isError) return null;
    const err = regenerateMutation.error;
    if (axios.isAxiosError(err)) {
      const data = err.response?.data as { error?: string } | undefined;
      return data?.error ?? err.message;
    }
    return err instanceof Error ? err.message : 'Failed to regenerate draft';
  };

  const drafts = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const statusTabs: { id: DraftStatus; label: string }[] = [
    { id: 'PENDING', label: 'Pending' },
    { id: 'APPROVED', label: 'Approved' },
    { id: 'SENT', label: 'Sent' },
  ];

  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-red-400 mb-3">Failed to load drafts</p>
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
      {/* Status Tabs */}
      <div className="flex gap-1 bg-gray-900/50 border border-gray-800 rounded-lg p-1 w-fit">
        {statusTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveStatus(tab.id)}
            className={cn(
              'px-4 py-1.5 text-sm rounded-md transition-colors',
              activeStatus === tab.id
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:text-gray-200'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-gray-500 text-sm">{total} drafts</span>
      </div>

      {/* Drafts List */}
      <div className="space-y-3">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2"
              >
                <div className="h-4 bg-gray-800 animate-pulse rounded w-1/3" />
                <div className="h-3 bg-gray-800 animate-pulse rounded w-2/3" />
                <div className="h-10 bg-gray-800 animate-pulse rounded" />
              </div>
            ))
          : drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                onApprove={(id) => approveMutation.mutate(id)}
                onDiscard={(id) => discardMutation.mutate(id)}
                onSend={(id) => sendMutation.mutate(id)}
                onUpdate={(id, bodyText) => updateMutation.mutate({ id, bodyText })}
                onRegenerate={(id) => regenerateMutation.mutate(id)}
                regenerating={
                  regenerateMutation.isPending && regenerateMutation.variables === draft.id
                }
                regenerateError={regenerateErrorMessage(draft.id)}
              />
            ))}

        {!isLoading && drafts.length === 0 && (
          <div className="text-center py-12 text-gray-500 bg-gray-900 border border-gray-800 rounded-xl">
            No {activeStatus.toLowerCase()} drafts
          </div>
        )}
      </div>
    </div>
  );
}
