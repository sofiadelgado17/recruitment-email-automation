import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

const client = new Anthropic({
  apiKey: config.anthropicApiKey,
});

const ARCHIVE_SYSTEM_PROMPT = `You are an expert recruiting assistant for Archive, a company that values exceptional candidate experience. Your role is to help classify candidate email replies and generate personalized, professional responses.

## Archive's Communication Style

**Core Principles:**
- Professional yet personable — warm and human, not corporate
- Focused on the candidate experience — their time and journey matter
- Clear next steps — candidates always know what happens next
- Action-oriented — move conversations forward with purpose
- Concise — respect the candidate's time, no fluff or padding
- Genuine — authentic interest in the person, not just the role

**Tone Guidelines:**
- Start with acknowledgment, not pleasantries
- Be direct about timelines and expectations
- Use first names naturally
- Avoid corporate jargon like "synergy", "leverage", "circle back", "reach out"
- Avoid filler phrases like "Hope this email finds you well"
- Keep emails under 150 words when possible
- Use short paragraphs (1-3 sentences)

**Response Templates by Classification:**

For INTERESTED candidates:
- Acknowledge their interest warmly
- Confirm next steps clearly (interview scheduling, process details)
- Give a specific timeline
- End with a single clear call to action

For NOT_INTERESTED candidates:
- Thank them genuinely for their time and consideration
- Leave the door open professionally
- Be brief and respectful (3-4 sentences max)
- No hard sell or guilt

For NEUTRAL candidates (need more info):
- Acknowledge their questions/concerns directly
- Provide the specific information they need
- Make it easy for them to take the next step
- Keep the conversation moving forward

## Classification Criteria

**INTERESTED signals:**
- Explicitly expresses interest in the role
- Asks about next steps, process, timeline
- Requests more information in a positive tone
- Mentions specific aspects of the role/company they're excited about
- Available for a call/interview

**NOT_INTERESTED signals:**
- Explicitly declines
- Currently happy/not looking
- Already accepted another offer
- Timing isn't right
- Salary/role doesn't match expectations

**NEUTRAL signals:**
- Asking clarifying questions without commitment
- Wants more information before deciding
- Ambiguous response that doesn't clearly indicate direction

## Message Type Criteria (independent of INTERESTED/NEUTRAL/NOT_INTERESTED)

You must ALSO tag each reply with a messageType describing what kind of message it is in the thread:

- **NEW_INQUIRY** — the candidate's first substantive response to outreach, or a fresh introduction. Usually the second message in the thread (recruiter sent one, candidate replied for the first time).
- **FOLLOWUP** — a continuation in an active thread: scheduling specifics after an initial yes, a clarification question, a "still interested?" nudge from the candidate. The thread already has prior back-and-forth.
- **SCHEDULING** — message is purely about calendar coordination ("Tuesday at 3 works", "can we move to Thursday?"). The candidate is still interested, but the body is logistics-only — useful so we can render a different draft style later.
- **OUT_OF_OFFICE** — automatic vacation / out-of-office auto-reply. Usually mentions dates of return, an alternate contact, or says "I am currently out of the office".
- **NOT_RECRUITING_RELATED** — the message has nothing to do with the recruiting conversation (e.g., a forwarded newsletter, an unrelated business proposal, an accidental reply-all).
- **AMBIGUOUS** — you genuinely can't tell what kind of message this is (very short, multi-language, forwarded with no commentary, attachment-only, conflicting signals).

## needsReview Flag

Set needsReview = true when ANY of the following:
- messageType is AMBIGUOUS
- The message looks forwarded with no candidate commentary on top
- It is multi-language and you can't confidently read all parts
- It's attachment-only or otherwise has no useful body
- The classification signal conflicts with the messageType (e.g. INTERESTED but OUT_OF_OFFICE)
- Confidence in classification or messageType is below ~0.7

Set needsReview = false otherwise — i.e. when you are confident in BOTH classification and messageType.

## Role Extraction

You must ALSO try to identify the **role** the candidate is being contacted about — the job title from the recruiter's outreach. This is almost always mentioned somewhere in the thread context, most often inside the candidate's reply where the original outreach is quoted ("On Tue, Mar 5, X wrote: ... I'm reaching out about a Senior Backend Engineer opportunity at Archive...").

Examples of valid roles:
- "Senior Backend Engineer"
- "SMB Customer Success Manager"
- "Head of Product Design"
- "Founding AE"
- "Recruiting Lead"
- "Staff Software Engineer, Platform"

Rules:
- Look first in the quoted recruiter outreach inside the thread context, then in the candidate's current message body.
- Keep the role concise (max ~60 characters), title-case, no leading articles ("the", "a").
- Strip filler like "role", "position", "opportunity" unless it's part of an actual title.
- If no clear role is mentioned (e.g. a vague "thanks for reaching out" with no quoted context, or a clearly NOT_RECRUITING_RELATED / OUT_OF_OFFICE / forwarded message), return null.`;

