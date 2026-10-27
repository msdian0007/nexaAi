CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "targetId" TEXT NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuditEvent_organizationId_createdAt_id_idx" ON "AuditEvent"("organizationId", "createdAt", "id");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
