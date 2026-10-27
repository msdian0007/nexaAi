import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";

type Context = { requestId: string; organizationId?: string; userId?: string; documentId?: string; jobId?: string; attempt?: number };
export type Stage = "database" | "retrieval" | "embedding" | "generation" | "extraction" | "chunking" | "worker" | "queue";
export type LogRecord = Context & { timestamp: string; event: "http_completed" | "http_aborted" | "stage_completed" | "job_submitted"; stage?: Stage; outcome?: "ok" | "failed"; durationMs?: number; status?: number; method?: string; route?: string };
export type LogSink = (record: LogRecord) => void;
const storage = new AsyncLocalStorage<{ context: Context; sink: LogSink }>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultSink: LogSink = record => { console.log(JSON.stringify(record)); };
export const traceId = () => storage.getStore()?.context.requestId;
export function submitted(documentId: string, organizationId: string, jobId: string) {
  const current = storage.getStore();
  if (current) storage.run({ ...current, context: { ...current.context, documentId, organizationId, jobId } }, () => emit("job_submitted"));
}
export function identify(userId: string, organizationId: string) {
  const current = storage.getStore();
  if (current && uuid.test(userId) && uuid.test(organizationId)) Object.assign(current.context, { userId, organizationId });
}
// Construct records from an explicit metadata contract. Never spread requests,
// exceptions, query arguments, headers or document contents into a log event.
export function emit(event: LogRecord["event"], fields: Pick<LogRecord, "stage" | "outcome" | "durationMs" | "status" | "method" | "route"> = {}) {
  const current = storage.getStore();
  if (!current) return;
  if (!["http_completed", "http_aborted", "stage_completed", "job_submitted"].includes(event)) return;
  const safe: typeof fields = {};
  if (fields.stage && ["database", "retrieval", "embedding", "generation", "extraction", "chunking", "worker", "queue"].includes(fields.stage)) safe.stage = fields.stage;
  if (fields.outcome === "ok" || fields.outcome === "failed") safe.outcome = fields.outcome;
  if (typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs) && fields.durationMs >= 0) safe.durationMs = fields.durationMs;
  if (typeof fields.status === "number" && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599) safe.status = fields.status;
  if (fields.method && ["GET", "POST", "PATCH", "DELETE", "OPTIONS", "HEAD", "OTHER"].includes(fields.method)) safe.method = fields.method;
  if (fields.route && (fields.route === "unmatched" || /^\/[a-zA-Z0-9/:_-]{0,120}$/.test(fields.route))) safe.route = fields.route;
  try { current.sink({ ...current.context, timestamp: new Date().toISOString(), event, ...safe }); }
  catch { /* A broken log destination must not repeat or fail an accepted write. */ }
}
export async function measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
  const start = performance.now(); let outcome: "ok" | "failed" = "ok";
  try { return await work(); } catch (error) { outcome = "failed"; throw error; }
  finally { emit("stage_completed", { stage, outcome, durationMs: Math.round((performance.now() - start) * 100) / 100 }); }
}
export function withJobTrace<T>(data: { requestId?: string; organizationId: string; documentId: string }, jobId: string, work: () => Promise<T>, sink: LogSink = defaultSink, attempt = 1) {
  return storage.run({ context: { requestId: data.requestId && uuid.test(data.requestId) ? data.requestId : randomUUID(),
    organizationId: data.organizationId, documentId: data.documentId, jobId: /^[a-zA-Z0-9_-]{1,160}$/.test(jobId) ? jobId : "invalid-job",
    attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1 }, sink }, () => measure("worker", work));
}
export function requestTelemetry(sink: LogSink = defaultSink): RequestHandler {
  return (req, res, next) => {
    const context: Context = { requestId: randomUUID() };
    // Caller-supplied IDs are deliberately ignored to prevent forged correlation.
    res.setHeader("X-Request-ID", context.requestId);
    const start = performance.now(); let recorded = false;
    const finish = (aborted: boolean) => {
      if (recorded) return; recorded = true;
      const route = typeof req.route?.path === "string" && /^\/[a-zA-Z0-9/:_-]{0,120}$/.test(req.route.path) ? req.route.path : "unmatched";
      storage.run({ context, sink }, () => emit(aborted ? "http_aborted" : "http_completed", {
        method: ["GET", "POST", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(req.method) ? req.method : "OTHER",
        route, status: res.statusCode, durationMs: Math.round((performance.now() - start) * 100) / 100,
      }));
    };
    res.once("finish", () => finish(false));
    res.once("close", () => finish(!res.writableFinished));
    storage.run({ context, sink }, next);
  };
}
