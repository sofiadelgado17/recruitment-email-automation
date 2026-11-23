/**
 * One-off: find candidates (and skipped threads) whose thread contains the
 * vague "Paul here, CEO / adding to our marketing team" outreach template
 * (which never names a role title), then:
 *
 *   A) For threads WITH an existing candidate but role = null → set role.
 *   B) For threads with NO candidate but with a reply from the person →
 *      create the candidate with role = 'Product Marketing Lead' and
 *      status = 'PENDING', then link the thread to them.
 *      This covers people who were logged as MESSAGE_SKIPPED_NO_ROLE because
 *      no candidate row was ever created.
 *
 *   # dry run (default):
 *   npx tsx scripts/set-pml-role.ts
 *   # apply:
 *   npx tsx scripts/set-pml-role.ts --apply
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');
const ROLE = 'Product Marketing Lead';

const MATCH_PHRASES = [
  'adding to our marketing team',
  'Paul here, CEO of Archive',
];

async function main() {
  if (DRY_RUN) console.log('[dry-run] pass --apply to write changes\n');

  const mailboxes = await prisma.mailbox.findMany({ select: { id: true, emailAddress: true } });
  const mailboxEmails = new Set(mailboxes.map((m) => m.emailAddress.toLowerCase()));

  // Find outbound messages (sent FROM a recruiter mailbox) matching the outreach template.
  const outboundMessages = await prisma.emailMessage.findMany({
    where: {
      OR: MATCH_PHRASES.map((phrase) => ({ bodyText: { contains: phrase, mode: 'insensitive' as const } })),
    },
    select: {
      fromAddress: true,
      thread: { select: { id: true } },
    },
  });

  const matchingThreadIds = new Set(
    outboundMessages
      .filter((m) => mailboxEmails.has(m.fromAddress.toLowerCase()))
      .map((m) => m.thread.id)
  );

  if (matchingThreadIds.size === 0) {
    console.log('No threads matched the outreach template text.');
    return;
  }

  console.log(`Matched ${matchingThreadIds.size} thread(s).`);

  // Load all matching threads with their candidate and inbound messages.
  const threads = await prisma.emailThread.findMany({
    where: { id: { in: [...matchingThreadIds] } },
    select: {
      id: true,
      mailboxId: true,
      subject: true,
      candidateId: true,
      candidate: { select: { name: true, email: true, role: true } },
      messages: {
        select: { fromAddress: true, fromName: true, receivedAt: true },
        orderBy: { receivedAt: 'asc' },
      },
    },
  });

  // --- A: threads with an existing candidate missing a role ---
  const toUpdate = threads.filter((t) => t.candidateId && !t.candidate?.role);
  const alreadyHasRole = threads.filter((t) => t.candidate?.role);

  // --- B: threads with NO candidate but with an inbound reply ---
  const toCreate = threads
    .filter((t) => !t.candidateId)
    .map((t) => {
      const inbound = t.messages.find((m) => !mailboxEmails.has(m.fromAddress.toLowerCase()));
      return inbound ? { thread: t, inbound } : null;
    })
    .filter(Boolean) as Array<{ thread: typeof threads[0]; inbound: { fromAddress: string; fromName: string | null; receivedAt: Date } }>;

  const noReply = threads.filter(
    (t) => !t.candidateId && !t.messages.some((m) => !mailboxEmails.has(m.fromAddress.toLowerCase()))
  );

  // Report
  if (alreadyHasRole.length > 0) {
    console.log('\nAlready have a role (skipping):');
    for (const t of alreadyHasRole) {
      console.log(`  ${t.candidate?.name} <${t.candidate?.email}> → "${t.candidate?.role}"`);
    }
  }
  if (noReply.length > 0) {
    console.log(`\nThreads with no inbound reply (skipping ${noReply.length}):`);
    for (const t of noReply) console.log(`  thread ${t.id} "${t.subject}"`);
  }

  console.log(`\n--- A: set role on ${toUpdate.length} existing candidate(s) ---`);
  for (const t of toUpdate) console.log(`  ${t.candidate?.name} <${t.candidate?.email}>`);

  console.log(`\n--- B: create ${toCreate.length} new candidate(s) + link thread ---`);
  for (const { thread, inbound } of toCreate) {
    console.log(`  ${inbound.fromName ?? inbound.fromAddress} <${inbound.fromAddress}> (thread "${thread.subject}")`);
  }

  if (toUpdate.length === 0 && toCreate.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No changes written. Re-run with --apply.');
    return;
  }

  // Apply A: update existing candidates.
  if (toUpdate.length > 0) {
    const ids = toUpdate.map((t) => t.candidateId as string);
    const r = await prisma.candidate.updateMany({ where: { id: { in: ids } }, data: { role: ROLE } });
    console.log(`\nA: updated ${r.count} candidate(s).`);
  }

  // Apply B: create missing candidates and link their threads.
  let created = 0;
  for (const { thread, inbound } of toCreate) {
    // Skip if another message already created the candidate (race guard).
    const existing = await prisma.candidate.findUnique({ where: { email: inbound.fromAddress.toLowerCase() } });
    if (existing) {
      // Just link the thread and set role if missing.
      await prisma.emailThread.update({ where: { id: thread.id }, data: { candidateId: existing.id } });
      if (!existing.role) {
        await prisma.candidate.update({ where: { id: existing.id }, data: { role: ROLE } });
      }
      console.log(`  Linked existing candidate ${existing.email} to thread ${thread.id}`);
      continue;
    }

    const candidate = await prisma.candidate.create({
      data: {
        name: inbound.fromName ?? inbound.fromAddress,
        email: inbound.fromAddress.toLowerCase(),
        role: ROLE,
        status: 'PENDING',
        mailboxId: thread.mailboxId,
        lastInboundAt: inbound.receivedAt,
      },
    });
    await prisma.emailThread.update({ where: { id: thread.id }, data: { candidateId: candidate.id } });
    console.log(`  Created candidate ${candidate.name} <${candidate.email}> → linked to thread ${thread.id}`);
    created += 1;
  }

  console.log(`\nB: created ${created} candidate(s).`);
  console.log('\nDone.');
}

main()
  .catch(console.error)
  .finally(() => void prisma.$disconnect());
