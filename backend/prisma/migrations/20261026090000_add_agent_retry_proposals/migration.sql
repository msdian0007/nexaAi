CREATE TYPE "AgentRetryProposalState" AS ENUM ('PENDING', 'CLAIMED', 'ACCEPTED', 'REJECTED', 'UNCERTAIN', 'CANCELLED');

CREATE TABLE "AgentRetryProposal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "documentUpdatedAt" TIMESTAMP(3) NOT NULL,
    "state" "AgentRetryProposalState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "AgentRetryProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRetryProposal_userId_organizationId_createdAt_idx" ON "AgentRetryProposal"("userId", "organizationId", "createdAt");
CREATE INDEX "AgentRetryProposal_expiresAt_idx" ON "AgentRetryProposal"("expiresAt");
ALTER TABLE "AgentRetryProposal" ADD CONSTRAINT "AgentRetryProposal_userId_organizationId_fkey"
    FOREIGN KEY ("userId", "organizationId") REFERENCES "OrganizationMember"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
