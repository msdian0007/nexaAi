import { Role, Prisma } from "../../generated/prisma/client";
import prisma from "../config/database";
import { createHash, randomBytes } from "node:crypto";

export class OrganizationPermissionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const publicUser = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
} as const;
const publicProfile = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const getOrganizationProfile = (
  organizationId: string,
  userId: string,
) =>
  withMembership(organizationId, userId, async (tx, role) => ({
    ...(await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: publicProfile,
    })),
    role,
    canEdit: role === Role.OWNER,
  }));

export const updateOrganizationProfile = (
  organizationId: string,
  userId: string,
  name: string,
) =>
  withMembership(organizationId, userId, async (tx, role) => {
    if (role !== Role.OWNER)
      throw new OrganizationPermissionError(
        403,
        "Only an owner can edit the organization profile",
      );
    // Rename only the display name. IDs and the stable slug keep documents and
    // memberships attached to the same organization; never spread request bodies.
    const organization = await tx.organization.update({
      where: { id: organizationId },
      data: { name },
      select: publicProfile,
    });
    return { ...organization, role, canEdit: true };
  });

// Serialize membership decisions per organization. Re-check the actor AFTER the
// lock, so a concurrent removal/demotion cannot leave stale permission in flight.
// Prisma has no row-lock method; this small parameterized query locks only this org.
async function withMembership<T>(
  organizationId: string,
  userId: string,
  action: (tx: Prisma.TransactionClient, role: Role) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
    const actor = await tx.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!actor)
      throw new OrganizationPermissionError(
        403,
        "Current organization membership is required",
      );
    return action(tx, actor.role);
  });
}
function requireManager(role: Role) {
  if (role === Role.MEMBER)
    throw new OrganizationPermissionError(
      403,
      "Member management requires an owner or administrator",
    );
}
function requireOwner(role: Role) {
  if (role !== Role.OWNER)
    throw new OrganizationPermissionError(
      403,
      "Only an owner can manage administrator or owner roles",
    );
}

export const getOrganizationMembers = (
  organizationId: string,
  userId: string,
) =>
  withMembership(organizationId, userId, (tx) =>
    tx.organizationMember.findMany({
      where: { organizationId },
      include: { user: { select: publicUser } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );

export const addOrganizationMember = (
  organizationId: string,
  userId: string,
  data: { email: string; role?: Role },
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const role = data.role ?? Role.MEMBER;
    if (role !== Role.MEMBER) requireOwner(actorRole);
    const user = await tx.user.findUnique({
      where: { email: data.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!user) throw new OrganizationPermissionError(404, "User not found");
    const existing = await tx.organizationMember.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
    });
    if (existing)
      throw new OrganizationPermissionError(
        409,
        "User is already a member of this organization",
      );
    return tx.organizationMember.create({
      data: { organizationId, userId: user.id, role },
      include: { user: { select: publicUser } },
    });
  });

export const updateMemberRole = (
  organizationId: string,
  userId: string,
  memberId: string,
  role: Role,
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const target = await tx.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!target)
      throw new OrganizationPermissionError(
        404,
        "Organization member not found",
      );
    // Keep the existing owner-protection policy, even when multiple owners exist.
    // Ownership transfer/removal needs its own deliberate workflow.
    if (target.role === Role.OWNER)
      throw new OrganizationPermissionError(
        409,
        "Organization owner role cannot be changed",
      );
    requireOwner(actorRole);
    return tx.organizationMember.update({
      where: { id: target.id },
      data: { role },
      include: { user: { select: publicUser } },
    });
  });

export const removeOrganizationMember = (
  organizationId: string,
  userId: string,
  memberId: string,
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const target = await tx.organizationMember.findFirst({
      where: { id: memberId, organizationId },
    });
    if (!target)
      throw new OrganizationPermissionError(
        404,
        "Organization member not found",
      );
    if (target.role === Role.OWNER)
      throw new OrganizationPermissionError(
        409,
        "Organization owner cannot be removed",
      );
    if (target.role === Role.ADMIN) requireOwner(actorRole);
    // Existing schema behavior: deleting a membership also deletes that member's
    // private conversations/messages in this organization, not their user account.
    await tx.organizationMember.delete({ where: { id: target.id } });
    return { message: "Member removed successfully" };
  });

