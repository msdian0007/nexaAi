import prisma from "../config/database";
import type { AgentContext } from "./agent.contracts";

export class AgentIdentityError extends Error {
  readonly code = "AGENT_IDENTITY_REQUIRED";
  constructor() {
    super("A valid authenticated user and organization are required.");
  }
}

export class AgentMembershipError extends Error {
  readonly code = "AGENT_MEMBERSHIP_REQUIRED";
  constructor() {
    super("Current organization membership is required.");
  }
}

// Callers must supply authenticated SERVER context, never model arguments. Copy
// its IDs before awaiting anything so later object mutations cannot switch scope.
export function readAgentContext(value: unknown): AgentContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AgentIdentityError();
  const context = value as Record<string, unknown>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof context.userId !== "string" ||
    !uuid.test(context.userId) ||
    typeof context.organizationId !== "string" ||
    !uuid.test(context.organizationId)
  ) {
    throw new AgentIdentityError();
  }
  return { userId: context.userId, organizationId: context.organizationId };
}

export async function requireAgentMembership(
  context: AgentContext,
  client: Pick<typeof prisma, "organizationMember"> = prisma,
): Promise<void> {
  // Every current role can read shared knowledge. A token's old role or a model's
  // role assertion is not used to establish current membership.
  // A read tool can pass its transaction so membership and data share a snapshot.
  const member = await client.organizationMember.findUnique({
    where: { userId_organizationId: context },
    select: { id: true },
  });
  if (!member) throw new AgentMembershipError();
}
