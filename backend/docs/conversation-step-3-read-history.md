# Conversation persistence — Step 3: Read saved history

## New endpoints

Both endpoints require the same Bearer token used for chat. They check current organization membership and always use the signed userId and organizationId. Request query parameters cannot override that owner.

```http
GET /api/v1/chat/conversations?limit=20
GET /api/v1/chat/conversations/<conversationId>/messages?limit=20
```

The list response has `data.conversations` and `data.page`. Each conversation contains id, title, createdAt and updatedAt. It does not include message text, other users' information or counts requiring a full history scan.

The message response has `data.conversation`, `data.messages` and `data.page`. Each message contains id, role, content, sequence, answerStatus, createdAt, citations and sources. User questions have null answerStatus and empty citation/source arrays. Assistant messages include the saved outcome and source snapshots.

## Pagination: what the cursor means

The default page size is 20, with allowed limits 1–50. Each query reads limit + 1 rows: the extra row tells us whether another page exists. Only limit rows are returned.

`data.page` contains:

```json
{
  "limit": 20,
  "hasMore": true,
  "nextCursor": "copy-the-returned-value"
}
```

For the next page, supply that value as the cursor query parameter on the same endpoint. Stop when hasMore is false and nextCursor is null. The cursor is base64url JSON, not a token or permission grant. It is strictly validated and never replaces owner filters.

Conversation lists sort by updatedAt descending, then ID descending to break timestamp ties. The cursor stores both fields. The next query reads records older than that boundary, without requiring the anchor record to still exist. Deleting an anchor does not break pagination.

Message lists sort by sequence ascending, beginning with the oldest question. The cursor stores the last sequence and conversation ID. Reusing it for another conversation is rejected. Limits count messages, not exchanges: a page may end between a question and its answer, so clients should append the next page in order.

## Consistency and changing history

Each request uses a short RepeatableRead transaction so its membership check and returned records see one database snapshot. There are no row locks and no transaction spanning multiple HTTP pages.

Conversation lists are a live view rather than a frozen snapshot. An older conversation receiving a new answer moves toward the top; if that happens between pages, it can move ahead of the current cursor. Refresh the list from page one to see newly active conversations. Message sequences are stable, so appending new messages does not shift existing positions.

## Access and response behavior

- Missing or invalid signed identity: 401.
- Membership removed after token issuance: 403 MEMBERSHIP_REQUIRED.
- Another user's conversation, another organization's conversation or a nonexistent ID: identical 404 CONVERSATION_NOT_FOUND responses for a current member.
- Malformed UUID, cursor or page limit: 400.
- Empty own history: 200 with an empty list and no next cursor.
- Unexpected database errors: generic 500 without message contents or database details.

History responses use Cache-Control: no-store. These checks supplement existing JWT verification; they do not grant administrators access to other users' personal conversations.

## Historical citations

The source list comes directly from MessageSource snapshots. There is no join to current document filenames or chunks, so renaming, reprocessing or deleting a document does not rewrite the historical reference. Sources contain labels, document/chunk IDs, original filename, chunk index and similarity. They do not contain original passage text or file download URLs. Citations are reconstructed from those source labels; their list order is not semantically meaningful.

## Try it in Postman

1. Log in and use the returned token as Bearer authentication.
2. Submit a question to POST /api/v1/chat/query and copy data.conversationId.
3. GET /api/v1/chat/conversations?limit=1 to see your most recently updated conversation.
4. GET /api/v1/chat/conversations/<that-id>/messages?limit=1 to read the question.
5. Add the returned nextCursor to the same messages endpoint to read the answer and sources.

Reading history makes no Gemini requests and creates no conversations or messages. The frontend history list is not part of this step.

## Verification

The integration suite uses real JWT authentication, HTTP and PostgreSQL with isolated fixtures. It checks tied timestamps, page boundaries, empty history, historical citations with deleted source references, same-organization and cross-organization privacy, malformed inputs, deleted cursor anchors and revoked membership. The persistence suite is also run to check that adding GET routes does not disrupt saving exchanges.

From backend, wait for build completion before testing:

```powershell
npm.cmd run build
node --test tests/conversation.history.integration.test.cjs tests/conversation.persistence.integration.test.cjs
```

No migration is needed. Comments in the controller, pagination and history modules explain their responsibilities and the access boundaries.

Next: the frontend conversation list, loading saved messages, and sending the selected conversationId when asking another independent question.
