import { Router } from "express";
import {
  authenticate,
  AuthenticatedRequest,
} from "./auth.middleware";
import { authorize } from "./authorization.middleware";
import { Role } from "../../generated/prisma/enums";
import prisma from "../config/database";
import { listUserOrganizations, switchUserOrganization } from "./auth.service";
import { OrganizationPermissionError } from "../organization/organization.service";
import { requestFields } from "../http/api.boundary";

const router = Router();
router.post("/logout", authenticate, async (req: AuthenticatedRequest, res) => {
  if (Object.keys(req.query).length || (req.body !== undefined &&
    (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)))
    return res.status(400).json({ success: false, message: "Sign out does not accept request fields." });
  try {
    // Upsert makes concurrent sign-out submissions safe. Never store the token
    // itself, and revoke only the authenticated credential, not another session.
    await prisma.revokedToken.upsert({
      where: { tokenHash: req.auth!.tokenHash }, update: {},
      create: { tokenHash: req.auth!.tokenHash, expiresAt: req.auth!.expiresAt, userId: req.user!.userId },
    });
    return res.json({ success: true, data: { signedOut: true } });
  } catch {
    return res.status(503).json({ success: false, message: "Server sign-out could not be confirmed." });
  }
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorId(req: AuthenticatedRequest) {
  if (!req.user || !uuid.test(req.user.userId))
    throw new OrganizationPermissionError(401, "Valid user identity is required");
  return req.user.userId;
}
function failure(res: import("express").Response, error: unknown) {
  const status = error instanceof OrganizationPermissionError ? error.status : 500;
  return res.status(status).json({ success: false, message: "Organization session request could not be completed" });
}

// These account-level actions can recover from removal from the active team,
// but list/switch only memberships belonging to the signed-in user.
router.get("/organizations", authenticate, requestFields(), async (req: AuthenticatedRequest, res) => {
  try { return res.json({ success: true, data: await listUserOrganizations(actorId(req)) }); }
  catch (error) { return failure(res, error); }
});
router.post("/switch-organization", authenticate, requestFields({ body: ["organizationId"], required: ["organizationId"] }), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = actorId(req);
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "organizationId") ||
        typeof body.organizationId !== "string" || !uuid.test(body.organizationId))
      throw new OrganizationPermissionError(400, "Provide only a valid organization ID");
    return res.json({ success: true, data: await switchUserOrganization(userId, body.organizationId) });
  } catch (error) { return failure(res, error); }
});

router.get(
  "/me",
  authenticate,
  requestFields(),
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = actorId(req);
      const organizationId = req.user?.organizationId;
      if (typeof organizationId !== "string" || !uuid.test(organizationId))
        throw new OrganizationPermissionError(401, "Valid organization context is required");
      const membership = await prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } }, select: { role: true },
      });
      if (!membership) return res.status(403).json({ success: false,
        code: "ORGANIZATION_ACCESS_REVOKED", message: "Current membership is required." });
    return res.status(200).json({
      success: true,
      message: "Authenticated user",
      data: {
        userId: req.user?.userId,
        organizationId: req.user?.organizationId,
        role: membership.role,
        expiresAt: req.auth!.expiresAt.toISOString(),
      },
    });
    } catch (error) { return failure(res, error); }
  }
);

router.get(
  "/admin-test",
  authenticate,
  requestFields(),
  authorize(Role.OWNER, Role.ADMIN),
  (req: AuthenticatedRequest, res) => {
    return res.status(200).json({
      success: true,
      message: "You have admin-level access",
      data: {
        userId: req.user?.userId,
        organizationId: req.user?.organizationId,
        role: req.user?.role,
      },
    });
  }
);

export default router;
