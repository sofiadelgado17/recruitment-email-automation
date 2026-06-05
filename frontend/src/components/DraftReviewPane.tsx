import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { cn, formatTimeAgo, isOverdue } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ClassificationBadge, StatusBadge, type StatusVariant } from './ui/StatusBadge';
import { Button } from './ui/button';
import {
  Check,
  X,
  Send,
  RefreshCw,
  Pencil,
  Mail,
  ChevronLeft,
  TriangleAlert,
} from 'lucide-react';
import type { EmailDraft, OriginalMessage } from '../lib/api';
import { toastError } from '../lib/toast';

interface Props {
  draft: EmailDraft | null;
  open: boolean;
  onClose: () => void;
  onApprove: (id: string) => void;
  onDiscard: (id: string) => void;
  onSend: (id: string) => void;
  onUpdate: (id: string, body: string) => void;
  onRegenerate: (id: string) => void;
  regenerating: boolean;
  regenerateError: string | null;
  approving?: boolean;
  sending?: boolean;
  /**
   * Imperative request to open the editor (driven by the `e` shortcut).
   * The pane resets this internally — parent only needs to bump a counter.
   */
  editRequestNonce?: number;
}

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
  const body = getOriginalBodyPlainText(original);
  const senderLabel = original.fromName
    ? `${original.fromName} <${original.fromAddress}>`
    : original.fromAddress;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-base/40">
      <div className="border-b border-line-soft bg-fg-strong/[0.015] px-4 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-fg-muted">
          <Mail className="h-3 w-3" />
          Original message
        </div>
        <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-relaxed">
          <div className="flex">
            <span className="w-14 flex-shrink-0 text-fg-subtle">From</span>
            <span className="truncate text-fg-default">{senderLabel}</span>
          </div>
          <div className="flex">
            <span className="w-14 flex-shrink-0 text-fg-subtle">Date</span>
            <span className="text-fg-default">
              {formatOriginalDate(original.receivedAt)}
            </span>
          </div>
          <div className="flex">
            <span className="w-14 flex-shrink-0 text-fg-subtle">Subject</span>
            <span className="text-fg-default">{original.subject}</span>
          </div>
        </div>
      </div>
      <div className="border-l-2 border-accent-500/40 px-4 py-3">
        {body ? (
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg-default">
            {body}
          </pre>
        ) : (
          <p className="text-[13px] italic text-fg-subtle">(no message body)</p>
        )}
      </div>
    </div>
  );
}

