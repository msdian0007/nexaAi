import { Role } from "../../generated/prisma/client";
import prisma from "../config/database";
import { AddMemberInput, UpdateMemberRoleInput } from "./organization.types";

export const getOrganizationMembers = async (
  organizationId: string
) => {
  return prisma.organizationMember.findMany({
    where: {
      organizationId,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });
};

export const addOrganizationMember = async (
  organizationId: string,
  data: AddMemberInput
) => {
  const email = data.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const existingMembership =
    await prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId,
        },
      },
    });

  if (existingMembership) {
    throw new Error("User is already a member of this organization");
  }

  return prisma.organizationMember.create({
    data: {
      userId: user.id,
      organizationId,
      role: data.role ?? Role.MEMBER,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
};

export const updateMemberRole = async (
  organizationId: string,
  memberId: string,
  newRole: Role,
  requesterRole: Role
) => {
  const membership = await prisma.organizationMember.findFirst({
    where: {
      id: memberId,
      organizationId,
    },
  });

  if (!membership) {
    throw new Error("Organization member not found");
  }

  // OWNER cannot have their role changed
  if (membership.role === Role.OWNER) {
    throw new Error("Organization owner role cannot be changed");
  }

  // Only OWNER can assign OWNER
  if (
    newRole === Role.OWNER &&
    requesterRole !== Role.OWNER
  ) {
    throw new Error(
      "Only the organization owner can assign the OWNER role"
    );
  }

  return prisma.organizationMember.update({
    where: {
      id: memberId,
    },
    data: {
      role: newRole,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
};

export const removeOrganizationMember = async (
  organizationId: string,
  memberId: string
) => {
  const membership = await prisma.organizationMember.findFirst({
    where: {
      id: memberId,
      organizationId,
    },
  });

  if (!membership) {
    throw new Error("Organization member not found");
  }

  if (membership.role === Role.OWNER) {
    throw new Error("Organization owner cannot be removed");
  }

  await prisma.organizationMember.delete({
    where: {
      id: memberId,
    },
  });

  return {
    message: "Member removed successfully",
  };
};