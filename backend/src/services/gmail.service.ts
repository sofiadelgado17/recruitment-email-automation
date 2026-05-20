import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { prisma } from '../db/client';
import { classifyReply, generateDraftReply } from './claude.service';
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
  const mailbox = await prisma.mailbox.upsert({
    where: { emailAddress },
    update: {
      credentials: encryptedCreds,
      displayName: resolvedDisplayName,
      isActive: true,
      // Reset historyId baseline on reconnect so the next webhook starts fresh.
      lastHistoryId: baselineHistoryId,
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
    { mailboxId: mailbox.id, emailAddress, displayName: resolvedDisplayName },
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
  headers: Record<string, string>;
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
    headers: { messageId, inReplyTo, references },
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

const MAX_THREAD_CONTEXT_MESSAGES = 5;

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
        fromAddress: parsed.fromAddress,
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
  const previousMessages = allMessages
    .filter((m) => m.externalMessageId !== parsed.externalMessageId)
    .slice(-MAX_THREAD_CONTEXT_MESSAGES)
    .map((m) => ({
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      bodyText: m.bodyText,
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
    classificationResult = await classifyReply(
      parsed.bodyText || parsed.bodyHtml || parsed.subject,
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

  const { classification, messageType, needsReview, confidence } = classificationResult;

  // ---- Routing decisions ----------------------------------------------------
  // NOT_RECRUITING_RELATED: don't pollute the candidate table at all.
  if (messageType === 'NOT_RECRUITING_RELATED') {
    await logEvent(
      'MESSAGE_SKIPPED_NOT_RECRUITING',
      {
        mailboxId: mailbox.id,
        messageId: parsed.externalMessageId,
        fromAddress: parsed.fromAddress,
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

  const candidate = await prisma.candidate.upsert({
    where: { email: parsed.fromAddress },
    update: {
      status: finalStatus,
      mailboxId: mailbox.id,
      updatedAt: new Date(),
    },
    create: {
      name: parsed.fromName ?? parsed.fromAddress,
      email: parsed.fromAddress,
      status: finalStatus,
      mailboxId: mailbox.id,
      source: 'EMAIL_REPLY',
    },
  });

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

  // 5. Existing behavior: only auto-draft for INTERESTED candidates.
  if (classification !== 'INTERESTED') return;

  try {
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
      },
      // Ghostwrite the draft as the mailbox owner (Paul / Em / etc.), not as a
      // fixed company-wide persona. Sofia is the CC recipient (Phase I), not
      // the sender persona.
      {
        email: mailbox.emailAddress,
        displayName: mailbox.displayName,
      }
    );

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
  externalMessageId: string
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
      // Recruiter replied via Gmail/Superhuman directly. If this thread maps
      // to a candidate, mark the candidate as replied.
      if (thread.candidateId) {
        await prisma.candidate.update({
          where: { id: thread.candidateId },
          data: { repliedAt: parsed.receivedAt },
        });
      }
      return true;
    }

    // Inbound: classify + maybe draft
    await classifyAndDraft({ mailbox, thread, parsed });
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
 * `maxResults` is capped at 250 to stay within Vercel's serverless timeout
 * during connect-time backfills.
 */
export async function syncMessages(
  mailboxId: string,
  opts: { maxResults?: number; daysBack?: number } = {}
): Promise<{ messagesSeen: number; messagesStored: number }> {
  const maxResults = Math.min(opts.maxResults ?? 100, 250);
  const daysBack = opts.daysBack ?? 7;

  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !mailbox.isActive) return { messagesSeen: 0, messagesStored: 0 };

  const credentials = parseCredentials(mailbox);
  const oauth2Client = getAuthenticatedClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Get messages from the last N days
  const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${after}`,
    maxResults,
  });

  const messages = listRes.data.messages ?? [];
  let stored = 0;

  for (const msg of messages) {
    if (!msg.id) continue;
    const didStore = await fetchAndStoreMessage(gmail, mailbox, msg.id);
    if (didStore) stored += 1;
  }

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
    { mailboxId, messagesSeen: messages.length, messagesStored: stored },
    'INFO'
  );

  return { messagesSeen: messages.length, messagesStored: stored };
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

  const credentials = parseCredentials(mailbox);
  const oauth2Client = getAuthenticatedClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
    // Gmail returns 404 if startHistoryId is too old (>7d). Fall back to full sync.
    const errObj = err as { code?: number; status?: number };
    if (errObj?.code === 404 || errObj?.status === 404) {
      console.warn(
        `[Gmail] historyId expired for ${mailbox.emailAddress}, falling back to full sync`
      );
      await syncMessages(mailboxId);
      return 0;
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

  const credentials = parseCredentials(mailbox);
  const oauth2Client = getAuthenticatedClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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

  const credentials = parseCredentials(mailbox);
  const oauth2Client = getAuthenticatedClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
  headers.push(`Content-Type: text/plain; charset=utf-8`);

  // CRITICAL: Set In-Reply-To and References for Superhuman threading
  if (draft.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${draft.inReplyToMessageId}`);
  }
  if (draft.referencesHeader) {
    headers.push(`References: ${draft.referencesHeader}`);
  }

  const rawEmail = headers.join('\r\n') + '\r\n\r\n' + draft.bodyText;
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

  const credentials = parseCredentials(mailbox);
  const oauth2Client = getAuthenticatedClient(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  await gmail.users.drafts.send({
    userId: 'me',
    requestBody: {
      id: externalDraftId,
    },
  });
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
