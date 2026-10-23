import { Briefcase, Eye, Mail, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatAge } from '@/lib/utils';
import type { ConfidenceLabel, DraftPresenceEntry } from '@/lib/api';
import { replyLabel } from '@/lib/candidates';
import { formatEtFull, labelFor } from '@/lib/inbox';

/** Interested / Unsure / Not interested — words only, semantic colour. */
export function LabelChip({
  classification,
  confidenceLabel,
}: {
  classification: string;
  confidenceLabel?: ConfidenceLabel | null;
}) {
  const label = labelFor(classification, confidenceLabel);
  return (
    <Badge variant={label.tone} data-tone={label.tone}>
      {label.text}
    </Badge>
  );
}

/**
 * A Needs-review candidate with no draft yet: the shared status word
 * ("Needs review", lib/candidates replyLabel), as on Candidates.
 */
export function NeedsReviewChip() {
  const label = replyLabel({ status: 'NEEDS_REVIEW', lastInboundAt: null, repliedAt: null });
  return (
    <Badge variant={label.tone} data-tone={label.tone}>
      {label.text}
    </Badge>
  );
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "Sofia editing" / "Sofia viewing" for the first other person on the reply. */
export function PresenceChip({ presence }: { presence: DraftPresenceEntry[] }) {
  const editor = presence.find((p) => p.mode === 'editing') ?? presence[0];
  if (!editor) return null;
  const Icon = editor.mode === 'editing' ? Pencil : Eye;
  return (
    <Badge variant="outline">
      <Icon data-icon="inline-start" />
      {`${firstName(editor.name)} ${editor.mode}`}
    </Badge>
  );
}

/** The full sending address: rows and headers name the mailbox outright, not its local part. */
export function MailboxChip({ email }: { email: string }) {
  return (
    <Badge variant="secondary" className="min-w-0 max-w-full shrink justify-start">
      <span className="min-w-0 truncate">{email}</span>
    </Badge>
  );
}

const ROLE_UNKNOWN_TIP = "Claude couldn't detect the role from the outreach";

function WithTip({ tip, children }: { tip: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The role the candidate replied about, as a chip (reply/candidate panes,
 * Candidates table). The full title always renders; only a container too
 * narrow for it clips it, and the tooltip carries the full title.
 */
export function RoleChip({ role }: { role: string | null | undefined }) {
  const title = role?.trim();
  return (
    <WithTip tip={title || ROLE_UNKNOWN_TIP}>
      <Badge
        variant="outline"
        data-testid="role-chip"
        data-role-known={title ? 'true' : 'false'}
        aria-label={title ? `Role: ${title}` : 'Role unknown'}
        className={cn('min-w-0 max-w-full shrink justify-start', title ? 'text-foreground' : 'border-dashed text-muted-foreground')}
      >
        <Briefcase data-icon="inline-start" />
        <span className="min-w-0 truncate">{title || 'Role unknown'}</span>
      </Badge>
    </WithTip>
  );
}

/**
 * Inbox row: the role on its own line, in full. Wraps; only an absurdly
 * long title clamps at two lines (the tooltip has all of it).
 */
export function RoleLine({ role }: { role: string | null | undefined }) {
  const title = role?.trim();
  return (
    <WithTip tip={title || ROLE_UNKNOWN_TIP}>
      <span
        data-testid="role-line"
        data-role-known={title ? 'true' : 'false'}
        aria-label={title ? `Role: ${title}` : 'Role unknown'}
        className={cn('flex min-w-0 items-start gap-1.5 text-xs', title ? 'text-foreground' : 'text-muted-foreground')}
      >
        <Briefcase aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="line-clamp-2 min-w-0 break-words">{title || 'Role unknown'}</span>
      </span>
    </WithTip>
  );
}

/** "From rampersad.aaron@archive.com": the mailbox the outreach went out from. */
export function MailboxLine({ email, className }: { email: string; className?: string }) {
  return (
    <WithTip tip={email}>
      <span
        data-testid="mailbox-line"
        aria-label={`Sent from ${email}`}
        className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)}
      >
        <Mail aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{`From ${email}`}</span>
      </span>
    </WithTip>
  );
}

/**
 * Row age ("2h", "56d") since the candidate's email arrived (`at` = the
 * item's sortAt); the tooltip has the exact time in ET.
 */
export function AgeStamp({ ageMs, at, verb = 'Received' }: { ageMs: number; at: string; verb?: 'Received' | 'Sent' }) {
  const exact = `${verb} ${formatEtFull(new Date(at))}`;
  return (
    <WithTip tip={exact}>
      <time dateTime={at} aria-label={exact} className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatAge(ageMs)}
      </time>
    </WithTip>
  );
}
