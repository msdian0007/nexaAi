import type { Request, Response } from "express";
import { loginUser, registerInvitedUser, registerUser } from "./auth.service";
import { AuthOperationError } from "./auth.errors";
import { OrganizationPermissionError } from "../organization/organization.service";

function input(req: Request, registering: boolean, invited = false) {
  const body = req.body;
  const invalid = () => { throw new AuthOperationError(400, "INVALID_AUTH_INPUT", "Provide valid account details. Passwords must fit within 72 UTF-8 bytes."); };
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    typeof body.email !== "string" || body.email.trim().length > 254 || /[\u0000-\u001f\u007f]/.test(body.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
    typeof body.password !== "string" || body.password.length < (registering ? 8 : 1) || Buffer.byteLength(body.password, "utf8") > 72 || body.password.includes("\0")) return invalid();
  const name = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
    return value.trim();
  };
  const result = { email: body.email.trim().toLowerCase(), password: body.password };
  if (!registering) return { ...result, name: "", organizationName: "", token: "" };
  if (invited && (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token))) return invalid();
  // Keep password bytes unchanged. bcrypt ignores bytes after 72, so reject
  // longer input rather than silently treating two different passwords as equal.
  return { ...result, name: name(body.name), organizationName: invited ? "" : name(body.organizationName), token: invited ? body.token as string : "" };
}
function failure(res: Response, error: unknown, registration = false) {
  if (error instanceof AuthOperationError)
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  if (error instanceof OrganizationPermissionError)
    return res.status(error.status).json({ success: false, code: "INVITATION_UNAVAILABLE", message: "Invitation registration could not be completed." });
  if (registration && error && typeof error === "object" && "code" in error && error.code === "P2002")
    return res.status(409).json({ success: false, code: "REGISTRATION_UNAVAILABLE", message: "Registration could not be completed with these details." });
  // Unknown errors are service failures, not bad passwords. Never return/log
  // their raw message: it may contain SQL, submitted credentials or connection data.
  return res.status(503).json({ success: false, code: "AUTH_UNAVAILABLE", message: "Authentication is unavailable. Please try again later." });
}
export const register = async (req: Request, res: Response) => {
  try {
    const data = input(req, true);
    return res.status(201).json({ success: true, message: "Registration successful", data: await registerUser(data) });
  } catch (error) { return failure(res, error, true); }
};
export const login = async (req: Request, res: Response) => {
  try { return res.json({ success: true, message: "Login successful", data: await loginUser(input(req, false)) }); }
  catch (error) { return failure(res, error); }
};
export const registerInvitation = async (req: Request, res: Response) => {
  try { return res.status(201).json({ success: true, data: await registerInvitedUser(input(req, true, true)) }); }
  catch (error) { return failure(res, error, true); }
};
