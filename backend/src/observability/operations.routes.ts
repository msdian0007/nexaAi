import { Router } from "express";
import prisma from "../config/database";
import { authenticate, type AuthenticatedRequest } from "../auth/auth.middleware";
import { requestFields, UUID } from "../http/api.boundary";
import { getDocumentQueue } from "../document/document.queue.runtime";
import { measure } from "./telemetry";

const router = Router();
router.use(authenticate);
class AccessError extends Error { constructor(public status: number) { super("Operation unavailable"); } }
async function manager(tx: Pick<typeof prisma, "organizationMember">, req: AuthenticatedRequest) {
  const { userId, organizationId } = req.user!;
  const member = await tx.organizationMember.findUnique({ where: { userId_organizationId: { userId, organizationId } }, select: { role: true } });
  if (!member || member.role === "MEMBER") throw new AccessError(403);
  return organizationId;
}
const failure = (res: import("express").Response, error: unknown) => res.status(error instanceof AccessError ? error.status : 503)
  .json({ success: false, code: error instanceof AccessError ? "OPERATIONS_FORBIDDEN" : "OPERATIONS_UNAVAILABLE", message: "Operations information is unavailable for this request." });

router.get("/audit", requestFields({ query: ["cursor"] }), async (req: AuthenticatedRequest, res) => {
  try {
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || !UUID.test(cursor))) throw new AccessError(400);
    const data = await measure("database", () => prisma.$transaction(async tx => {
      const organizationId = await manager(tx, req);
      const anchor = cursor ? await tx.auditEvent.findFirst({ where: { id: cursor as string, organizationId }, select: { id: true, createdAt: true } }) : null;
      if (cursor && !anchor) throw new AccessError(404);
      const rows = await tx.auditEvent.findMany({ where: { organizationId, ...(anchor ? { OR: [
        { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } },
      ] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21 });
      return { organizationId, events: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null };
    }, { isolationLevel: "RepeatableRead" }));
    return res.json({ success: true, data });
  } catch (error) { return failure(res, error); }
});

router.get("/summary", requestFields(), async (req: AuthenticatedRequest, res) => {
  try {
    const { organizationId, documents, groups, total } = await measure("database", () => prisma.$transaction(async tx => {
      const organizationId = await manager(tx, req);
      const where = { organizationId, deletionRequestedAt: null };
      return { organizationId, total: await tx.document.count({ where }),
        groups: await tx.document.groupBy({ by: ["status"], where, _count: { _all: true } }),
        documents: await tx.document.findMany({ where, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }) };
    }, { isolationLevel: "RepeatableRead" }));
    const states: Record<string, number> = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, unknown: 0, unavailable: 0 };
    let workersAvailable: boolean | null = null, queueAvailable = false;
    try {
      const queue = await (req.app.locals.getDocumentQueue ?? getDocumentQueue)();
      queueAvailable = await queue.checkConnection();
      if (!queueAvailable) throw new Error("Queue unavailable");
      // A failed worker inspection is unknown, not proof that no worker exists.
      try { workersAvailable = (await queue.workerCount()) > 0; } catch { workersAvailable = null; }
      await measure("queue", () => Promise.all(documents.map(async document => {
        try { const state = await queue.getState({ organizationId, documentId: document.id }); states[Object.prototype.hasOwnProperty.call(states, state) ? state : "unknown"]++; }
        catch { states.unavailable++; }
      })));
    } catch { states.unavailable = documents.length; }
    // Permissions can change while Redis responds. Withhold operational data
    // if a manager was removed/demoted during the external dependency check.
    await manager(prisma, req);
    const failedDocuments = groups.find(group => group.status === "FAILED")?._count._all ?? 0;
    const alerts = [!queueAvailable && "QUEUE_UNAVAILABLE", queueAvailable && workersAvailable === false && "NO_DOCUMENT_WORKER",
      queueAvailable && workersAvailable === null && "WORKER_STATUS_UNAVAILABLE",
      failedDocuments > 0 && "DOCUMENT_FAILURES", states.failed > 0 && "QUEUE_FAILURES", states.waiting + states.delayed >= 20 && "BACKLOG_HIGH",
      states.unavailable > 0 && "JOB_STATES_UNAVAILABLE"].filter((value): value is string => !!value);
    return res.json({ success: true, data: { organizationId, observedAt: new Date().toISOString(), totalDocuments: total,
      failedDocuments, queueAvailable, workersAvailable, sampleSize: documents.length, sampleTruncated: total > documents.length, states, alerts } });
  } catch (error) { return failure(res, error); }
});
export default router;

export async function readiness(req: import("express").Request, res: import("express").Response) {
  let database = false, redis = false;
  // The outer deadline bounds the probe response; it does not cancel a database
  // command already submitted. Normal driver connection limits still apply.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([measure("database", () => prisma.$queryRaw`SELECT 1`), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Dependency deadline")), 5500); })]);
    database = true;
  } catch { /* Return status only, never a connection error or URL. */ }
  finally { clearTimeout(timer); }
  try { redis = await (await (req.app.locals.getDocumentQueue ?? getDocumentQueue)()).checkConnection(); } catch { /* Safe degraded probe. */ }
  return res.status(database && redis ? 200 : 503).json({ success: database && redis, data: { status: database && redis ? "ready" : "not_ready", database, redis } });
}
