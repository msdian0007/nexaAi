import { Router } from "express";
import {
  authenticate,
  AuthenticatedRequest,
} from "./auth.middleware";
import { authorize } from "./authorization.middleware";
import { Role } from "../../generated/prisma/enums";

const router = Router();

router.get(
  "/me",
  authenticate,
  (req: AuthenticatedRequest, res) => {
    return res.status(200).json({
      success: true,
      message: "Authenticated user",
      data: {
        userId: req.user?.userId,
        organizationId: req.user?.organizationId,
        role: req.user?.role,
      },
    });
  }
);

router.get(
  "/admin-test",
  authenticate,
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