export type Classification = 'INTERESTED' | 'NOT_INTERESTED' | 'NEUTRAL';

export type MessageType =
  | 'NEW_INQUIRY'
  | 'FOLLOWUP'
  | 'SCHEDULING'
  | 'OUT_OF_OFFICE'
  | 'NOT_RECRUITING_RELATED'
  | 'AMBIGUOUS';

export interface ClassificationResult {
  classification: Classification;
  messageType: MessageType;
  needsReview: boolean;
  confidence: number;
  reasoning: string;
  role: string | null;
}

export interface DraftReplyResult {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export interface ExampleReply {
  candidateName: string;
  candidateMessage: string;
  ourReply: string;
}

export interface ThreadContext {
  subject: string;
  messages: Array<{
    fromAddress: string;
    fromName?: string | null;
    bodyText?: string | null;
    receivedAt: Date;
  }>;
  candidateName: string;
  classification: 'INTERESTED' | 'NOT_INTERESTED' | 'NEUTRAL';
  /** Real sent replies from the same mailbox/Sofia used as few-shot style examples. */
  examples?: ExampleReply[];
  /** HTML signature from Gmail settings — when provided, Claude omits the name sign-off and the caller appends the real signature. */
  signatureHtml?: string | null;
}

/**
 * Identity of the recruiter whose inbox is receiving this message — the persona
 * the draft should be ghostwritten as. We sign each draft as the mailbox owner
 * (e.g. Paul, Em), not as a fixed company-wide persona.
 */
export type DraftCaller = {
  email: string;              // e.g. paul.b@archive.com
  displayName: string | null; // e.g. "Paul Bourgeois" (from Gmail OAuth)
};

/**
 * Derive a first name to sign drafts with. Prefers the OAuth displayName, falls
 * back to the email local-part split on common separators and title-cased.
 *
 * Examples:
 *   { displayName: "Paul Bourgeois", email: "paul.b@archive.com" } → "Paul"
 *   { displayName: null, email: "paul.b@archive.com" }              → "Paul"
 *   { displayName: null, email: "emaenza@archive.com" }             → "Emaenza"
 *   { displayName: null, email: "john_smith@archive.com" }          → "John"
 *   { displayName: "paul.b@archive.com", email: "paul.b@archive.com" } → "Paul"
 */
function deriveFirstName(caller: DraftCaller): string {
  const trimmed = (caller.displayName ?? '').trim();
  const emailLc = caller.email.trim().toLowerCase();
  const looksLikeEmail = trimmed.toLowerCase() === emailLc;
  if (trimmed.length > 0 && !looksLikeEmail) {
    // Take the first whitespace-separated token from the display name.
    const first = trimmed.split(/\s+/)[0] ?? trimmed;
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  const local = (caller.email.split('@')[0] ?? '').trim();
  if (!local) return 'there';
  const firstSegment = local.split(/[._-]/)[0] ?? local;
  if (!firstSegment) return 'there';
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1).toLowerCase();
}

export interface ClassifyThreadContext {
  /** Subject of the thread (for first-vs-followup signal). */
  subject?: string;
  /**
   * Prior messages in the same thread, ordered oldest → newest. Excludes the
   * message currently being classified. Capped by the caller; the function
   * additionally truncates to MAX_CONTEXT_MESSAGES to keep token use bounded.
   */
  previousMessages?: Array<{
    fromAddress: string;
    fromName?: string | null;
    bodyText?: string | null;
    receivedAt: Date;
  }>;
}

// Hard cap on how many prior messages we feed into the classifier prompt.
const MAX_CONTEXT_MESSAGES = 5;
// Hard cap on per-message body length when building the context blob.
const MAX_CONTEXT_BODY_CHARS = 1500;

// Build cached system block - use type assertion for cache_control
// which is supported at runtime but may not be in all SDK type definitions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CACHED_SYSTEM: any[] = [
  {
    type: 'text',
    text: ARCHIVE_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  },
];

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function buildThreadContextBlock(ctx?: ClassifyThreadContext): string {
  if (!ctx || (!ctx.subject && !ctx.previousMessages?.length)) {
    return 'Thread context: (none — treat this as a standalone message).';
  }
  const lines: string[] = [];
  if (ctx.subject) {
    lines.push(`Thread subject: ${ctx.subject}`);
  }
  const prior = (ctx.previousMessages ?? []).slice(-MAX_CONTEXT_MESSAGES);
  if (prior.length === 0) {
    lines.push('No prior messages in this thread — this is the first message we have seen.');
  } else {
    lines.push(`Prior messages in this thread (oldest → newest, last ${prior.length}):`);
    for (const m of prior) {
      const who = m.fromName ?? m.fromAddress;
      const when = m.receivedAt instanceof Date ? m.receivedAt.toISOString() : String(m.receivedAt);
      lines.push(`---`);
      lines.push(`From: ${who} (${m.fromAddress}) at ${when}`);
      lines.push(truncate(m.bodyText, MAX_CONTEXT_BODY_CHARS) || '(no body text)');
    }
    lines.push(`---`);
  }
  return lines.join('\n');
}

