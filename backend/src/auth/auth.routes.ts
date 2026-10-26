import { Router } from "express";
import type { ErrorRequestHandler } from "express";
import { requestFields } from "../http/api.boundary";
import { login, register, registerInvitation } from "./auth.controller";

const router = Router();
// express.json precedes the router. Keep invalid logout/login bodies uncached
// and avoid Express's default HTML error/stack response for authentication APIs.
export const authJsonError: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type !== "entity.parse.failed" && error?.type !== "entity.too.large") return next(error);
  res.setHeader("Cache-Control", "no-store");
  return res.status(error.type === "entity.too.large" ? 413 : 400).json({
    success: false, code: "INVALID_AUTH_REQUEST", message: "Provide a valid authentication request within the size limit.",
  });
};
// Login/register return bearer credentials and must never be cached.
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

router.post("/register", requestFields({ body: ["name", "email", "password", "organizationName"], required: ["name", "email", "password", "organizationName"] }), register);
router.post("/register-invitation", requestFields({ body: ["name", "email", "password", "token"], required: ["name", "email", "password", "token"] }), registerInvitation);
router.post("/login", requestFields({ body: ["email", "password"], required: ["email", "password"] }), login);

export default router;
