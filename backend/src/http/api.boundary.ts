import express from "express";
import type { Express, RequestHandler, ErrorRequestHandler } from "express";
import cors from "cors";

export class ApiInputError extends Error {
  constructor(public status = 400, public code = "INVALID_REQUEST", message = "Check the allowed request fields and try again.") { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestFields(options: { body?: readonly string[]; required?: readonly string[]; query?: readonly string[]; ids?: readonly string[] } = {}): RequestHandler {
  return (req, res, next) => {
    // Field allowlists stop silently ignored identity/role overrides. Existing
    // controllers still validate the meaning and range of individual values.
    const bodyKeys = options.body ?? [];
    if (Object.keys(req.query).some(key => !(options.query ?? []).includes(key)) ||
      (req.body !== undefined && (!record(req.body) || Object.keys(req.body).some(key => !bodyKeys.includes(key)))) ||
      (options.required ?? []).some(key => !record(req.body) || !Object.prototype.hasOwnProperty.call(req.body, key)) ||
      (options.ids ?? []).some(key => typeof req.params[key] !== "string" || !UUID.test(req.params[key] as string)))
      return res.status(400).json({ success: false, code: "INVALID_REQUEST", message: "Check the allowed request fields and try again." });
    return next();
  };
}

export function allowedOrigins(value = process.env.API_ALLOWED_ORIGINS, nodeEnv = process.env.NODE_ENV): string[] {
  if (value === undefined) {
    if (nodeEnv === "production") throw new Error("API_ALLOWED_ORIGINS is required in production.");
    return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"];
  }
  const origins = value.split(",").map(item => item.trim());
  if (!origins.length || origins.some(origin => {
    try { const url = new URL(origin); return !["http:", "https:"].includes(url.protocol) || url.origin !== origin; }
    catch { return true; }
  })) throw new Error("API_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.");
  return [...new Set(origins)];
}

export function installApiBoundary(app: Express, origins = allowedOrigins()) {
  const allowed = new Set(origins);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.vary("Origin");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    // Missing Origin is normal for CLI/server clients. Authentication remains
    // mandatory; an origin allowlist is not proof of user identity.
    if (req.headers.origin && !allowed.has(req.headers.origin)) return next(new ApiInputError(403, "ORIGIN_NOT_ALLOWED", "This frontend origin is not allowed."));
    next();
  });
  app.use(cors({ origin: (origin, callback) => callback(null, origin ? allowed.has(origin) : false),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type", "Accept"], exposedHeaders: ["Retry-After", "X-Request-ID"], credentials: false, maxAge: 600 }));
  app.use((req, _res, next) => {
    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || !!req.headers["transfer-encoding"];
    if (hasBody && req.path !== "/api/v1/documents/upload" && !req.is("application/json"))
      return next(new ApiInputError(415, "UNSUPPORTED_CONTENT_TYPE", "Use application/json for request data."));
    next();
  });
  // Bound parsing before any controller. Compressed bodies are not accepted, so
  // a small compressed request cannot expand into an unbounded JSON document.
  app.use(express.json({ limit: 32 * 1024, strict: true, inflate: false }));
}

export const apiError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  res.setHeader("Cache-Control", "no-store");
  if (error instanceof ApiInputError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  const type = error?.type;
  if (type === "entity.too.large") return res.status(413).json({ success: false, code: "REQUEST_TOO_LARGE", message: "Request data exceeds the 32 KiB JSON limit." });
  if (type === "entity.parse.failed" || error instanceof URIError) return res.status(400).json({ success: false, code: "INVALID_REQUEST", message: "Provide valid request data." });
  if (type === "encoding.unsupported" || type === "charset.unsupported") return res.status(415).json({ success: false, code: "UNSUPPORTED_ENCODING", message: "Use uncompressed UTF-8 JSON." });
  // Never echo arbitrary exception messages, stack traces, SQL or request data.
  return res.status(500).json({ success: false, code: "INTERNAL_ERROR", message: "The request could not be completed. Please try again later." });
};