const VALID_CLASSIFICATIONS: Classification[] = ['INTERESTED', 'NOT_INTERESTED', 'NEUTRAL'];
const VALID_MESSAGE_TYPES: MessageType[] = [
  'NEW_INQUIRY',
  'FOLLOWUP',
  'SCHEDULING',
  'OUT_OF_OFFICE',
  'NOT_RECRUITING_RELATED',
  'AMBIGUOUS',
];

function safeFallback(reason: string): ClassificationResult {
  return {
    classification: 'NEUTRAL',
    messageType: 'AMBIGUOUS',
    needsReview: true,
    confidence: 0,
    reasoning: `Fallback applied: ${reason}`,
    role: null,
  };
}

const ROLE_MAX_CHARS = 60;

function coerceRole(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'unknown') {
    return null;
  }
  // Strip leading articles
  trimmed = trimmed.replace(/^(the|a|an)\s+/i, '').trim();
  if (!trimmed) return null;
  if (trimmed.length > ROLE_MAX_CHARS) {
    trimmed = trimmed.slice(0, ROLE_MAX_CHARS).trim();
  }
  return trimmed;
}

function coerceClassificationResult(raw: unknown): ClassificationResult {
  if (!raw || typeof raw !== 'object') {
    return safeFallback('response was not an object');
  }
  const r = raw as Record<string, unknown>;

  const classification = VALID_CLASSIFICATIONS.includes(r.classification as Classification)
    ? (r.classification as Classification)
    : 'NEUTRAL';

  const messageType = VALID_MESSAGE_TYPES.includes(r.messageType as MessageType)
    ? (r.messageType as MessageType)
    : 'AMBIGUOUS';

  const confidenceNum =
    typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0;

  const reasoning = typeof r.reasoning === 'string' ? r.reasoning : '';

  // needsReview: trust the model's boolean if present, else derive from
  // confidence + ambiguity signals so callers never see a "looks good" reply
  // that's actually low-trust.
  const modelSaysReview =
    typeof r.needsReview === 'boolean' ? r.needsReview : undefined;
  const derivedReview =
    confidenceNum < 0.7 ||
    messageType === 'AMBIGUOUS' ||
    !VALID_CLASSIFICATIONS.includes(r.classification as Classification) ||
    !VALID_MESSAGE_TYPES.includes(r.messageType as MessageType);

  const needsReview = modelSaysReview ?? derivedReview;

  const role = coerceRole(r.role);

  return {
    classification,
    messageType,
    needsReview,
    confidence: confidenceNum,
    reasoning,
    role,
  };
}

