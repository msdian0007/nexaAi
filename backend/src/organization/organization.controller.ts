import { Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import {
  addOrganizationMember,
  getOrganizationMembers,
  removeOrganizationMember,
  updateMemberRole,
} from "./organization.service";

export const getMembers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({
        success: false,
        message: "Organization context is missing",
      });
    }

    const members = await getOrganizationMembers(organizationId);

    return res.status(200).json({
      success: true,
      data: members,
    });
  } catch (error) {
    console.error("Get members error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch organization members",
    });
  }
};

export const addMember = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({
        success: false,
        message: "Organization context is missing",
      });
    }

    const { email, role } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const member = await addOrganizationMember(organizationId, {
      email,
      role,
    });

    return res.status(201).json({
      success: true,
      message: "Member added successfully",
      data: member,
    });
  } catch (error) {
    console.error("Add member error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to add member";

    return res.status(400).json({
      success: false,
      message,
    });
  }
};

export const updateRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({
        success: false,
        message: "Organization context is missing",
      });
    }

    const { memberId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({
        success: false,
        message: "Role is required",
      });
    }

    const member = await updateMemberRole(
      organizationId,
      memberId,
      role,
      req.user.role,
    );

    return res.status(200).json({
      success: true,
      message: "Member role updated successfully",
      data: member,
    });
  } catch (error) {
    console.error("Update role error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to update member role";

    return res.status(400).json({
      success: false,
      message,
    });
  }
};

export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({
        success: false,
        message: "Organization context is missing",
      });
    }

    const { memberId } = req.params;

    const result = await removeOrganizationMember(organizationId, memberId);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Remove member error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to remove member";

    return res.status(400).json({
      success: false,
      message,
    });
  }
};
