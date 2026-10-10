# Conversation persistence — Step 2: Save completed exchanges

## What changed

POST /api/v1/chat/query now persists successful answers. The response keeps all existing question/answer/status/citation fields and adds conversationId, userMessageId and assistantMessageId. The frontend can continue displaying the latest answer; its notice now explains that answers are stored even though history browsing is not available yet.

Omit conversationId to create a conversation. Provide a returned conversationId to append a new question/answer pair to that conversation. Ownership comes from the signed userId and organizationId, not request-body fields.

```json
{
  "question": "How many days of annual leave do full-time employees receive?"
}
```

After copying data.conversationId from the response:

```json
{
  "question": "What does the policy say about unused annual leave?",
  "conversationId": "replace-with-the-returned-UUID"
}
```

Each question is still independent model input. Saving previous messages does not automatically send them to Gemini. The current frontend does not yet send conversationId, so each submission creates a new conversation. Grouping turns and browsing history are later steps.

## Why this order matters

1. Validate the signed user/organization context, question/search settings and optional conversation UUID.
2. Check membership and ownership before retrieval or generation. Another user's conversation, even in the same organization, returns the same 404 as a missing conversation.
3. Retrieve evidence and generate/validate the answer using the existing RAG service. No persistence transaction is open while waiting for Gemini.
4. Open a short transaction and recheck membership. If membership was removed during generation, do not save the answer.
5. Create the new conversation, or lock and recheck the existing conversation. If it was deleted during generation, return 404 rather than recreating it.
6. Allocate two message positions and insert the question, answer, cited-source snapshots and updated parent timestamp.
7. Commit and return the answer with the saved IDs. A database failure returns an error rather than falsely claiming the exchange was saved.

## Atomicity: all of the exchange or none of it

A transaction means these writes succeed together. For example, if a source snapshot cannot be inserted, both new message inserts roll back. A newly created conversation also rolls back. Existing messages in an older conversation are unaffected. A provider error occurs before any history writes, so it creates no orphan question or empty conversation.

An insufficient_information or conflicting_evidence response is a valid answer outcome and is saved. A timeout, blocked request, invalid model output or provider outage is a failed request and is not saved as an assistant answer.

## Concurrent requests and raw SQL

Suppose two requests finish generation at nearly the same time. Without coordination, both could read the same largest sequence number and choose the same next positions. SELECT FOR UPDATE locks the conversation row before that read. One save finishes before the next allocates its positions, keeping each question/answer pair adjacent.

Prisma has no row-lock option on findFirst here, so the locks use parameterized $queryRaw. Ordinary reads and writes use Prisma methods. The membership lock is FOR KEY SHARE, which prevents deletion during the save. Locks are acquired membership first, then conversation, and released at transaction completion. Save order reflects generation completion, not request arrival order. No application retry loop or repeated provider call is added.

## Citation ownership

Only the existing RAG service's validated source map is written. The service selects explicit snapshot fields; extra source/user/organization fields supplied by the client are ignored. Generated source IDs such as S1 are local to each assistant message. Filenames and chunk IDs survive subsequent document changes as historical metadata; they do not preserve the original passage text.

## Response errors and limits

- 400: malformed optional conversationId or invalid existing request fields.
- 401: missing/invalid signed user or organization context.
- 403 MEMBERSHIP_REQUIRED: the user no longer belongs to the organization.
- 404 CONVERSATION_NOT_FOUND: missing, inaccessible or deleted conversation.
- Existing provider/validation errors keep their previous HTTP mapping.
- Unexpected persistence errors return the existing generic 500 QUERY_FAILED.

This step has no request idempotency key. If saving succeeds but the response is lost, submitting again can save a duplicate exchange or new conversation. The frontend performs no automatic retries. Browser cancellation also cannot undo a server transaction already committed. Durable retry deduplication is separate work.

## Verification

The new integration suite exercises real HTTP, JWT and PostgreSQL transactions with a controlled RAG result. It verifies creation/appending, owner and tenant boundaries, membership revocation, deletion during generation, concurrent message ordering, statuses and source snapshots. It intentionally fails a source insert after both message inserts to verify actual rollback.

The existing RAG query integration suite still exercises real embeddings and retrieval with controlled Gemini output, now through the persistence flow. Test cleanup deletes only isolated test tenants and their cascading histories. No live Gemini calls or real-user documents are used.

After building from backend:

```powershell
npm.cmd run build
node --test tests/conversation.persistence.integration.test.cjs tests/rag.query.integration.test.cjs tests/conversation.schema.integration.test.cjs
```

No schema migration is required for this step. Important code sections in conversation.service.ts and the controller contain comments explaining the access checks, locks, transaction boundaries and snapshots.

Next: owner-scoped, paginated history read APIs. The frontend conversation list and selecting a saved conversation follow afterward.