function DiscardConfirm({
  onConfirm,
  disabled,
}: {
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <button
              disabled={disabled}
              aria-label="Discard draft"
              className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-3 py-2 text-[13px] font-medium text-rose-700 ring-1 ring-inset ring-rose-500/20 transition-colors hover:bg-rose-500/15 dark:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Discard
            </button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Discard draft</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard draft?</AlertDialogTitle>
          <AlertDialogDescription>
            The draft will not be sent. New emails from this candidate will
            still generate drafts unless you ignore them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
          >
            Discard draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function DraftReviewPane({
  draft,
  open,
  onClose,
  onApprove,
  onDiscard,
  onSend,
  onUpdate,
  onRegenerate,
  regenerating,
  regenerateError,
  approving = false,
  sending = false,
  editRequestNonce,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editedBody, setEditedBody] = useState(draft?.bodyText ?? '');
  const lastEditNonce = useRef(editRequestNonce);
  // Snapshot of (draft id, original body, in-progress edit, editing flag) so
  // we can detect when a draft switch is about to discard unsaved edits.
  const prevDraftRef = useRef<{
    id: string | undefined;
    originalBody: string;
    editedBody: string;
    editing: boolean;
  }>({
    id: draft?.id,
    originalBody: draft?.bodyText ?? '',
    editedBody: draft?.bodyText ?? '',
    editing: false,
  });

  // Keep the snapshot in sync with the editor's current state (without
  // running on every keystroke — refs don't trigger renders).
  useEffect(() => {
    if (draft?.id === prevDraftRef.current.id) {
      prevDraftRef.current.editedBody = editedBody;
      prevDraftRef.current.editing = editing;
    }
  }, [editedBody, editing, draft?.id]);

  // When the active draft changes, exit edit mode and resync body. If the
  // user had unsaved edits, surface a warning toast (Fix #4) — the alternative
  // would be a blocking confirm, but a toast matches the existing style.
  useEffect(() => {
    const prev = prevDraftRef.current;
    if (
      prev.editing &&
      prev.id !== undefined &&
      prev.id !== draft?.id &&
      prev.editedBody !== prev.originalBody
    ) {
      toastError(
        'Unsaved changes discarded',
        'You switched to another draft before saving your edits.'
      );
    }
    setEditing(false);
    setEditedBody(draft?.bodyText ?? '');
    prevDraftRef.current = {
      id: draft?.id,
      originalBody: draft?.bodyText ?? '',
      editedBody: draft?.bodyText ?? '',
      editing: false,
    };
  }, [draft?.id, draft?.bodyText]);

  // Honor imperative edit requests (driven by `e` keyboard shortcut)
  useEffect(() => {
    if (editRequestNonce === undefined) return;
    if (editRequestNonce === lastEditNonce.current) return;
    lastEditNonce.current = editRequestNonce;
    if (draft?.status === 'PENDING') {
      setEditing(true);
    }
  }, [editRequestNonce, draft?.status]);

  if (!open) return null;

  const candidate = draft?.thread?.candidate;
  const isPending = draft?.status === 'PENDING';
  const isApproved = draft?.status === 'APPROVED';
  // Light "waiting 2+ days" cue mirroring the list-row flag.
  const waitingSince = draft?.originalMessage?.receivedAt ?? draft?.createdAt;
  const overdue = waitingSince ? isOverdue(waitingSince) : false;

  const handleSaveEdit = () => {
    if (!draft) return;
    onUpdate(draft.id, editedBody);
    setEditing(false);
  };

  return (
    <>
      {/* Overlay (mobile shows backdrop; desktop the pane is a sheet that doesn't cover the list, so the overlay is mobile-only) */}
      <div
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm animate-fade-in sm:hidden"
      />

      <aside
        data-draft-pane="true"
        role="dialog"
        aria-label={
          candidate ? `Draft for ${candidate.name}` : 'Draft review'
        }
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface-raised/95 shadow-2xl backdrop-blur-xl animate-fade-in sm:w-[640px]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={onClose}
                aria-label="Close draft pane"
                className="-ml-1 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fg-strong/[0.06] hover:text-fg-strong sm:hidden"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {candidate && (
                <StatusBadge
                  status={candidate.status as StatusVariant}
                  size="sm"
                />
              )}
              {draft && (
                <ClassificationBadge
                  classification={draft.classification}
                  confidence={draft.confidence}
                />
              )}
              {draft && (
                <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                  {formatTimeAgo(draft.createdAt)}
                </span>
              )}
              {draft && overdue && waitingSince && (
                <span
                  data-testid="overdue-indicator"
                  title={`Waiting ${formatTimeAgo(waitingSince)}`}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 dark:text-rose-300"
                >
                  <TriangleAlert className="h-3 w-3" />
                  2+ days waiting
                </span>
              )}
            </div>
            <h2 className="truncate font-display text-[17px] font-semibold tracking-tight text-fg-strong">
              {candidate?.name ?? 'Unknown candidate'}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[12px] text-fg-muted">
              {candidate?.email ?? '—'}
            </p>
            {candidate?.role ? (
              <div className="mt-1.5">
                <span
                  data-testid="role-pill"
                  className="inline-block max-w-full truncate rounded-md bg-accent-500/8 px-2 py-0.5 text-[11.5px] font-medium text-accent-600 ring-1 ring-inset ring-accent-500/15 dark:text-accent-300"
                  title={candidate.role}
                >
                  {candidate.role}
                </span>
              </div>
            ) : null}
            <p className="mt-2.5 truncate text-[13px] text-fg-default">
              {draft?.subject}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close draft pane"
            className="hidden h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fg-strong/[0.06] hover:text-fg-strong sm:flex"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!draft ? (
            <div className="flex flex-col gap-3">
              <div className="h-24 skeleton rounded-xl" />
              <div className="h-40 skeleton rounded-xl" />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {draft.originalMessage && (
                <OriginalMessageBlock original={draft.originalMessage} />
              )}

              <div>
                <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-fg-muted">
                  <span className="inline-block h-px w-3 bg-accent-500/70" />
                  Your reply
                </p>
                <p className="mb-2 text-[11px] text-fg-subtle">
                  Will Cc{' '}
                  <span className="font-mono text-fg-muted">
                    sofia@archive.com
                  </span>
                </p>
                {editing ? (
                  <div className="flex flex-col gap-3">
                    <textarea
                      value={editedBody}
                      onChange={(e) => setEditedBody(e.target.value)}
                      className="min-h-48 w-full resize-y rounded-lg border border-line-strong bg-surface-base/60 p-3 text-[13.5px] leading-relaxed text-fg-default focus:border-accent-400 focus:outline-none"
                      rows={12}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button
                        onClick={handleSaveEdit}
                        className="bg-accent-500 text-white hover:bg-accent-400"
                      >
                        Save changes
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEditing(false);
                          setEditedBody(draft.bodyText);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : draft.bodyHtml ? (
                  <div className="rounded-xl border border-line bg-surface-base/40 overflow-hidden">
                    <iframe
                      srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13.5px;line-height:1.6;color:#1a1a1a;margin:16px;padding:0;}a{color:#0066cc;}p{margin:0 0 1em}</style></head><body>${draft.bodyHtml}</body></html>`}
                      sandbox="allow-same-origin"
                      className="w-full border-0"
                      style={{ minHeight: '160px' }}
                      onLoad={(e) => {
                        const iframe = e.currentTarget;
                        if (iframe.contentDocument?.body) {
                          iframe.style.height = iframe.contentDocument.body.scrollHeight + 32 + 'px';
                        }
                      }}
                      title="Draft preview"
                    />
                  </div>
                ) : (
                  <div className="rounded-xl border border-line bg-surface-base/40 p-4">
                    <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-fg-default">
                      {draft.bodyText}
                    </pre>
                  </div>
                )}
              </div>

              {regenerateError && (
                <p className="text-[12px] text-rose-700 dark:text-rose-300">{regenerateError}</p>
              )}
            </div>
          )}
        </div>

        {/* Action bar */}
        {draft && (isPending || isApproved) && (
          <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-base/80 px-5 py-3.5">
            <div className="flex items-center gap-2">
              {isPending && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onApprove(draft.id)}
                        disabled={regenerating || editing || approving}
                        aria-label="Approve draft"
                        className={cn(
                          'flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3.5 py-2 text-[13px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/25 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300 dark:hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50'
                        )}
                      >
                        {approving ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {approving ? 'Approving…' : 'Approve — saves as Gmail draft (a)'}
                    </TooltipContent>
                  </Tooltip>
                  <DiscardConfirm
                    onConfirm={() => onDiscard(draft.id)}
                    disabled={regenerating || approving}
                  />
                </>
              )}
              {isApproved && (
                <>
                  <button
                    onClick={() => onSend(draft.id)}
                    disabled={sending}
                    aria-label="Send draft"
                    className="flex items-center gap-1.5 rounded-lg bg-accent-500 px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sending ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Send now
                  </button>
                  <button
                    onClick={() => onDiscard(draft.id)}
                    disabled={sending}
                    className="flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-3.5 py-2 text-[13px] font-medium text-rose-700 ring-1 ring-inset ring-rose-500/20 transition-colors hover:bg-rose-500/15 dark:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Discard
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              {isPending && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onRegenerate(draft.id)}
                        disabled={regenerating || editing}
                        aria-label="Regenerate draft"
                        className="flex size-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fg-strong/[0.06] hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RefreshCw
                          className={cn('h-4 w-4', regenerating && 'animate-spin')}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {regenerating ? 'Regenerating…' : 'Regenerate (r)'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setEditing(true)}
                        disabled={regenerating || editing}
                        aria-label="Edit draft body"
                        className="flex size-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-fg-strong/[0.06] hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Edit body (e)</TooltipContent>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
