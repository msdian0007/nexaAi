import { issueAuthToken } from "./auth.tokens";
import { comparePassword, hashPassword } from "./auth.utils";
import { LoginInput, RegisterInput } from "./auth.types";
import prisma from "../config/database";
import { registerFromOrganizationInvitation } from "../organization/organization.service";
import { OrganizationPermissionError } from "../organization/organization.service";

export const registerUser = async (data: RegisterInput) => {
  const { name, email, password, organizationName } = data;

  const normalizedEmail = email.trim().toLowerCase();

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: {
      email: normalizedEmail,
    },
  });

  if (existingUser) {
    throw new Error("User with this email already exists");
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Create user + organization + membership
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
      },
    });

    const organization = await tx.organization.create({
      data: {
        name: organizationName.trim(),
        slug: `${organizationName
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")}-${Date.now()}`,
      },
    });

    const membership = await tx.organizationMember.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: "OWNER",
      },
    });

    return {
      user,
      organization,
      membership,
    };
  });

  // Generate JWT
  const credentials = issueAuthToken({
    userId: result.user.id,
    organizationId: result.organization.id,
    role: result.membership.role,
  });

  return {
    ...credentials,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
    },
    organization: {
      id: result.organization.id,
      name: result.organization.name,
      slug: result.organization.slug,
    },
    role: result.membership.role,
  };
};

export const loginUser = async (data: LoginInput) => {
  const { email, password } = data;

  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: {
      email: normalizedEmail,
    },
    include: {
      memberships: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          organization: true,
        },
      },
    },
  });

  if (!user) {
    throw new Error("Invalid email or password");
  }

  const isPasswordValid = await comparePassword(password, user.password);

  if (!isPasswordValid) {
    throw new Error("Invalid email or password");
  }

  const membership = user.memberships[0];

  if (!membership) {
    throw new Error("User is not associated with any organization");
  }

  const credentials = issueAuthToken({
    userId: user.id,
    organizationId: membership.organizationId,
    role: membership.role,
  });

  return {
    ...credentials,

    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },

    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
    },

    role: membership.role,
  };
};

export const registerInvitedUser = async (data: {
  name: string;
  email: string;
  password: string;
  token: string;
}) => {
  const result = await registerFromOrganizationInvitation({
    token: data.token,
    name: data.name,
    email: data.email,
    passwordHash: await hashPassword(data.password),
  });
  const credentials = issueAuthToken({
    userId: result.user.id,
    organizationId: result.organization.id,
    role: result.membership.role,
  });
  return {
    ...credentials,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
    },
    organization: {
      id: result.organization.id,
      name: result.organization.name,
      slug: result.organization.slug,
    },
    role: result.membership.role,
  };
};

export const listUserOrganizations = (userId: string) => prisma.organizationMember.findMany({
  where: { userId },
  select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

export const switchUserOrganization = (userId: string, organizationId: string) =>
  prisma.$transaction(async tx => {
    // Use the same organization lock as membership changes. A concurrent removal
    // or demotion must finish before the new session's role is decided.
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
    const membership = await tx.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
    // An unknown organization and a foreign organization have the same response.
    if (!membership) throw new OrganizationPermissionError(404, "Organization membership not found");
    const credentials = issueAuthToken({ userId, organizationId, role: membership.role });
    return { ...credentials, user: membership.user, organization: membership.organization, role: membership.role };
  });
