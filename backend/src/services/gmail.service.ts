import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { prisma } from '../db/client';
import { classifyReply, generateDraftReply, generateHandoffDraftReply, getHandoffType, type ExampleReply } from './claude.service';
import { logEvent } from './monitoring.service';
import { decrypt, encrypt } from '../lib/crypto';
import type { Mailbox, EmailThread } from '@prisma/client';

/**
 * Serialize an OAuth2 / service-account credentials object for storage.
 * Encrypts at rest with AES-256-GCM (see ../lib/crypto).
 */
export function serializeCredentials(creds: Record<string, unknown>): string {
  return encrypt(JSON.stringify(creds));
}

function parseCredentials(mailbox: Mailbox): Record<string, unknown> {
  const raw = mailbox.credentials;
  if (typeof raw !== 'string' || raw.length === 0) {
    return {};
  }

  // Try decrypting (current format). Fall back to plaintext JSON for rows
  // written before encryption was introduced.
  // TODO: remove plaintext fallback after backfill (re-encrypt all existing
  // Mailbox.credentials rows and remove this try/catch).
  try {
    const plaintext = decrypt(raw);
    return JSON.parse(plaintext) as Record<string, unknown>;
  } catch (decryptErr) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      console.warn(
        `[Gmail] Mailbox ${mailbox.id} credentials are stored as plaintext; ` +
          'they will be re-encrypted on next write. Remove plaintext fallback ' +
          'after backfilling.'
      );
      return parsed;
    } catch {
      console.error(
        `[Gmail] Failed to parse credentials for mailbox ${mailbox.id}:`,
        decryptErr
      );
      return {};
    }
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
 */
async function getGmailClient(mailbox: Mailbox): Promise<ReturnType<typeof google.gmail>> {
  const credentials = parseCredentials(mailbox);
  if (credentials.type === 'service_account') {
    return createServiceAccountClient(mailbox.emailAddress);
  }
  return google.gmail({ version: 'v1', auth: getAuthenticatedClient(credentials) });
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

export async function handleCallback(code: string, mailboxId?: string): Promise<Mailbox> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const emailAddress = profile.data.emailAddress ?? '';
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
    },
    'INFO'
  );
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

