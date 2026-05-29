import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Skeleton } from './ui/skeleton';
import { Button } from './ui/button';
import {
  fetchDrafts,
  approveDraft,
  discardDraft,
  sendDraft,
  updateDraft,
  regenerateDraft,
  type EmailDraft,
} from '../lib/api';
import { cn, formatTimeAgo } from '../lib/utils';
import {
  toastSuccess,
  toastError,
  toastLoading,
  dismissToast,
  extractApiErrorMessage,
  isAlreadyResolvedError,
} from '../lib/toast';
import {
  RefreshCw,
  Inbox,
  FileText,
  Sparkles,
  Keyboard,
  ChevronRight,
} from 'lucide-react';
import DraftReviewPane from './DraftReviewPane';
import { useDraftKeyboardShortcuts } from '../hooks/useDraftKeyboardShortcuts';

type DraftStatus = 'PENDING' | 'APPROVED' | 'SENT';

interface Props {
  mailboxId?: string;
}

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

function DraftListRow({
  draft,
  active,
  focused,
  onClick,
}: {
  draft: EmailDraft;
  active: boolean;
  focused: boolean;
  onClick: () => void;
}) {
  const candidate = draft.thread?.candidate;
  const name = candidate?.name ?? 'Unknown candidate';
  const role = candidate?.role;
  const preview = firstNonEmptyLine(draft.bodyText) || draft.subject;
  const rowRef = useRef<HTMLButtonElement | null>(null);

  // Keep the focused row visible without grabbing input focus
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  return (
    <button
      ref={rowRef}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        'group flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors',
        active
          ? 'border-accent-400 bg-accent-500/[0.08]'
          : focused
            ? 'border-line-strong bg-fg-strong/[0.03]'
            : 'border-transparent hover:bg-fg-strong/[0.02]'
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-1 ring-inset ring-fg-strong/[0.08]',
          draft.classification === 'INTERESTED' &&
            'bg-gradient-to-br from-emerald-500/80 to-emerald-700/80',
          draft.classification === 'NOT_INTERESTED' &&
            'bg-gradient-to-br from-rose-500/80 to-rose-700/80',
          draft.classification === 'NEUTRAL' &&
            'bg-gradient-to-br from-accent-500/80 to-accent-700/80'
        )}
      >
        {initialsFor(name, candidate?.email)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={cn(
              'truncate text-[13px] font-medium',
              active ? 'text-fg-strong' : 'text-fg-default'
            )}
          >
            {name}
          </p>
          <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
            {formatTimeAgo(draft.createdAt)}
          </span>
        </div>
        {role ? (
          <div className="mt-0.5">
            <span
              data-testid="role-pill"
              className="inline-block max-w-[160px] truncate rounded-md bg-accent-500/8 px-1.5 py-0.5 align-middle text-[10.5px] font-medium text-accent-600 ring-1 ring-inset ring-accent-500/15 dark:text-accent-300"
              title={role}
            >
              {role}
            </span>
          </div>
        ) : null}
        <p className="mt-0.5 truncate text-[12px] text-fg-muted">
          {draft.subject}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-fg-subtle">{preview}</p>
      </div>
      <ChevronRight
        className={cn(
          'h-4 w-4 flex-shrink-0 transition-all',
          active ? 'text-accent-600 dark:text-accent-300' : 'text-fg-subtle group-hover:text-fg-muted'
        )}
      />
    </button>
  );
}

