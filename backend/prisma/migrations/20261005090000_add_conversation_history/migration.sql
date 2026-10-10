-- Additive migration: existing users, documents, vectors and HNSW index are untouched.
-- PostgreSQL transactions keep this group of schema changes atomic.
BEGIN;

CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "AnswerStatus" AS ENUM ('answered', 'insufficient_information', 'conflicting_evidence');

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Conversation_title_nonempty" CHECK (length(btrim("title")) > 0)
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "role" "MessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "answerStatus" "AnswerStatus",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Message_sequence_nonnegative" CHECK ("sequence" >= 0),
  -- Questions and answers have different meaning and size limits. Store only
  -- validated answers here; transport/provider errors are not assistant answers.
  CONSTRAINT "Message_role_content_status" CHECK (
    length(btrim("content")) > 0 AND (
      ("role" = 'USER' AND "answerStatus" IS NULL AND length("content") <= 1000) OR
      ("role" = 'ASSISTANT' AND "answerStatus" IS NOT NULL AND length("content") <= 8000)
    )
  )
);

CREATE TABLE "MessageSource" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "documentName" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "similarity" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "MessageSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MessageSource_label" CHECK ("sourceId" ~ '^S[1-9][0-9]*$'),
  CONSTRAINT "MessageSource_chunkIndex_nonnegative" CHECK ("chunkIndex" >= 0),
  CONSTRAINT "MessageSource_similarity_range" CHECK ("similarity" >= -1 AND "similarity" <= 1)
);

-- Owner/history lookup and deterministic message order for later paginated APIs.
CREATE INDEX "Conversation_organizationId_userId_updatedAt_id_idx" ON "Conversation"("organizationId", "userId", "updatedAt", "id");
CREATE INDEX "Conversation_userId_organizationId_idx" ON "Conversation"("userId", "organizationId");
CREATE UNIQUE INDEX "Conversation_id_organizationId_key" ON "Conversation"("id", "organizationId");
CREATE INDEX "Message_organizationId_conversationId_idx" ON "Message"("organizationId", "conversationId");
CREATE UNIQUE INDEX "Message_id_organizationId_key" ON "Message"("id", "organizationId");
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");
CREATE INDEX "MessageSource_organizationId_messageId_idx" ON "MessageSource"("organizationId", "messageId");
CREATE UNIQUE INDEX "MessageSource_messageId_sourceId_key" ON "MessageSource"("messageId", "sourceId");

-- Composite keys reject mismatched organizations even if application code errs.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_organizationId_fkey"
  FOREIGN KEY ("userId", "organizationId") REFERENCES "OrganizationMember"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_organizationId_fkey"
  FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageSource" ADD CONSTRAINT "MessageSource_messageId_organizationId_fkey"
  FOREIGN KEY ("messageId", "organizationId") REFERENCES "Message"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
