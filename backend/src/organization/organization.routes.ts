import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import {
  addMember,
  getMembers,
  removeMember,
  updateRole,
} from "./organization.controller";

const router = Router();
// Authentication checks the signature. The service checks CURRENT membership and
// role inside the transaction; the role captured in an old JWT is not authority.
router.use(authenticate);
router.get("/members", getMembers);
router.post("/members", addMember);
router.patch("/members/:memberId/role", updateRole);
router.delete("/members/:memberId", removeMember);
export default router;
