/**
 * One-off: find candidates whose thread contains the vague "Paul here, CEO /
 * adding to our marketing team" outreach (which never names a role title), and
 * set role = 'Product Marketing Lead' on those with role = null.
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

  const threads = await prisma.emailThread.findMany({
    where: { id: { in: [...matchingThreadIds] }, candidateId: { not: null } },
    select: {
      candidateId: true,
      subject: true,
      candidate: { select: { name: true, email: true, role: true } },
    },
  });

  const toUpdate = threads.filter((t) => t.candidateId && !t.candidate?.role);
  const skipped = threads.filter((t) => t.candidate?.role);

  if (skipped.length > 0) {
    console.log('\nAlready have a role (skipping):');
    for (const t of skipped) {
      console.log(`  ${t.candidate?.name} <${t.candidate?.email}> → "${t.candidate?.role}"`);
    }
  }

  if (toUpdate.length === 0) {
    console.log('\nNothing to update.');
    return;
  }

  console.log(`\n${DRY_RUN ? '[dry-run] Would set' : 'Setting'} role = "${ROLE}" for ${toUpdate.length} candidate(s):`);
  for (const t of toUpdate) {
    console.log(`  ${t.candidate?.name} <${t.candidate?.email}>`);
  }

  if (DRY_RUN) return;

  const candidateIds = toUpdate.map((t) => t.candidateId as string);
  const result = await prisma.candidate.updateMany({
    where: { id: { in: candidateIds } },
    data: { role: ROLE },
  });

  console.log(`\nDone. Updated ${result.count} candidate(s).`);
}

main()
  .catch(console.error)
  .finally(() => void prisma.$disconnect());
