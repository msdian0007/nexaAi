import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "../../generated/prisma/enums";
import prisma from "../config/database";
import { tokenFingerprint } from "./auth.tokens";

export interface AuthenticatedRequest extends Request {
  user?: { userId: string; organizationId: string; role: Role };
  auth?: { tokenHash: string; expiresAt: Date };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  const deny = (code = "INVALID_SESSION") => res.status(401).json({
    success: false, code, message: "Please sign in again.",
  });
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
  if (!match) return deny();
  let identity: { userId: string; organizationId: string; role: Role };
  let expiresAt: Date;
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET as string, { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.userId !== "string" || !uuid.test(payload.userId) ||
      typeof payload.organizationId !== "string" || !uuid.test(payload.organizationId) ||
      !["OWNER", "ADMIN", "MEMBER"].includes(payload.role) || !Number.isSafeInteger(payload.exp) || payload.exp! <= 0)
      return deny();
    expiresAt = new Date(payload.exp! * 1000);
    if (!Number.isFinite(expiresAt.getTime())) return deny();
    identity = { userId: payload.userId, organizationId: payload.organizationId, role: payload.role };
  } catch (error) {
    // Never log raw token failures or payloads. Signature, expiry and algorithm
    // validation happen before touching the database.
    return deny(error instanceof jwt.TokenExpiredError ? "SESSION_EXPIRED" : "INVALID_SESSION");
  }
  try {
    const tokenHash = tokenFingerprint(match[1]);
    if (await prisma.revokedToken.findUnique({ where: { tokenHash }, select: { tokenHash: true } }))
      return deny("SESSION_REVOKED");
    req.user = identity;
    req.auth = { tokenHash, expiresAt };
    // Membership remains an executor/permission check: account-level list/switch
    // and logout must work after removal from the currently selected team.
    return next();
  } catch {
    // A revocation-store outage must not grant access or pretend the token expired.
    return res.status(503).json({ success: false, code: "SESSION_UNAVAILABLE", message: "Session verification is unavailable. Please try again later." });
  }
};