export async function classifyReply(
  emailBody: string,
  candidateName: string,
  threadContext?: ClassifyThreadContext
): Promise<ClassificationResult> {
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: CACHED_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Classify the following email reply from candidate ${candidateName}.

${buildThreadContextBlock(threadContext)}

Respond with a JSON object in this EXACT format (no markdown fences, no commentary):
{
  "classification": "INTERESTED" | "NOT_INTERESTED" | "NEUTRAL",
  "messageType": "NEW_INQUIRY" | "FOLLOWUP" | "SCHEDULING" | "OUT_OF_OFFICE" | "NOT_RECRUITING_RELATED" | "AMBIGUOUS",
  "needsReview": <boolean>,
  "confidence": <number between 0 and 1>,
  "reasoning": "<brief explanation, 1-2 sentences>",
  "role": "<extracted role title or null>"
}

Classify both the candidate's interest (classification) AND the kind of message it is (messageType) using the rules in the system prompt. Use the prior thread context above to distinguish a NEW_INQUIRY (first candidate reply) from a FOLLOWUP (continuation of an existing back-and-forth). Extract the role title following the Role Extraction rules above (concise, max ~60 chars, null if not mentioned).

New message body to classify:
${emailBody}`,
        },
      ],
    });
  } catch (err) {
    // Network / API failure — fail safe so caller can route to NEEDS_REVIEW.
    const message = err instanceof Error ? err.message : String(err);
    return safeFallback(`claude API error: ${message}`);
  }

  const textContent = response.content.find((b) => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    return safeFallback('no text content in response');
  }

  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return safeFallback('no JSON object found in response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return safeFallback(`JSON parse failed: ${message}`);
  }

  return coerceClassificationResult(parsed);
}

// handoffType encodes who is the interviewer and what Sofia's role is:
// - 'coordinator': Aaron/Paul — not interviewers; Sofia schedules and shares role details
// - 'sofia_interviews': Ethan + CSM role — Sofia IS the interviewer; loop her in to schedule
// - 'ethan_interviews_sofia_schedules': Ethan + Influencer Marketing — Ethan interviews, Sofia handles scheduling
export type HandoffType = 'coordinator' | 'sofia_interviews' | 'ethan_interviews_sofia_schedules';

export function getHandoffType(mailboxEmail: string, candidateRole: string | null): HandoffType {
  const email = mailboxEmail.toLowerCase();
  const isEthan = email.includes('ethan');
  if (!isEthan) return 'coordinator';
  const role = (candidateRole ?? '').toLowerCase();
  const isInfluencer = role.includes('influencer');
  return isInfluencer ? 'ethan_interviews_sofia_schedules' : 'sofia_interviews';
}

function handoffInstruction(type: HandoffType, ccName: string, ccEmail: string): string {
  switch (type) {
    case 'coordinator':
      return `I'm looping in ${ccName} (${ccEmail}) — she'll share more details about the position and get some time on the calendar.`;
    case 'sofia_interviews':
      return `I'm looping in ${ccName} (${ccEmail}) — she's the interviewer and will get something on the calendar with you.`;
    case 'ethan_interviews_sofia_schedules':
      return `I'm looping in ${ccName} (${ccEmail}) — she'll coordinate timing for the interview on both our ends.`;
  }
}

export async function generateHandoffDraftReply(
  thread: ThreadContext & { ccName: string; ccEmail: string; handoffType?: HandoffType },
  caller: DraftCaller
): Promise<DraftReplyResult> {
  const messagesContext = thread.messages
    .map((m) => {
      const name = m.fromName ?? m.fromAddress;
      const date = m.receivedAt.toISOString();
      return `From: ${name} (${m.fromAddress}) at ${date}\n${m.bodyText ?? '(no text body)'}`;
    })
    .join('\n\n---\n\n');

  const firstName = deriveFirstName(caller);
  const candidateFirst = thread.candidateName.split(/\s+/)[0] ?? thread.candidateName;
  const handoffType = thread.handoffType ?? 'coordinator';
  const loopInExample = handoffInstruction(handoffType, thread.ccName, thread.ccEmail);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CACHED_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `You are ghostwriting a recruiting reply as ${firstName} (${caller.email}).

The candidate replied to an outreach email. Your job is to write a SHORT, warm reply that:
1. Briefly acknowledges or addresses anything specific the candidate said (a question about the role, a request for the JD, etc.) — but SKIP any mention of specific times or availability the candidate proposed, because ${firstName} does not know ${thread.ccName}'s calendar
2. Loops in ${thread.ccName} using EXACTLY the phrasing provided below — do not paraphrase or change the meaning
3. Does NOT over-explain or add filler — keep it to 2-3 sentences max

Candidate name: ${thread.candidateName}
Thread subject: ${thread.subject}

Full conversation:
${messagesContext}

Respond with a JSON object in this exact format:
{
  "subject": "<reply subject, prefixed Re: if replying>",
  "bodyText": "<plain text body>",
  "bodyHtml": "<HTML body using simple inline styles>"
}

Requirements:
- Open with "Hi ${candidateFirst},"
- Address any specific question/request from the candidate in one sentence if present; do NOT reference or confirm any specific times/dates the candidate mentioned; otherwise skip straight to the loop-in
- Use this loop-in line (keep the wording close to this): "${loopInExample}"
- Close with "Best," on its own line${thread.signatureHtml ? ' — the signature will be appended automatically, do not write a name after Best,' : `\n- Sign off as ${firstName}`}
- Plain text and HTML must match in content`,
      },
    ],
  });

  const textContent = response.content.find((b) => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response');
  const parsed = JSON.parse(jsonMatch[0]) as DraftReplyResult;
  return parsed;
}

export async function rewriteDraftWithNotes(
  currentBodyText: string,
  notes: string,
  candidateName: string,
  caller: DraftCaller
): Promise<DraftReplyResult> {
  const firstName = deriveFirstName(caller);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: CACHED_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `You are ghostwriting a recruiting email as ${firstName} (${caller.email}).

Below is the current draft reply to candidate ${candidateName}. The recruiter has provided notes with guidance on how to revise it. Rewrite the email incorporating those notes while keeping Archive's professional, concise tone.

CURRENT DRAFT:
${currentBodyText}

RECRUITER NOTES / INSTRUCTIONS:
${notes}

Respond with a JSON object in this exact format (no markdown fences, no commentary):
{
  "subject": "<same subject as the original unless the notes say otherwise>",
  "bodyText": "<plain text email body>",
  "bodyHtml": "<HTML formatted email body>"
}

Requirements:
- Incorporate all the recruiter's notes naturally into the reply
- Keep Archive's communication style: concise, warm, direct, no corporate jargon
- HTML and plain text must match in content
- Do NOT add anything the notes don't call for`,
      },
    ],
  });

  const textContent = response.content.find((b) => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response');
  return JSON.parse(jsonMatch[0]) as DraftReplyResult;
}

