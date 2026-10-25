import { Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import { Role } from "../../generated/prisma/client";
import {
  addOrganizationMember,
  getOrganizationMembers,
  removeOrganizationMember,
  updateMemberRole,
  OrganizationPermissionError,
} from "./organization.service";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(req: AuthenticatedRequest) {
  const user = req.user;
  if (
    !user ||
    typeof user.userId !== "string" ||
    !uuid.test(user.userId) ||
    typeof user.organizationId !== "string" ||
    !uuid.test(user.organizationId)
  ) {
    throw new OrganizationPermissionError(
      401,
      "Valid user and organization context is required",
    );
  }
  return user;
}
function memberId(req: AuthenticatedRequest) {
  const id = req.params.memberId;
  if (typeof id !== "string" || !uuid.test(id))
    throw new OrganizationPermissionError(400, "Member ID must be a UUID");
  return id;
}
function role(value: unknown): Role {
  if (value !== Role.OWNER && value !== Role.ADMIN && value !== Role.MEMBER) {
    throw new OrganizationPermissionError(
      400,
      "Role must be OWNER, ADMIN, or MEMBER",
    );
  }
  return value;
}
function failure(res: Response, error: unknown) {
  if (error instanceof OrganizationPermissionError) {
    return res
      .status(error.status)
      .json({ success: false, message: error.message });
  }
  // Never return raw Prisma errors, SQL, or connection settings to the caller.
  console.error("Organization member operation failed.");
  return res
    .status(500)
    .json({ success: false, message: "Organization member operation failed" });
}
export const getMembers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = identity(req);
    return res
      .status(200)
      .json({
        success: true,
        data: await getOrganizationMembers(actor.organizationId, actor.userId),
      });
  } catch (error) {
    return failure(res, error);
  }
};
export const addMember = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = identity(req);
    const email = req.body?.email;
    if (
      typeof email !== "string" ||
      email.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      throw new OrganizationPermissionError(
        400,
        "A valid email address is required",
      );
    }
    const assignedRole =
      req.body?.role === undefined ? Role.MEMBER : role(req.body.role);
    const data = await addOrganizationMember(
      actor.organizationId,
      actor.userId,
      { email, role: assignedRole },
    );
    return res
      .status(201)
      .json({ success: true, message: "Member added successfully", data });
  } catch (error) {
    return failure(res, error);
  }
};
export const updateRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = identity(req);
    const data = await updateMemberRole(
      actor.organizationId,
      actor.userId,
      memberId(req),
      role(req.body?.role),
    );
    return res
      .status(200)
      .json({
        success: true,
        message: "Member role updated successfully",
        data,
      });
  } catch (error) {
    return failure(res, error);
  }
};
export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const actor = identity(req);
    const data = await removeOrganizationMember(
      actor.organizationId,
      actor.userId,
      memberId(req),
    );
    return res.status(200).json({ success: true, ...data, data });
  } catch (error) {
    return failure(res, error);
  }
};
