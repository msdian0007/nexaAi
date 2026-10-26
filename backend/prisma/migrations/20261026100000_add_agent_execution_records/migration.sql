CREATE TYPE "AgentExecutionOutcome" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'UNCONFIRMED');
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "tool" TEXT,
    "proposalId" TEXT,
    "outcome" "AgentExecutionOutcome" NOT NULL DEFAULT 'STARTED',
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentExecution_operation_check" CHECK ("operation" IN ('REQUEST', 'CONFIRM', 'CANCEL')),
    CONSTRAINT "AgentExecution_tool_check" CHECK ("tool" IS NULL OR "tool" IN ('knowledge_answer', 'document_counts', 'retry_document'))
);
CREATE INDEX "AgentExecution_userId_organizationId_startedAt_id_idx" ON "AgentExecution"("userId", "organizationId", "startedAt", "id");
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_userId_organizationId_fkey"
    FOREIGN KEY ("userId", "organizationId") REFERENCES "OrganizationMember"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
