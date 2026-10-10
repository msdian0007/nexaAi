# Conversation persistence: Step 4 — saved history UI

## What this step adds

The Chat page lists saved conversations for the signed-in account and organization.
Selecting one reads its saved questions, answers, and source metadata from the backend.
Continuing it sends its `conversationId` with the next question, so the backend appends
the exchange to that conversation. New conversation clears the current view and omits
that ID on the first submission, letting the backend create another conversation.

Saving messages and remembering their meaning are different features. Earlier turns
are displayed but are not passed to Gemini as context: each question must still include
the details needed to answer it. Opening history only reads stored data; it does not
generate answers or call Gemini.

## How the code works

- `ConversationList.tsx` reads conversation summaries, supports refresh/retry and loads
  additional pages. A successful answer refreshes the list ordering.
- `ChatPage.tsx` reads messages and appends successful new exchanges. The selected ID
  is retained after the first save without resetting the composer.
- `history.types.ts` checks response structure and IDs before using them in the UI.
- `api.ts` accepts query parameters separately from the validated API path.
  `URLSearchParams` safely encodes the pagination cursor.

A cursor tells the server where the next page starts. Both lists request 20 records
at a time. Messages are returned oldest first; this version requires loading all
remaining messages before sending another question, avoiding gaps in the visible thread.
Duplicate IDs across pages are displayed once. Backend ownership checks remain the
authorization boundary; frontend validation is not a substitute for those checks.

Switching conversations unmounts the previous chat, clears its draft, and aborts its
browser requests. Late responses cannot replace the newly selected conversation.
Aborting a request does not guarantee that server processing or saving stopped.

## Errors and current limits

Read failures offer retry and preserve already loaded records. Unavailable conversations
block submission; New conversation remains usable. Generation failures retain the draft
and do not automatically retry. If a save succeeded but its response was lost, reopen
history before submitting again: the backend does not yet provide idempotent retries.

Authentication remains in memory, so refreshing the browser requires signing in again.
Saved history remains in the database and can then be reopened. Conversation renaming,
deletion, automatic draft preservation, and model context from earlier turns are not
part of this step. The live list can move as conversations are updated; refresh it to
see the latest ordering.

## Verification and manual walkthrough

Browser tests use controlled API responses to cover message/list pagination, continuation
IDs, a separate new thread, retries, unavailable conversations, and stale-response
protection. API tests check cursor encoding and retained path validation. These checks
do not constitute a live Gemini or database integration test.

1. Start the backend and frontend, sign in, and open Chat.
2. Ask a question about an uploaded document; its conversation should appear in the list.
3. Start a new conversation, then select the saved one to read its answer and sources.
4. Ask another fully specified question; both exchanges should appear in the same thread.
5. Refresh, sign in again, and reopen the thread to verify database persistence.