export async function generateDraftReply(
  thread: ThreadContext,
  caller: DraftCaller
): Promise<DraftReplyResult> {
  const messagesContext = thread.messages
    .map((m) => {
      const name = m.fromName ?? m.fromAddress;
      const date = m.receivedAt.toISOString();
      return `From: ${name} (${m.fromAddress}) at ${date}\n${m.bodyText ?? '(no text body)'}`;
    })
    .join('\n\n---\n\n');

  const firstName = deriveFirstName(caller);

  // Build few-shot examples block from real sent replies
  let examplesBlock = '';
  if (thread.examples && thread.examples.length > 0) {
    const exampleLines = thread.examples
      .map(
        (ex, i) =>
          `EXAMPLE ${i + 1}:\nCandidate wrote:\n"${ex.candidateMessage.trim()}"\n\nWe replied:\n"${ex.ourReply.trim()}"`
      )
      .join('\n\n---\n\n');
    examplesBlock = `\n\nSTYLE EXAMPLES — real replies ${firstName} has sent before. Mirror this exact writing style, length, and tone. If they are short, be short. If they skip pleasantries, skip them:\n\n${exampleLines}`;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: CACHED_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `You are ghostwriting this reply as the mailbox owner. Sign the reply as them — do NOT mention or invent any other Archive recruiter or co-worker.

Persona to write as:
- First name (use this in the sign-off): ${firstName}
- Email: ${caller.email}

Generate a personalized reply email for candidate ${thread.candidateName}.

Thread subject: ${thread.subject}
Classification: ${thread.classification}${examplesBlock}

Full conversation thread:
${messagesContext}

Respond with a JSON object in this exact format:
{
  "subject": "<reply subject line>",
  "bodyText": "<plain text email body>",
  "bodyHtml": "<HTML formatted email body>"
}

Requirements:
- Match the style and length of the examples above if provided — they are ground truth for how ${firstName} writes
- Be appropriate for the classification (${thread.classification})
- Subject should be prefixed with "Re: " if replying to existing thread
- HTML version should use simple formatting (no complex CSS)
- ${thread.signatureHtml ? `End the email body with "Best," on its own line. Do NOT write a name or any contact details after it — the recruiter's full Gmail signature will be appended automatically.` : `Sign off with ${firstName}.`} Do not invent or mention any other person from Archive's team.`,
      },
    ],
  });

  const textContent = response.content.find((b) => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  try {
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const parsed = JSON.parse(jsonMatch[0]) as DraftReplyResult;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse draft reply response: ${err}`);
  }
}
