import { Router } from "express";
import type { ErrorRequestHandler } from "express";
import { authenticate } from "../auth/auth.middleware";
import type { AuthenticatedRequest } from "../auth/auth.middleware";
import {
  AgentIdentityError,
  AgentMembershipError,
} from "../agents/agent.access";
import { DashboardInputError } from "./dashboard.contracts";
import { getDashboardSummary } from "./dashboard.service";

const router = Router();
// Apply before authentication so private counts and failures cannot be cached.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.get("/summary", async (req: AuthenticatedRequest, res) => {
  try {
    // All filters belong in the query. Empty JSON is tolerated for consistency
    // with existing GET endpoints; identity always comes from verified auth.
    if (
      req.body !== undefined &&
      (!req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length)
    )
      throw new DashboardInputError();
    return res.json({
      success: true,
      data: await getDashboardSummary(req.user, req.query),
    });
  } catch (error) {
    if (error instanceof DashboardInputError)
      return res
        .status(400)
        .json({ success: false, code: error.code, message: error.message });
    if (error instanceof AgentIdentityError)
      return res
        .status(401)
        .json({
          success: false,
          code: "DASHBOARD_IDENTITY_REQUIRED",
          message: "Please sign in again.",
        });
    if (error instanceof AgentMembershipError)
      return res
        .status(403)
        .json({
          success: false,
          code: "DASHBOARD_MEMBERSHIP_REQUIRED",
          message: "Current membership is required.",
        });
    // Do not expose SQL, identifiers or connection details, or return false zeros.
    return res
      .status(503)
      .json({
        success: false,
        code: "DASHBOARD_UNAVAILABLE",
        message: "Dashboard is unavailable. Please try again later.",
      });
  }
});

// The application's JSON parser runs before this router. Normalize its errors too.
export const dashboardJsonError: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (
    error?.type !== "entity.parse.failed" &&
    error?.type !== "entity.too.large"
  )
    return next(error);
  res.setHeader("Cache-Control", "no-store");
  return res.status(error.type === "entity.too.large" ? 413 : 400).json({
    success: false,
    code: "INVALID_DASHBOARD_REQUEST",
    message: "Provide a valid request within the size limit.",
  });
};
export default router;
