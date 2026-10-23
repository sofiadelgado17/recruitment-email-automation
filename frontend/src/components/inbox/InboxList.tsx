import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Inbox as InboxIcon, Send } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { InboxItem, InboxView } from '@/lib/api';
import { VIEWS, itemKey, type RoleGroup } from '@/lib/inbox';
import { initials } from '@/lib/utils';
import QueryError from '@/components/shell/QueryError';
import { cn } from '@/lib/utils';
import { AgeStamp, LabelChip, MailboxLine, NeedsReviewChip, PresenceChip, RoleLine } from './chips';
import DraftFlags from './DraftFlags';

export { itemKey } from '@/lib/inbox';

/** Rows above this count render through a virtualizer (only a window is in the DOM). */
export const VIRTUALIZE_AFTER = 100;
// Name, role, From + label, snippet (measured after render; this only seeds the scroll height).
const ESTIMATED_ROW_PX = 108;

interface RowProps {
  item: InboxItem;
  rowKey: string;
  selected: boolean;
  focused: boolean;
  highlighted: boolean;
  checkable: boolean;
  checked: boolean;
  onOpen: (key: string) => void;
  onCheck: (id: string, checked: boolean) => void;
  /** Virtual mode: position in the whole list (1-based) and its size. */
  pos?: { index: number; posInSet: number; setSize: number; start: number; measure: (el: Element | null) => void };
}

