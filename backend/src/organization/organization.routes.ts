import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { authorize } from "../auth/authorization.middleware";
import {
  addMember,
  getMembers,
  removeMember,
  updateRole,
} from "./organization.controller";
import { Role } from "../../generated/prisma/enums";

const router = Router();

router.get(
  "/members",
  authenticate,
  getMembers
);

router.post(
  "/members",
  authenticate,
   authorize(Role.OWNER, Role.ADMIN),
  addMember
);

router.patch(
  "/members/:memberId/role",
  authenticate,
   authorize(Role.OWNER, Role.ADMIN),
  updateRole
);

router.delete(
  "/members/:memberId",
  authenticate,
   authorize(Role.OWNER, Role.ADMIN),
  removeMember
);

export default router;