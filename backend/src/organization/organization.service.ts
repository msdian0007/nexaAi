import { Role, Prisma } from "../../generated/prisma/client";
import prisma from "../config/database";

export class OrganizationPermissionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const publicUser = { id: true, name: true, email: true, createdAt: true } as const;

// Serialize membership decisions per organization. Re-check the actor AFTER the
// lock, so a concurrent removal/demotion cannot leave stale permission in flight.
// Prisma has no row-lock method; this small parameterized query locks only this org.
async function withMembership<T>(organizationId: string, userId: string,
  action: (tx: Prisma.TransactionClient, role: Role) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
    const actor = await tx.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!actor) throw new OrganizationPermissionError(403, "Current organization membership is required");
    return action(tx, actor.role);
  });
}
function requireManager(role: Role) {
  if (role === Role.MEMBER) throw new OrganizationPermissionError(403, "Member management requires an owner or administrator");
}
function requireOwner(role: Role) {
  if (role !== Role.OWNER) throw new OrganizationPermissionError(403, "Only an owner can manage administrator or owner roles");
}

export const getOrganizationMembers = (organizationId: string, userId: string) =>
  withMembership(organizationId, userId, tx => tx.organizationMember.findMany({
    where: { organizationId }, include: { user: { select: publicUser } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  }));

export const addOrganizationMember = (organizationId: string, userId: string,
  data: { email: string; role?: Role }) => withMembership(organizationId, userId, async (tx, actorRole) => {
  requireManager(actorRole);
  const role = data.role ?? Role.MEMBER;
  if (role !== Role.MEMBER) requireOwner(actorRole);
  const user = await tx.user.findUnique({ where: { email: data.email.trim().toLowerCase() }, select: { id: true } });
  if (!user) throw new OrganizationPermissionError(404, "User not found");
  const existing = await tx.organizationMember.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
  });
  if (existing) throw new OrganizationPermissionError(409, "User is already a member of this organization");
  return tx.organizationMember.create({
    data: { organizationId, userId: user.id, role }, include: { user: { select: publicUser } },
  });
});

export const updateMemberRole = (organizationId: string, userId: string, memberId: string, role: Role) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const target = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId } });
    if (!target) throw new OrganizationPermissionError(404, "Organization member not found");
    // Keep the existing owner-protection policy, even when multiple owners exist.
    // Ownership transfer/removal needs its own deliberate workflow.
    if (target.role === Role.OWNER) throw new OrganizationPermissionError(409, "Organization owner role cannot be changed");
    requireOwner(actorRole);
    return tx.organizationMember.update({
      where: { id: target.id }, data: { role }, include: { user: { select: publicUser } },
    });
  });

export const removeOrganizationMember = (organizationId: string, userId: string, memberId: string) =>
  withMembership(organizationId, userId, async (tx, actorRole) => {
    requireManager(actorRole);
    const target = await tx.organizationMember.findFirst({ where: { id: memberId, organizationId } });
    if (!target) throw new OrganizationPermissionError(404, "Organization member not found");
    if (target.role === Role.OWNER) throw new OrganizationPermissionError(409, "Organization owner cannot be removed");
    if (target.role === Role.ADMIN) requireOwner(actorRole);
    // Existing schema behavior: deleting a membership also deletes that member's
    // private conversations/messages in this organization, not their user account.
    await tx.organizationMember.delete({ where: { id: target.id } });
    return { message: "Member removed successfully" };
  });
