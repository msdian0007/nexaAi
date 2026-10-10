# Conversation persistence — Step 1: Database structure

## Why this step comes first

The current chat page displays only the latest answer and loses it when the page unmounts. Before adding history APIs, we need a durable representation of who owns a chat, its messages, and the references attached to each answer. This step creates that representation. It does not yet save requests made through the existing chat endpoint.

## Three tables

Conversation stores an ID, organizationId, userId, title and timestamps. Its owner is an OrganizationMember, matched by both userId and organizationId. The database rejects an owner who is not a member of that organization. The initial privacy model is personal history inside an organization, not history visible to every member.

Message stores a question or an answer, its conversation and organization, content, creation time and an explicit sequence number. Sequence makes message ordering deterministic even when a question and answer share a timestamp. The unique conversationId/sequence constraint prevents duplicate positions. Future writes must allocate positions in a transaction that handles concurrent requests; timestamps alone are insufficient.

MessageSource stores each cited source's label, original filename, document/chunk IDs, chunk index and similarity as they appeared when the answer was saved. There is one row per cited label for that message. This stores citation metadata, not a copy of the underlying passage text. A deleted source's original content cannot be reconstructed from this snapshot.

## Why snapshot citations?

Suppose an answer cites policy.txt as S1. Later, someone replaces or deletes that document. A live relation to the current chunk could disappear or point to different content after reprocessing. Snapshot fields preserve the historical reference without preventing document deletion. Accordingly, documentId and chunkId in MessageSource are stored identifiers, not foreign keys to the document tables.

The source does have a foreign key to its message. Deleting the message deletes its source records. Source labels are local to one message, so many answers may each have their own S1.

## Constraints and their limits

- A conversation's owner must have a membership in its organization.
- A message's organization must match its conversation's organization.
- A source's organization must match its message's organization.
- Sequence numbers and chunk indexes must be nonnegative; source labels use S1, S2, etc.
- USER content is nonempty and limited to 1,000 PostgreSQL characters, with no answerStatus.
- ASSISTANT content is nonempty and limited to 8,000 PostgreSQL characters, with an allowed answerStatus.
- Titles are nonblank and limited to 200 characters. Similarity must be between -1 and 1.

The HTTP layer's existing JavaScript length checks remain in force; JavaScript counts UTF-16 code units while PostgreSQL length counts characters, so the database limits do not replace API validation. Source/answer citation agreement, source eligibility, and limiting sources to assistant messages still need application validation in the next step. The schema does not prove factual support or provide read authorization; history queries must filter by both organization and owner.

Removing an organization membership cascades to that membership's conversations, messages and sources. Organization/user deletion also reaches them through membership cascades. This is the selected retention rule for personal history. No existing membership-management behavior was changed by this migration.

## Why migration SQL appears alongside Prisma

Prisma describes models and relationships and will provide normal create/findMany methods for these new tables. The migration creates the actual PostgreSQL tables, keys and indexes. CHECK constraints enforce combinations such as USER messages having no answer status; these constraints are recorded in SQL because the Prisma schema does not express them here.

The generated diff also proposed dropping the manually managed pgvector HNSW index. That unrelated operation was excluded. This migration adds the new history structure without changing existing document/vector storage. It runs inside a PostgreSQL transaction so its schema changes apply together.

## Verification

The real-database test creates isolated users and memberships. It checks valid records, invalid owners, mismatched tenant keys, duplicate ordering/citations, role/content constraints, metadata survival after source deletion and deletion cascades. It also confirms that the existing HNSW index is present, then removes all test records. No Gemini requests are involved.

Commands from backend:

```powershell
npx.cmd prisma validate --config prisma7.config.ts
npx.cmd prisma migrate deploy --config prisma7.config.ts
npx.cmd prisma generate --config prisma7.config.ts
npm.cmd run build
node --test tests/conversation.schema.integration.test.cjs
```

Wait for each command to finish before starting the next. The migration is additive; no database reset is needed.

## Next step

Connect the chat API to persistence: verify conversation ownership, generate an answer without holding a database transaction open during the provider request, and atomically save the question, validated answer and citation snapshots. Update Conversation.updatedAt explicitly when adding messages; child inserts do not automatically touch the parent timestamp. History read APIs and the frontend conversation list follow separately. Persisting messages alone does not make the model use previous turns as context.