function EmptyDraftsState({ status }: { status: DraftStatus }) {
  const config = {
    PENDING: {
      icon: Sparkles,
      title: 'No drafts waiting',
      description:
        "We'll generate replies automatically when interested candidates respond. Check back in a few minutes or connect a new mailbox.",
    },
    APPROVED: {
      icon: FileText,
      title: 'Nothing approved yet',
      description:
        'Approve drafts from the Pending tab — they will queue up here, saved as Gmail drafts for you to review before sending.',
    },
    SENT: {
      icon: Inbox,
      title: 'No sent drafts yet',
      description:
        'Approved drafts that you choose to send will land here, along with the timestamp of delivery.',
    },
  }[status];

  const Icon = config.icon;
  return (
    <Empty className="border border-dashed border-line-strong bg-surface-raised/40">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-fg-strong/[0.04] text-accent-600 dark:text-accent-300">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="font-display text-[15px] font-medium text-fg-strong">
          {config.title}
        </EmptyTitle>
        <EmptyDescription className="max-w-md text-[13px] leading-relaxed text-fg-muted">
          {config.description}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['j', '↓'], label: 'Focus next draft' },
  { keys: ['k', '↑'], label: 'Focus previous draft' },
  { keys: ['Enter', 'o'], label: 'Open focused draft' },
  { keys: ['Esc'], label: 'Close draft pane' },
  { keys: ['a'], label: 'Approve' },
  { keys: ['x', 'd'], label: 'Discard (with confirm)' },
  { keys: ['r'], label: 'Regenerate' },
  { keys: ['e'], label: 'Edit body' },
  { keys: ['?'], label: 'Show this help' },
];

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-[16px] font-semibold">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            Available on the Drafts tab and while the review pane is open.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          {SHORTCUTS.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-[13px] text-fg-default">{s.label}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && (
                      <span className="text-[11px] text-fg-subtle">or</span>
                    )}
                    <kbd className="rounded-md border border-line bg-surface-base px-2 py-0.5 font-mono text-[11px] font-medium text-fg-strong shadow-sm">
                      {k}
                    </kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Got it</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function EmailDrafts({ mailboxId }: Props) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeStatus, setActiveStatus] = useState<DraftStatus>('PENDING');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [editNonce, setEditNonce] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const deepLinkCandidateId = searchParams.get('candidateId');
  const deepLinkDraftId = searchParams.get('draftId');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['drafts', activeStatus, mailboxId],
    queryFn: () => fetchDrafts({ status: activeStatus, limit: 100, mailboxId }),
    staleTime: 15_000,
  });

  const drafts = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  // Resolve deep-linked draft id from either candidateId or draftId.
  const targetDraftId = useMemo(() => {
    if (deepLinkDraftId) return deepLinkDraftId;
    if (!deepLinkCandidateId) return null;
    const match = drafts.find(
      (d) =>
        d.thread?.candidate?.id === deepLinkCandidateId ||
        d.thread?.candidateId === deepLinkCandidateId
    );
    return match?.id ?? null;
  }, [deepLinkDraftId, deepLinkCandidateId, drafts]);

  // Auto-switch to APPROVED if the deep-linked candidate has no pending draft.
  const [didAutoSwitchTabs, setDidAutoSwitchTabs] = useState(false);
  useEffect(() => {
    if (!deepLinkCandidateId || isLoading || didAutoSwitchTabs) return;
    if (targetDraftId) return;
    if (activeStatus === 'PENDING') {
      setActiveStatus('APPROVED');
      setDidAutoSwitchTabs(true);
    }
  }, [
    deepLinkCandidateId,
    isLoading,
    targetDraftId,
    activeStatus,
    didAutoSwitchTabs,
  ]);

  // When a deep-link resolves, open the pane and clear the URL params.
  useEffect(() => {
    if (!targetDraftId) return;
    setActiveDraftId(targetDraftId);
    const idx = drafts.findIndex((d) => d.id === targetDraftId);
    if (idx !== -1) setFocusedIndex(idx);
    const params = new URLSearchParams(searchParams);
    const hadDeepLink = params.has('candidateId') || params.has('draftId');
    if (!hadDeepLink) return;
    const id = window.setTimeout(() => {
      params.delete('candidateId');
      params.delete('draftId');
      setSearchParams(params, { replace: true });
    }, 250);
    return () => window.clearTimeout(id);
  }, [targetDraftId, drafts, searchParams, setSearchParams]);

  // Clamp focusedIndex when the list changes
  useEffect(() => {
    if (drafts.length === 0) {
      setFocusedIndex(0);
      return;
    }
    if (focusedIndex >= drafts.length) {
      setFocusedIndex(drafts.length - 1);
    }
  }, [drafts.length, focusedIndex]);

  // If active draft disappears (e.g. after discard), close pane
  useEffect(() => {
    if (!activeDraftId) return;
    if (!drafts.some((d) => d.id === activeDraftId)) {
      setActiveDraftId(null);
    }
  }, [drafts, activeDraftId]);

  const activeDraft = useMemo(
    () => drafts.find((d) => d.id === activeDraftId) ?? null,
    [drafts, activeDraftId]
  );

  const approveMutation = useMutation({
    mutationFn: approveDraft,
    onSuccess: (_data, id) => {
      const d = drafts.find((x) => x.id === id);
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

  const discardMutation = useMutation({
    mutationFn: discardDraft,
    onSuccess: () => {
      toastSuccess('Draft discarded');
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) => {
      if (isAlreadyResolvedError(err)) {
        toastSuccess('Already resolved', 'This draft was already approved or discarded.');
        void queryClient.invalidateQueries({ queryKey: ['drafts'] });
        return;
      }
      toastError(
        'Could not discard draft',
        extractApiErrorMessage(err, 'Please try again.')
      );
    },
  });

  const sendMutation = useMutation({
    mutationFn: sendDraft,
    onSuccess: (_res, id) => {
      const d = drafts.find((x) => x.id === id);
      const to =
        d?.thread?.candidate?.name ?? d?.thread?.candidate?.email ?? 'candidate';
      toastSuccess(`Email sent to ${to}`, 'Cc: sofia@archive.com');
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
    onError: (err) => {
      if (isAlreadyResolvedError(err)) {
        toastSuccess('Already sent', 'This draft was sent in another session.');
        void queryClient.invalidateQueries({ queryKey: ['drafts'] });
        void queryClient.invalidateQueries({ queryKey: ['candidates'] });
        return;
      }
      toastError(
        'Could not send email',
        extractApiErrorMessage(err, 'Please try again.')
      );
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, bodyText }: { id: string; bodyText: string }) =>
      updateDraft(id, { bodyText }),
    onSuccess: () => {
      toastSuccess('Draft updated');
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) => {
      toastError(
        'Could not save draft',
        extractApiErrorMessage(err, 'Please try again.')
      );
    },
  });

  const regenerateLoadingToastRef = useRef<string | number | null>(null);
  const regenerateMutation = useMutation({
    mutationFn: (id: string) => {
      regenerateLoadingToastRef.current = toastLoading('Regenerating draft…');
      return regenerateDraft(id);
    },
    onSuccess: () => {
      if (regenerateLoadingToastRef.current !== null) {
        dismissToast(regenerateLoadingToastRef.current);
        regenerateLoadingToastRef.current = null;
      }
      toastSuccess('Draft regenerated', 'Fresh copy ready for review.');
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) => {
      if (regenerateLoadingToastRef.current !== null) {
        dismissToast(regenerateLoadingToastRef.current);
        regenerateLoadingToastRef.current = null;
      }
      toastError(
        'Could not regenerate draft',
        extractApiErrorMessage(err, 'Please try again.')
      );
    },
  });

  const regenerateErrorMessage =
    activeDraft &&
    regenerateMutation.variables === activeDraft.id &&
    !regenerateMutation.isPending &&
    regenerateMutation.isError
      ? extractApiErrorMessage(
          regenerateMutation.error,
          'Failed to regenerate draft'
        )
      : null;

  const handleOpen = useCallback(
    (draftId: string) => {
      const idx = drafts.findIndex((d) => d.id === draftId);
      if (idx !== -1) setFocusedIndex(idx);
      setActiveDraftId(draftId);
    },
    [drafts]
  );

  // Keyboard shortcuts
  const shortcutOpen = useCallback(() => {
    const draft = drafts[focusedIndex];
    if (draft) handleOpen(draft.id);
  }, [drafts, focusedIndex, handleOpen]);

  const shortcutNext = useCallback(() => {
    if (drafts.length === 0) return;
    setFocusedIndex((i) => Math.min(drafts.length - 1, i + 1));
  }, [drafts.length]);

  const shortcutPrev = useCallback(() => {
    if (drafts.length === 0) return;
    setFocusedIndex((i) => Math.max(0, i - 1));
  }, [drafts.length]);

  const shortcutClose = useCallback(() => {
    if (shortcutsOpen) {
      setShortcutsOpen(false);
      return;
    }
    setActiveDraftId(null);
  }, [shortcutsOpen]);

  const shortcutApprove = useCallback(() => {
    const target = activeDraft ?? drafts[focusedIndex];
    if (target && target.status === 'PENDING') {
      approveMutation.mutate(target.id);
    }
  }, [activeDraft, drafts, focusedIndex, approveMutation]);

  const shortcutDiscard = useCallback(() => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'PENDING') return;
    // Open the discard confirm AlertDialog by clicking the pane's trigger;
    // user still confirms via the dialog (keeps Phase O safety flow).
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-draft-pane="true"] button[aria-label="Discard draft"]'
    );
    trigger?.click();
  }, [activeDraft]);

  const shortcutRegenerate = useCallback(() => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'PENDING') return;
    regenerateMutation.mutate(activeDraft.id);
  }, [activeDraft, regenerateMutation]);

  const shortcutEdit = useCallback(() => {
    if (!activeDraft) return;
    if (activeDraft.status !== 'PENDING') return;
    setEditNonce((n) => n + 1);
  }, [activeDraft]);

  useDraftKeyboardShortcuts(
    {
      onNext: shortcutNext,
      onPrev: shortcutPrev,
      onOpen: shortcutOpen,
      onClose: shortcutClose,
      onApprove: shortcutApprove,
      onDiscard: shortcutDiscard,
      onRegenerate: shortcutRegenerate,
      onEdit: shortcutEdit,
    },
    { enabled: true }
  );

  // `?` to open shortcuts help
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const statusTabs: { id: DraftStatus; label: string }[] = [
    { id: 'PENDING', label: 'Pending' },
    { id: 'APPROVED', label: 'Approved' },
    { id: 'SENT', label: 'Sent' },
  ];

  if (error) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-10 text-center">
        <p className="mb-3 text-rose-700 dark:text-rose-300">Failed to load drafts</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => refetch()}
          className="mx-auto"
        >
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-[28px]">
            Email drafts
          </h1>
          <p className="mt-1 text-[13.5px] text-fg-muted">
            Review, edit, and send AI-drafted replies. Press{' '}
            <kbd className="rounded border border-line bg-surface-base px-1.5 py-0.5 font-mono text-[10.5px] text-fg-default">
              ?
            </kbd>{' '}
            for shortcuts.
          </p>
        </div>
      </div>

      {/* Status segmented control */}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-line bg-surface-raised/70 p-1">
          {statusTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveStatus(tab.id);
                setFocusedIndex(0);
                setActiveDraftId(null);
              }}
              className={cn(
                'rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-all',
                activeStatus === tab.id
                  ? 'bg-fg-strong/[0.08] text-fg-strong shadow-sm'
                  : 'text-fg-muted hover:text-fg-default'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-[12px] tabular-nums text-fg-subtle">
          {total} {activeStatus.toLowerCase()}
        </span>
      </div>

      {/* Flat list */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised/60">
        {isLoading ? (
          <div className="divide-y divide-line-soft">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-none" />
            ))}
          </div>
        ) : drafts.length === 0 ? (
          <EmptyDraftsState status={activeStatus} />
        ) : (
          <div className="divide-y divide-line-soft">
            {drafts.map((draft, idx) => (
              <DraftListRow
                key={draft.id}
                draft={draft}
                active={draft.id === activeDraftId}
                focused={idx === focusedIndex && draft.id !== activeDraftId}
                onClick={() => handleOpen(draft.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Side-pane */}
      <DraftReviewPane
        open={activeDraft !== null}
        draft={activeDraft}
        onClose={() => setActiveDraftId(null)}
        onApprove={(id) => approveMutation.mutate(id)}
        onDiscard={(id) => discardMutation.mutate(id)}
        onSend={(id) => sendMutation.mutate(id)}
        onUpdate={(id, bodyText) => updateMutation.mutate({ id, bodyText })}
        onRegenerate={(id) => regenerateMutation.mutate(id)}
        regenerating={
          regenerateMutation.isPending &&
          regenerateMutation.variables === (activeDraft?.id ?? '')
        }
        regenerateError={regenerateErrorMessage}
        approving={
          approveMutation.isPending &&
          approveMutation.variables === (activeDraft?.id ?? '')
        }
        sending={
          sendMutation.isPending &&
          sendMutation.variables === (activeDraft?.id ?? '')
        }
        editRequestNonce={editNonce}
      />

      {/* Shortcuts help — floating ? button */}
      <button
        onClick={() => setShortcutsOpen(true)}
        aria-label="Show keyboard shortcuts"
        className="fixed bottom-5 right-5 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-elevated/90 text-fg-muted shadow-lg backdrop-blur transition-all hover:scale-105 hover:bg-surface-elevated hover:text-fg-strong"
      >
        <Keyboard className="h-4 w-4" />
      </button>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
