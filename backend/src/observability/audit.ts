import type { Prisma } from "../../generated/prisma/client";
import { traceId } from "./telemetry";

export type AuditAction = "ORGANIZATION_UPDATED" | "MEMBER_ADDED" | "MEMBER_ROLE_CHANGED" | "MEMBER_REMOVED" |
  "INVITATION_CREATED" | "INVITATION_REVOKED" | "INVITATION_ACCEPTED" | "DOCUMENT_UPLOADED" | "DOCUMENT_DELETION_REQUESTED" | "DOCUMENT_DELETED" | "DOCUMENT_RETRY_REQUESTED";
// Called inside the business transaction: an audit-store failure rolls back the
// corresponding database mutation. Metadata stays useful after member removal.
export async function audit(tx: Prisma.TransactionClient, organizationId: string, actorId: string, action: AuditAction, targetId: string) {
  await tx.auditEvent.create({ data: { organizationId, actorId, action, targetId, requestId: traceId() ?? null } });
}