const Row = memo(function Row({ item, rowKey, selected, focused, highlighted, checkable, checked, onOpen, onCheck, pos }: RowProps) {
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focused || highlighted) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused, highlighted]);
  const measure = pos?.measure;
  const setRef = useCallback(
    (el: HTMLLIElement | null) => {
      ref.current = el;
      measure?.(el);
    },
    [measure]
  );
  const name = item.candidate?.name ?? 'Unknown candidate';
  const preview = item.draft?.preview ?? 'No draft yet — needs a decision';
  return (
    <li
      ref={setRef}
      data-index={pos?.index}
      aria-posinset={pos?.posInSet}
      aria-setsize={pos?.setSize}
      className={cn('flex items-center gap-1 px-2', pos && 'absolute inset-x-0 top-0 pb-0.5')}
      // eslint-disable-next-line no-restricted-syntax -- virtual row offset is computed per scroll
      style={pos ? offsetY(pos.start) : undefined}
    >
      {checkable && (
        <Checkbox
          aria-label={`Select ${name}`}
          checked={checked}
          onCheckedChange={(v) => onCheck(item.id, v === true)}
          className="ml-1"
        />
      )}
      <Button
        variant={selected ? 'secondary' : 'ghost'}
        size="row"
        onClick={() => onOpen(rowKey)}
        aria-current={selected ? 'true' : undefined}
        data-focused={focused ? 'true' : undefined}
        data-highlighted={highlighted ? 'true' : undefined}
        className="transition-colors duration-700 data-[focused=true]:ring-2 data-[focused=true]:ring-ring data-[highlighted=true]:bg-success/10 data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-success/40"
      >
        <Avatar size="sm">
          <AvatarFallback>{initials(name)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium text-foreground">{name}</span>
            <AgeStamp ageMs={item.ageMs} at={item.sortAt} verb={item.view === 'sent_today' ? 'Sent' : 'Received'} />
          </span>
          <RoleLine role={item.candidate?.role} />
          {/* Wraps rather than clipping: the status chips drop below a long address. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {item.mailbox && <MailboxLine email={item.mailbox.emailAddress} className="max-w-full" />}
            {item.draft ? (
              <LabelChip classification={item.draft.classification} confidenceLabel={item.draft.confidenceLabel} />
            ) : (
              <NeedsReviewChip />
            )}
            <PresenceChip presence={item.presence} />
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">{preview}</span>
          {item.draft && (
            <span className="flex flex-wrap items-center gap-1 empty:hidden">
              <DraftFlags flags={item.draft} />
            </span>
          )}
        </span>
      </Button>
    </li>
  );
});

/** Virtual-list geometry: the only inline styles here, and they change on every scroll. */
const offsetY = (px: number): CSSProperties => ({ transform: `translateY(${px}px)` });
const totalHeight = (px: number): CSSProperties => ({ height: px });

type Entry = { type: 'header'; group: RoleGroup; n: number } | { type: 'item'; item: InboxItem; n: number };

interface Props {
  view: InboxView;
  items: InboxItem[];
  total?: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  selectedKey?: string;
  focusedKey?: string;
  /** Briefly marks a row that just arrived in this view (H8). */
  highlightKey?: string;
  onOpen: (key: string) => void;
  /** Batch selection (Not interested view only). */
  checked: Set<string>;
  onCheckedChange: (next: Set<string>) => void;
  onBatchSend: () => void;
  header?: React.ReactNode;
  /** Sort / role filter / group controls, shown beside the title. */
  controls?: React.ReactNode;
  /** Group by role: sections in display order (items as in `items`). */
  groups?: RoleGroup[];
  /** A role filter is on: empty means "no replies for this role". */
  roleFiltered?: boolean;
  /** More pages behind nextCursor. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** Loads the next page when scrolled into view; the button is the keyboard / no-observer path. */
function LoadMore({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="flex justify-center px-3 py-2">
      {loading ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          Loading more…
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

function InboxList({
  view,
  items,
  total,
  loading,
  error,
  onRetry,
  selectedKey,
  focusedKey,
  highlightKey,
  onOpen,
  checked,
  onCheckedChange,
  onBatchSend,
  header,
  controls,
  groups,
  roleFiltered,
  hasMore,
  loadingMore,
  onLoadMore,
}: Props) {
  const meta = VIEWS.find((v) => v.id === view)!;
  const groupId = useId();
  const batchable = view === 'not_interested';
  const draftIds = useMemo(() => items.filter((i) => i.kind === 'draft').map((i) => i.id), [items]);
  const allChecked = draftIds.length > 0 && draftIds.every((id) => checked.has(id));

  // Stable for memo'd rows: read the latest selection through a ref.
  const checkedRef = useRef(checked);
  const onCheckedChangeRef = useRef(onCheckedChange);
  useLayoutEffect(() => {
    checkedRef.current = checked;
    onCheckedChangeRef.current = onCheckedChange;
  });
  const onCheck = useCallback((id: string, v: boolean) => {
    const next = new Set(checkedRef.current);
    if (v) next.add(id);
    else next.delete(id);
    onCheckedChangeRef.current(next);
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = items.length > VIRTUALIZE_AFTER;
  const entries = useMemo<Entry[]>(() => {
    if (!virtual) return [];
    let n = 0;
    if (!groups) return items.map((item) => ({ type: 'item', item, n: ++n }));
    return groups.flatMap((group, gi): Entry[] => [
      { type: 'header', group, n: gi },
      ...group.items.map((item): Entry => ({ type: 'item', item, n: ++n })),
    ]);
  }, [virtual, items, groups]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (entries[i]?.type === 'header' ? 28 : ESTIMATED_ROW_PX),
    overscan: 8,
    initialRect: { width: 320, height: 800 },
  });
  // Keyboard moves can land outside the rendered window: bring that row in.
  const activeKey = selectedKey ?? focusedKey ?? highlightKey;
  useEffect(() => {
    if (!virtual || !activeKey) return;
    const at = entries.findIndex((e) => e.type === 'item' && itemKey(e.item) === activeKey);
    if (at >= 0) virtualizer.scrollToIndex(at, { align: 'auto' });
  }, [virtual, activeKey, entries, virtualizer]);

  const renderRow = (item: InboxItem, pos?: RowProps['pos']) => {
    const key = itemKey(item);
    return (
      <Row
        key={key}
        item={item}
        rowKey={key}
        selected={key === selectedKey}
        focused={key === focusedKey}
        highlighted={key === highlightKey}
        checkable={batchable && item.kind === 'draft'}
        checked={checked.has(item.id)}
        onOpen={onOpen}
        onCheck={onCheck}
        pos={pos}
      />
    );
  };

  const groupHeading = (g: RoleGroup, i: number, className: string) => (
    <h3 id={`${groupId}-${i}`} className={cn('flex items-center gap-2 bg-background px-4 py-1.5 text-xs font-semibold text-muted-foreground', className)}>
      <span className="truncate">{g.label}</span>
      <span className="tabular-nums font-normal">{g.count}</span>
    </h3>
  );

  const virtualList = () => (
    <ul
      aria-label={`${meta.label} replies`}
      className="relative"
      // eslint-disable-next-line no-restricted-syntax -- total height of the virtual list
      style={totalHeight(virtualizer.getTotalSize())}
    >
      {virtualizer.getVirtualItems().map((v) => {
        const e = entries[v.index];
        if (e.type === 'item') {
          return renderRow(e.item, {
            index: v.index,
            posInSet: e.n,
            setSize: items.length,
            start: v.start,
            measure: virtualizer.measureElement,
          });
        }
        return (
          <li
            key={`h:${e.group.key}`}
            ref={virtualizer.measureElement}
            data-index={v.index}
            role="presentation"
            className="absolute inset-x-0 top-0"
            // eslint-disable-next-line no-restricted-syntax -- virtual row offset is computed per scroll
            style={offsetY(v.start)}
          >
            {groupHeading(e.group, e.n, '')}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        {header}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {batchable && draftIds.length > 0 && (
              <Checkbox
                aria-label="Select all"
                checked={allChecked}
                onCheckedChange={(v) => onCheckedChange(v === true ? new Set(draftIds) : new Set())}
              />
            )}
            <h2 className="font-heading text-sm font-semibold text-foreground">{meta.label}</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{total ?? items.length}</span>
          </div>
          {controls}
          {batchable && checked.size > 0 && (
            <Button size="sm" onClick={onBatchSend}>
              <Send data-icon="inline-start" />
              {`Send ${checked.size} ${checked.size === 1 ? 'reply' : 'replies'}`}
            </Button>
          )}
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading ? (
          <div aria-label="Loading replies" className="flex flex-col gap-2 px-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="px-3">
            <QueryError thing="the inbox" onRetry={onRetry} />
          </div>
        ) : items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>{roleFiltered ? 'No replies for this role' : meta.empty}</EmptyTitle>
              <EmptyDescription>
                {roleFiltered ? 'Try another role, or show all roles.' : meta.hint}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : virtual ? (
          virtualList()
        ) : groups ? (
          <ul aria-label={`${meta.label} replies`} className="flex flex-col gap-2">
            {groups.map((g, i) => (
              // Header after its rows in the DOM so it paints over them when
              // stuck (rows hold positioned avatars); order-first shows it on top.
              <li key={g.key} aria-labelledby={`${groupId}-${i}`} className="flex flex-col">
                <ul className="flex flex-col gap-0.5">{g.items.map((item) => renderRow(item))}</ul>
                {groupHeading(g, i, 'sticky top-0 order-first')}
              </li>
            ))}
          </ul>
        ) : (
          <ul aria-label={`${meta.label} replies`} className="flex flex-col gap-0.5">
            {items.map((item) => renderRow(item))}
          </ul>
        )}
        {!loading && !error && items.length > 0 && hasMore && onLoadMore && (
          <LoadMore loading={!!loadingMore} onLoadMore={onLoadMore} />
        )}
      </div>
    </div>
  );
}

export default memo(InboxList);
