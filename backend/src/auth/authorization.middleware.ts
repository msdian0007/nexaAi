import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.middleware";
import type { Role } from "../../generated/prisma/enums";
import prisma from "../config/database";

export const authorize = (...allowedRoles: Role[]) => async (
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) => {
  if (!req.user) return res.status(401).json({ success: false, message: "Please sign in again." });
  try {
    // A signed role describes issuance time. Current membership controls access.
    const member = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId: req.user.userId, organizationId: req.user.organizationId } },
      select: { role: true },
    });
    if (!member || !allowedRoles.includes(member.role))
      return res.status(403).json({ success: false, message: "Current organization permission is required." });
    req.user.role = member.role;
    return next();
  } catch {
    return res.status(503).json({ success: false, message: "Permission verification is unavailable." });
  }
};