function shouldSkipClassification(opts: {
  fromAddress: string;
  fromName?: string | null;
  subject: string;
  mailboxEmail: string;
}): boolean {
  const from = opts.fromAddress.toLowerCase().trim();
  const name = (opts.fromName ?? '').toLowerCase();
  const subject = opts.subject.toLowerCase();

  if (!from) return true;
  if (from === opts.mailboxEmail.toLowerCase()) return true; // outbound

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

function parseGmailMessage(
  msgId: string,
  fullMsgData: {
    threadId?: string | null;
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
  const fromAddress = (fromMatch[2] ?? fromRaw).trim();

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
    receivedAt: dateStr ? new Date(dateStr) : new Date(),
    headers: { messageId, inReplyTo, references, cc: ccRaw },
  };
}

/**
 * Status priority — never downgrade a candidate's status as a side-effect
 * of a later, less-informative reply.
 *
 * Higher index = higher priority. NEEDS_REVIEW wins outright (a human must
 * look). Otherwise REPLIED > INTERESTED > NEUTRAL > NOT_INTERESTED > PENDING.
 *
 * Unknown / legacy values fall to the bottom so they never beat a known one.
 */
const STATUS_PRIORITY: Record<string, number> = {
  PENDING: 0,
  NOT_INTERESTED: 1,
  NEUTRAL: 2,
  INTERESTED: 3,
  REPLIED: 4,
  NEEDS_REVIEW: 5,
};

export function pickHigherPriorityStatus(current: string, next: string): string {
  const cur = STATUS_PRIORITY[current] ?? -1;
  const nxt = STATUS_PRIORITY[next] ?? -1;
  return nxt > cur ? next : current;
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
async function classifyAndDraft(opts: {
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
    })
  ) {
    return;
  }

  // If the recruiter has explicitly ignored this candidate, the message is
  // already stored (we don't want to drop data) but we skip classification
  // and draft generation entirely. Equivalent to muting the sender.
  const ignoredCandidate = await prisma.candidate.findUnique({
    where: { email: parsed.fromAddress },
    select: { id: true, status: true },
  });
  if (ignoredCandidate?.status === 'IGNORED') {
    await logEvent(
      'MESSAGE_FROM_IGNORED_CANDIDATE',
      {
        mailboxId: mailbox.id,
        candidateId: ignoredCandidate.id,
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
  const existingDraft = await prisma.emailDraft.findFirst({
    where: { threadId: thread.id, status: { in: ['PENDING', 'APPROVED'] } },
  });

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

  const { classification, messageType, needsReview, confidence, role } = classificationResult;

  // ---- Routing decisions ----------------------------------------------------
  // NOT_RECRUITING_RELATED: don't pollute the candidate table at all.
  if (messageType === 'NOT_RECRUITING_RELATED') {
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

  const lowConfidence = confidence < 0.7;
  // The candidate-level status we want to write. NEEDS_REVIEW for any low-trust
  // signal so a human looks before we auto-draft.
  const desiredStatus =
    needsReview || lowConfidence ? 'NEEDS_REVIEW' : classification;

  // Look up the existing candidate to enforce status-priority (don't downgrade
  // an INTERESTED candidate to NEUTRAL just because they sent a logistics
  // follow-up).
  const existingCandidate = await prisma.candidate.findUnique({
    where: { email: parsed.fromAddress },
  });

  const finalStatus = existingCandidate
    ? pickHigherPriorityStatus(existingCandidate.status, desiredStatus)
    : desiredStatus;

  // Only overwrite role on existing candidates when we have a new value and
  // the row didn't already have one — avoids churning a manually-edited or
  // earlier-detected role on every follow-up reply.
  const shouldSetRoleOnUpdate =
    role !== null && existingCandidate && !existingCandidate.role;

  const candidate = await prisma.candidate.upsert({
    where: { email: parsed.fromAddress },
    update: {
      status: finalStatus,
      mailboxId: mailbox.id,
      updatedAt: new Date(),
      ...(shouldSetRoleOnUpdate ? { role } : {}),
    },
    create: {
      name: parsed.fromName ?? parsed.fromAddress,
      email: parsed.fromAddress,
      status: finalStatus,
      mailboxId: mailbox.id,
      source: 'EMAIL_REPLY',
      role: role ?? null,
    },
  });

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

  const ccEmail = config.draftCcEmail.toLowerCase();
  const isHandoffInbox = mailbox.emailAddress.toLowerCase() !== ccEmail;

  // 6. For non-Sofia inboxes, use Claude to generate a tailored handoff reply
  //    that addresses anything specific the candidate said, then loops in Sofia.
  if (isHandoffInbox) {
    const signatureHtml = await fetchMailboxSignature(mailbox.id);
    const inReplyToMessageId = parsed.headers.messageId || null;
    const existingRefs = parsed.headers.references ?? '';
    const referencesHeader = existingRefs
      ? `${existingRefs} ${inReplyToMessageId ?? ''}`.trim()
      : inReplyToMessageId;

    // Use first name only for the CC person so drafts say "Sofia" not "Sofia Delgado".
    const ccDisplayName = await prisma.mailbox
      .findUnique({ where: { emailAddress: ccEmail }, select: { displayName: true } })
      .then((mb) => (mb?.displayName ?? 'Sofia').split(/\s+/)[0]);

    let content: { subject: string; bodyText: string; bodyHtml: string };
    try {
      const draftReply = await generateHandoffDraftReply(
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
          signatureHtml,
          ccName: ccDisplayName,
          ccEmail,
          handoffType: getHandoffType(mailbox.emailAddress, candidate.role ?? null),
        },
        { email: mailbox.emailAddress, displayName: mailbox.displayName }
      );
      if (signatureHtml) {
        draftReply.bodyText = `${draftReply.bodyText}\n${htmlSignatureToPlainText(signatureHtml)}`;
        draftReply.bodyHtml = `${draftReply.bodyHtml ?? ''}${signatureHtml}`;
      }
      content = draftReply;
    } catch {
      // Fall back to static template if Claude fails
      content = buildHandoffDraftContent(
        candidate.name,
        mailbox.displayName,
        mailbox.emailAddress,
        thread.subject,
        signatureHtml
      );
    }

    await prisma.emailDraft.create({
      data: {
        threadId: thread.id,
        inReplyToMessageId,
        referencesHeader,
        subject: content.subject,
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml,
        classification,
        confidence,
        status: 'PENDING',
      },
    });

    await logEvent(
      'DRAFT_CREATED',
      { mailboxId: mailbox.id, candidateId: candidate.id, threadId: thread.id, messageType, confidence, via: 'handoff_claude' },
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

    await prisma.emailDraft.create({
      data: {
        threadId: thread.id,
        inReplyToMessageId,
        referencesHeader,
        subject: draftReply.subject,
        bodyText: draftReply.bodyText,
        bodyHtml: draftReply.bodyHtml,
        classification,
        confidence,
        status: 'PENDING',
      },
    });

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

// Fetch a single message by Gmail message ID and persist it (idempotent — skips
// messages already stored). Used by both the 7-day fallback sync and the
// incremental history-based sync.
//
// After persisting, classifies inbound messages (calls classifyAndDraft) and
// for outbound messages from the mailbox owner sets Candidate.repliedAt so the
// dashboard can show reply status when the recruiter replies via Gmail or
// Superhuman directly.
//
// Returns true if a new message was actually stored, false if skipped.
async function fetchAndStoreMessage(
  gmail: ReturnType<typeof google.gmail>,
  mailbox: Mailbox,
  externalMessageId: string,
  opts: { skipClassification?: boolean; classifyCutoff?: Date } = {}
): Promise<boolean> {
  // Skip if already stored
  const existing = await prisma.emailMessage.findUnique({
    where: { externalMessageId },
  });
  if (existing) return false;

  try {
    const fullMsg = await gmail.users.messages.get({
      userId: 'me',
      id: externalMessageId,
      format: 'full',
    });

    const parsed = parseGmailMessage(externalMessageId, fullMsg.data);
    const isOutbound =
      parsed.fromAddress.toLowerCase() === mailbox.emailAddress.toLowerCase();

    // Upsert thread
    const thread = await prisma.emailThread.upsert({
      where: {
        mailboxId_externalThreadId: {
          mailboxId: mailbox.id,
          externalThreadId: parsed.threadId,
        },
      },
      update: {
        subject: parsed.subject,
        lastMessageAt: parsed.receivedAt,
      },
      create: {
        mailboxId: mailbox.id,
        externalThreadId: parsed.threadId,
        subject: parsed.subject,
        lastMessageAt: parsed.receivedAt,
      },
    });

    // Store message
    await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        mailboxId: mailbox.id,
        externalMessageId,
        fromAddress: parsed.fromAddress,
        fromName: parsed.fromName,
        toAddresses: JSON.stringify(parsed.toAddresses),
        subject: parsed.subject,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        receivedAt: parsed.receivedAt,
        headers: JSON.stringify(parsed.headers),
      },
    });

    if (isOutbound) {
      if (thread.candidateId) {
        // Only count this as a recruiter reply if the candidate already sent
        // at least one inbound message before this outbound message.
        // Without this check, the original outreach email would set repliedAt
        // and mark the candidate as "Replied" before they've said anything.
        const priorInbound = await prisma.emailMessage.findFirst({
          where: {
            threadId: thread.id,
            fromAddress: { not: mailbox.emailAddress },
            receivedAt: { lt: parsed.receivedAt },
          },
        });

        if (priorInbound) {
          await prisma.candidate.update({
            where: { id: thread.candidateId },
            data: { repliedAt: parsed.receivedAt },
          });

          // Discard any PENDING or APPROVED drafts on this thread — they're
          // now stale because the recruiter already sent a manual reply.
          await prisma.emailDraft.updateMany({
            where: {
              threadId: thread.id,
              status: { in: ['PENDING', 'APPROVED'] },
            },
            data: { status: 'DISCARDED' },
          });
        }
      }
      return true;
    }

    // Inbound: classify + maybe draft.
    // Skip for old messages during bulk resync (they're stored for context only).
    const tooOld = opts.classifyCutoff && parsed.receivedAt < opts.classifyCutoff;
    if (!opts.skipClassification && !tooOld) {
      await classifyAndDraft({ mailbox, thread, parsed });
    }
    return true;
  } catch (err) {
    console.error(`[Gmail] Failed to process message ${externalMessageId}:`, err);
    await logEvent(
      'MESSAGE_PROCESSING_FAILED',
      {
        mailboxId: mailbox.id,
        messageId: externalMessageId,
        error: err instanceof Error ? err.message : String(err),
      },
      'WARN'
    );
    return false;
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
      q: `after:${after}`,
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
  for (const r of storedResults) if (r) stored++;

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
    console.warn(`[Gmail] Failed to capture historyId after full sync:`, err);
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
  const newMessageIds = new Set<string>();
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
          if (added_msg.message?.id) {
            newMessageIds.add(added_msg.message.id);
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
  for (const msgId of newMessageIds) {
    await fetchAndStoreMessage(gmail, mailbox, msgId);
  }

  // Update historyId to whatever Gmail told us is latest, or fall back to
  // the historyId from the incoming webhook payload.
  const newHistoryId = latestHistoryId ?? incomingHistoryId;
  if (newHistoryId) {
    await prisma.mailbox.update({
      where: { id: mailboxId },
      data: { lastHistoryId: newHistoryId },
    });
  }

  await logEvent(
    'MAILBOX_SYNCED_INCREMENTAL',
    { mailboxId, messageCount: newMessageIds.size, startHistoryId, endHistoryId: newHistoryId },
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

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: config.gmail.pubsubTopic,
      // No labelIds filter — we want notifications for both inbound and
      // outbound mail so we can track recruiter replies for repliedAt.
    },
  });

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
  const q = `after:${gmailDateString(after)}`;

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
  const existing = await prisma.emailMessage.findMany({
    where: {
      mailboxId: mailbox.id,
      externalMessageId: { in: messageIds },
    },
    select: { externalMessageId: true },
  });
  const existingSet = new Set(existing.map((e) => e.externalMessageId));
  const missing = messageIds.filter((id) => !existingSet.has(id));

  let ingested = 0;
  for (const msgId of missing) {
    if (opts.deadline && Date.now() > opts.deadline) {
      console.warn(
        `[Gmail] reconcileMailbox(${mailbox.emailAddress}) deadline hit after ingesting ${ingested}/${missing.length}`
      );
      break;
    }
    const didStore = await fetchAndStoreMessage(gmail, mailbox, msgId);
    if (didStore) ingested += 1;
  }

  return { scannedFromGmail, missingBefore: missing.length, ingested };
}

export async function renewGmailWatches(): Promise<number> {
  const mailboxes = await prisma.mailbox.findMany({
    where: {
      provider: 'GMAIL',
      isActive: true,
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
        console.error(`[Gmail] Failed to renew watch for ${mailbox.emailAddress}:`, err);
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

export async function createDraft(
  mailboxId: string,
  draft: {
    threadId: string;
    externalThreadId: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    inReplyToMessageId?: string;
    referencesHeader?: string;
    toAddress: string;
  }
): Promise<string> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw new Error('Mailbox not found');

  const gmail = await getGmailClient(mailbox);

  // Build RFC 2822 email with proper threading headers
  const headers: string[] = [`To: ${draft.toAddress}`];

  // CC the configured address on every AI-drafted email (e.g. sofia@archive.com)
  // so she stays in the loop on outbound recruiting traffic. Skip if the CC
  // would be the mailbox owner itself to avoid self-CC loops.
  const ccAddress = config.draftCcEmail.trim();
  const ownerAddress = mailbox.emailAddress.trim().toLowerCase();
  if (ccAddress && ccAddress.toLowerCase() === ownerAddress) {
    await logEvent(
      'DRAFT_CC_SELF_SKIPPED',
      { mailboxId, ownerAddress, ccAddress },
      'INFO'
    );
  } else if (ccAddress) {
    headers.push(`Cc: ${ccAddress}`);
  }

  headers.push(`Subject: ${draft.subject}`);
  headers.push('MIME-Version: 1.0');

  // CRITICAL: Set In-Reply-To and References for Superhuman threading
  if (draft.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${draft.inReplyToMessageId}`);
  }
  if (draft.referencesHeader) {
    headers.push(`References: ${draft.referencesHeader}`);
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
  const encodedEmail = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: encodedEmail,
        // CRITICAL: Always set threadId to preserve threading in Superhuman
        threadId: draft.externalThreadId,
      },
    },
  });

  return res.data.id ?? '';
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

// In-memory idempotency cache for Pub/Sub deliveries. Pub/Sub guarantees
// at-least-once delivery, so the same (mailboxId, historyId) pair routinely
// arrives 2–3× within seconds. A short-lived LRU lets us skip the duplicate
// work without a DB round-trip. Best-effort: a process restart or multi-
// instance deploy weakens the guarantee, but the common case (retries hitting
// the same warm process) is eliminated.
const WEBHOOK_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const WEBHOOK_IDEMPOTENCY_MAX_ENTRIES = 1000;
const webhookIdempotencyCache = new Map<string, number>();

export function isWebhookDuplicate(
  mailboxId: string,
  historyId: string,
  now: number = Date.now()
): boolean {
  const key = `${mailboxId}:${historyId}`;
  const seenAt = webhookIdempotencyCache.get(key);
  if (seenAt !== undefined && now - seenAt < WEBHOOK_IDEMPOTENCY_TTL_MS) {
    // Bump recency by reinserting (Map preserves insertion order → LRU).
    webhookIdempotencyCache.delete(key);
    webhookIdempotencyCache.set(key, seenAt);
    return true;
  }
  webhookIdempotencyCache.set(key, now);
  // Drop expired entries first, then trim to cap.
  for (const [k, ts] of webhookIdempotencyCache) {
    if (now - ts >= WEBHOOK_IDEMPOTENCY_TTL_MS) {
      webhookIdempotencyCache.delete(k);
    } else {
      break; // Map iteration is insertion-ordered → oldest first.
    }
  }
  while (webhookIdempotencyCache.size > WEBHOOK_IDEMPOTENCY_MAX_ENTRIES) {
    const oldestKey = webhookIdempotencyCache.keys().next().value;
    if (oldestKey === undefined) break;
    webhookIdempotencyCache.delete(oldestKey);
  }
  return false;
}

// Test-only: reset cache between unit tests.
export function _resetWebhookIdempotencyCache(): void {
  webhookIdempotencyCache.clear();
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
 * Build the fixed handoff reply used for Aaron/Paul/Ethan's inboxes.
 * "I'm looping in Sofia…" — no Claude needed, consistent every time.
 * Pass signatureHtml (from fetchMailboxSignature) to include the real signature.
 */
export function buildHandoffDraftContent(
  candidateName: string,
  recruiterDisplayName: string | null,
  recruiterEmail: string,
  threadSubject: string,
  signatureHtml: string | null = null
): { subject: string; bodyText: string; bodyHtml: string } {
  const firstName = candidateName.split(/\s+/)[0] ?? candidateName;
  const displaySeed = (recruiterDisplayName ?? '').trim();
  const looksLikeEmail = displaySeed.toLowerCase() === recruiterEmail.toLowerCase();
  const recruiterFirst =
    displaySeed.length > 0 && !looksLikeEmail
      ? (displaySeed.split(/\s+/)[0] ?? displaySeed)
      : ((recruiterEmail.split('@')[0] ?? '').split(/[._-]/)[0] ?? 'there');

  const subject = threadSubject.startsWith('Re:') ? threadSubject : `Re: ${threadSubject}`;

  const sigPlainText = signatureHtml ? '\n' + htmlSignatureToPlainText(signatureHtml) : '\n' + recruiterFirst;
  const sigHtmlBlock = signatureHtml
    ? `<div style="margin-top:8px">${signatureHtml}</div>`
    : `<span>${recruiterFirst}</span>`;

  const bodyText =
    `Hi ${firstName},\n\nI hope you're doing well.\n\nI'm looping in Sofia from the recruitment team here to schedule time with you and share more about the position.\n\nBest,${sigPlainText}`;

  // Use a simple inline-style layout that renders consistently across Gmail,
  // Superhuman, Outlook, and Apple Mail — no external CSS, no block elements
  // that add unwanted spacing. Line-height and margin on <p> kept minimal so
  // the email looks like a real person wrote it, not a newsletter.
  const bodyHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">` +
    `<p style="margin:0 0 14px 0">Hi ${firstName},</p>` +
    `<p style="margin:0 0 14px 0">I hope you're doing well.</p>` +
    `<p style="margin:0 0 14px 0">I'm looping in Sofia from the recruitment team here to schedule time with you and share more about the position.</p>` +
    `<p style="margin:0 0 6px 0">Best,</p>` +
    sigHtmlBlock +
    `</div>`;

  return { subject, bodyText, bodyHtml };
}

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

  const sentDrafts = await prisma.emailDraft.findMany({
    where: {
      status: 'SENT',
      classification,
      thread: { mailboxId: { in: mailboxIds } },
    },
    include: {
      thread: {
        include: {
          messages: { orderBy: { receivedAt: 'asc' } },
          candidate: { select: { name: true, email: true } },
          mailbox: { select: { emailAddress: true } },
        },
      },
    },
    orderBy: { sentAt: 'desc' },
    take: 6,
  });

  const examples: ExampleReply[] = [];
  for (const draft of sentDrafts) {
    const recruiterDomain = draft.thread.mailbox.emailAddress.split('@')[1] ?? '';
    const candidateEmail = draft.thread.candidate?.email ?? '';
    // The candidate message is any message not from the recruiter's domain
    const candidateMessages = draft.thread.messages.filter(
      (m) => !m.fromAddress.toLowerCase().endsWith(`@${recruiterDomain}`) ||
             m.fromAddress.toLowerCase() === candidateEmail.toLowerCase()
    );
    const lastCandidateMsg = candidateMessages[candidateMessages.length - 1];
    if (!lastCandidateMsg?.bodyText || !draft.bodyText) continue;

    examples.push({
      candidateName: draft.thread.candidate?.name ?? 'the candidate',
      candidateMessage: lastCandidateMsg.bodyText.slice(0, 800).trim(),
      ourReply: draft.bodyText.slice(0, 600).trim(),
    });
    if (examples.length >= 3) break;
  }
  return examples;
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
      return;
    }

    // Pub/Sub at-least-once: skip if we've already processed this exact
    // (mailbox, historyId) in the last 5 minutes.
    if (isWebhookDuplicate(mailbox.id, notification.historyId)) {
      await logEvent(
        'WEBHOOK_DUPLICATE_SKIPPED',
        { mailboxId: mailbox.id, historyId: notification.historyId },
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
    console.error('[Gmail Webhook] Failed to process notification:', err);
    throw err;
  }
}

/**
 * Re-classify threads in a mailbox that have stored messages but no linked
 * candidate (i.e. fetchAndStoreMessage stored the message but classifyAndDraft
 * returned early or failed).
 *
 * Works entirely from data already in the DB — does NOT call Gmail API — so it
 * is safe to call even when the mailbox credentials are broken.
 *
 * Returns the count of threads that were successfully re-classified.
 */
export async function reclassifyOrphanedThreads(mailboxId: string): Promise<{ threadsFound: number; threadsClassified: number }> {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return { threadsFound: 0, threadsClassified: 0 };

  // Threads that have at least one stored message but no candidate attached.
  const orphanedThreads = await prisma.emailThread.findMany({
    where: {
      mailboxId,
      candidateId: null,
      messages: { some: {} },
    },
    include: {
      messages: { orderBy: { receivedAt: 'asc' } },
    },
  });

  let classified = 0;
  for (const thread of orphanedThreads) {
    // Find the most recent inbound message (not sent by the mailbox owner).
    const inbound = thread.messages
      .filter((m) => m.fromAddress.toLowerCase() !== mailbox.emailAddress.toLowerCase())
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    const latest = inbound[0];
    if (!latest) continue; // outbound-only thread, skip

    // Reconstruct a ParsedGmailMessage from stored DB fields.
    let toAddresses: string[] = [];
    let headers = { messageId: '', inReplyTo: '', references: '', cc: '' };
    try {
      toAddresses = JSON.parse(latest.toAddresses) as string[];
    } catch { /* ignore */ }
    try {
      headers = JSON.parse(latest.headers) as typeof headers;
    } catch { /* ignore */ }

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
      console.error(`[reclassifyOrphanedThreads] Failed for thread ${thread.id}:`, err);
    }
  }

  await logEvent(
    'RECLASSIFY_ORPHANED_THREADS',
    { mailboxId, threadsFound: orphanedThreads.length, threadsClassified: classified },
    'INFO'
  );

  return { threadsFound: orphanedThreads.length, threadsClassified: classified };
}
