import jwt from "jsonwebtoken";
import { comparePassword, hashPassword } from "./auth.utils";
import { LoginInput, RegisterInput } from "./auth.types";
import prisma from "../config/database";

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
  const token = jwt.sign(
    {
      userId: result.user.id,
      organizationId: result.organization.id,
      role: result.membership.role,
    },
    process.env.JWT_SECRET as string,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    }
  );

  return {
    token,
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
        include: {
          organization: true,
        },
      },
    },
  });

  if (!user) {
    throw new Error("Invalid email or password");
  }

  const isPasswordValid = await comparePassword(
    password,
    user.password
  );

  if (!isPasswordValid) {
    throw new Error("Invalid email or password");
  }

  const membership = user.memberships[0];

  if (!membership) {
    throw new Error("User is not associated with any organization");
  }

  const token = jwt.sign(
    {
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
    },
    process.env.JWT_SECRET as string,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "1d",
    }
  );

  return {
    token,

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