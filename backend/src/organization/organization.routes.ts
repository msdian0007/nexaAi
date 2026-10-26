import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { requestFields } from "../http/api.boundary";
import {
  addMember,
  getMembers,
  removeMember,
  updateRole,
  getProfile,
  updateProfile,
  acceptInvitation,
  createInvitation,
  getInvitations,
  revokeInvitation,
} from "./organization.controller";

const router = Router();
// Authentication checks the signature. The service checks CURRENT membership and
// role inside the transaction; the role captured in an old JWT is not authority.
router.use(authenticate);
router.get("/profile", requestFields(), getProfile);
router.patch("/profile", requestFields({ body: ["name"], required: ["name"] }), updateProfile);
router.get("/invitations", requestFields(), getInvitations);
router.post("/invitations", requestFields({ body: ["email", "role", "expiresInDays"], required: ["email"] }), createInvitation);
router.post("/invitations/accept", requestFields({ body: ["token"], required: ["token"] }), acceptInvitation);
router.delete("/invitations/:invitationId", requestFields({ ids: ["invitationId"] }), revokeInvitation);
router.get("/members", requestFields(), getMembers);
router.post("/members", requestFields({ body: ["email", "role"], required: ["email"] }), addMember);
router.patch("/members/:memberId/role", requestFields({ body: ["role"], required: ["role"], ids: ["memberId"] }), updateRole);
router.delete("/members/:memberId", requestFields({ ids: ["memberId"] }), removeMember);
export default router;
