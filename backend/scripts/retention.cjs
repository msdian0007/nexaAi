// Dry-run by default. Applying deletion is an explicit operator action, never a
// side effect of starting the API, viewing audit history or running tests.
const prisma = require('../dist/src/config/database').default;
async function run() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Unsupported argument');
  const now = new Date(), cutoff = new Date(now.getTime() - 90 * 86400000);
  const auditWhere = { createdAt: { lt: cutoff } }, revokedWhere = { expiresAt: { lte: now } };
  // Historical failures may predate the safe-message policy. Do not change
  // documents/chats or active processing; normalize only legacy failure text.
  const legacyWhere = { status: 'FAILED', errorMessage: { notIn: ['Document processing failed.', 'Document processing was interrupted. Retry the document.'] } };
  const apply = process.argv.includes('--apply');
  const counts = apply ? await prisma.$transaction(async tx => ({
    auditEvents: (await tx.auditEvent.deleteMany({ where: auditWhere })).count,
    expiredRevocations: (await tx.revokedToken.deleteMany({ where: revokedWhere })).count,
    legacyFailureMessages: (await tx.document.updateMany({ where: legacyWhere, data: { errorMessage: 'Document processing failed.' } })).count,
  })) : { auditEvents: await prisma.auditEvent.count({ where: auditWhere }), expiredRevocations: await prisma.revokedToken.count({ where: revokedWhere }), legacyFailureMessages: await prisma.document.count({ where: legacyWhere }) };
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry_run', auditCutoff: cutoff.toISOString(), ...counts }));
}
run().catch(() => { console.error('Retention operation failed. No private details printed.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