const invitationSelect = {
  id: true,
  organizationId: true,
  email: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const getOrganizationInvitations = (
  organizationId: string,
  userId: string,
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const invitations = await tx.organizationInvitation.findMany({
      where: { organizationId },
      select: invitationSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return { invitations, role: actorRole };
  });

export const createOrganizationInvitation = (
  organizationId: string,
  userId: string,
  data: { email: string; role: Role; expiresInDays: number },
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    if (data.role !== Role.MEMBER) requireOwner(actorRole);
    const email = data.email.trim().toLowerCase();
    const existingUser = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (
      existingUser &&
      (await tx.organizationMember.findUnique({
        where: {
          userId_organizationId: { userId: existingUser.id, organizationId },
        },
        select: { id: true },
      }))
    )
      throw new OrganizationPermissionError(
        409,
        "This user is already a member",
      );
    const now = new Date();
    const active = await tx.organizationInvitation.findFirst({
      where: {
        organizationId,
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (active)
      throw new OrganizationPermissionError(
        409,
        "An active invitation already exists for this email",
      );
    // 32 random bytes make an unguessable secret. Store only its digest in PostgreSQL.
    const token = randomBytes(32).toString("base64url");
    const invitation = await tx.organizationInvitation.create({
      data: {
        organizationId,
        email,
        role: data.role,
        tokenHash: tokenDigest(token),
        expiresAt: new Date(now.getTime() + data.expiresInDays * 86_400_000),
        createdById: userId,
      },
      select: invitationSelect,
    });
    return { invitation, token };
  });

export const revokeOrganizationInvitation = (
  organizationId: string,
  userId: string,
  invitationId: string,
) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const invitation = await tx.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId },
    });
    if (!invitation)
      throw new OrganizationPermissionError(404, "Invitation not found");
    if (invitation.acceptedAt)
      throw new OrganizationPermissionError(
        409,
        "Accepted invitations cannot be revoked",
      );
    if (invitation.revokedAt)
      throw new OrganizationPermissionError(
        409,
        "Invitation is already revoked",
      );
    return tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
      select: invitationSelect,
    });
  });

export const acceptOrganizationInvitation = (userId: string, token: string) =>
  prisma.$transaction(async (tx) => {
    const hash = tokenDigest(token);
    // Lock the one invitation so two clicks cannot both consume a one-time token.
    await tx.$queryRaw`SELECT id FROM "OrganizationInvitation" WHERE "tokenHash" = ${hash} FOR UPDATE`;
    const invitation = await tx.organizationInvitation.findUnique({
      where: { tokenHash: hash },
      include: { organization: { select: publicProfile } },
    });
    if (!invitation)
      throw new OrganizationPermissionError(404, "Invitation not found");
    if (invitation.revokedAt)
      throw new OrganizationPermissionError(410, "Invitation was revoked");
    if (invitation.acceptedAt)
      throw new OrganizationPermissionError(
        409,
        "Invitation was already accepted",
      );
    if (invitation.expiresAt <= new Date())
      throw new OrganizationPermissionError(410, "Invitation has expired");
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user || user.email.toLowerCase() !== invitation.email)
      throw new OrganizationPermissionError(
        403,
        "Sign in with the invited email address",
      );
    const existing = await tx.organizationMember.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: invitation.organizationId,
        },
      },
    });
    if (existing)
      throw new OrganizationPermissionError(
        409,
        "You are already a member of this organization",
      );
    const membership = await tx.organizationMember.create({
      data: {
        userId,
        organizationId: invitation.organizationId,
        role: invitation.role,
      },
    });
    await tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });
    return { organization: invitation.organization, role: membership.role };
  });

export const registerFromOrganizationInvitation = (data: {
  token: string;
  name: string;
  email: string;
  passwordHash: string;
}) =>
  prisma.$transaction(async (tx) => {
    const hash = tokenDigest(data.token);
    await tx.$queryRaw`SELECT id FROM "OrganizationInvitation" WHERE "tokenHash" = ${hash} FOR UPDATE`;
    const invitation = await tx.organizationInvitation.findUnique({
      where: { tokenHash: hash },
      include: { organization: { select: publicProfile } },
    });
    if (!invitation)
      throw new OrganizationPermissionError(404, "Invitation not found");
    if (invitation.revokedAt || invitation.expiresAt <= new Date())
      throw new OrganizationPermissionError(
        410,
        "Invitation is no longer active",
      );
    if (invitation.acceptedAt)
      throw new OrganizationPermissionError(
        409,
        "Invitation was already accepted",
      );
    const email = data.email.trim().toLowerCase();
    if (email !== invitation.email)
      throw new OrganizationPermissionError(
        403,
        "Use the invited email address",
      );
    if (await tx.user.findUnique({ where: { email }, select: { id: true } }))
      throw new OrganizationPermissionError(
        409,
        "An account with this email already exists; sign in instead",
      );
    // Account, membership, and token consumption are atomic: a failure leaves none behind.
    const user = await tx.user.create({
      data: { name: data.name.trim(), email, password: data.passwordHash },
    });
    const membership = await tx.organizationMember.create({
      data: {
        userId: user.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
      },
    });
    await tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date(), acceptedById: user.id },
    });
    return { user, organization: invitation.organization, membership };
  });
