import { randomUUID, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Role } from "../../generated/prisma/enums";

export const tokenFingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function issueAuthToken(identity: {
  userId: string;
  organizationId: string;
  role: Role;
}) {
  // jti makes two logins in the same second different tokens, so signing out
  // one browser session cannot accidentally revoke another issued session.
  const token = jwt.sign(identity, process.env.JWT_SECRET as string, {
    algorithm: "HS256",
    jwtid: randomUUID(),
    expiresIn: (process.env.JWT_EXPIRES_IN ||
      "1d") as jwt.SignOptions["expiresIn"],
  });
  const payload = jwt.decode(token) as jwt.JwtPayload;
  return { token, expiresAt: new Date(payload.exp! * 1000).toISOString() };
}
