# Conversation persistence: Step 5 — live backend verification

## Why this check exists

Browser tests with mocked responses verify how the screen behaves. Database tests
verify storage rules. This opt-in test connects the real backend components to catch
problems at their boundaries: authentication, upload processing, retrieval, Gemini
generation, saving, and reading history after a fresh login.

`tests/conversation.live.e2e.test.cjs` starts a temporary HTTP server using the actual
auth, document, and chat routers. It uses the configured PostgreSQL database and local
embedding model. It does not mock Gemini: a successful run makes two generation calls,
which consume the configured provider's quota. Only the test's fictional policy is
uploaded and supplied as document evidence.

## What it verifies

1. Register an isolated account, log in with its password, and verify its identity.
2. Upload a fictional TXT policy and wait for completed processing.
3. Ask about annual leave and require an answer containing 18/eighteen with a valid
   citation to the uploaded document.
4. Log in again and retrieve the saved question, answer, and source metadata.
5. Send a second fully specified question with the same `conversationId`. Require
   the policy's 7/seven-day notice period, then verify one conversation contains four
   ordered messages: question, answer, question, answer.
6. Confirm an account in another organization cannot list, read, or append to the
   conversation. Rejected access must leave the message count unchanged.
7. Remove the test accounts, organizations, dependent records, and uploaded files.

The fixture uses unique `example.invalid` emails and a temporary signing secret.
Cleanup checks the tenant directory's absolute path and removes only its direct files.
Assertions avoid printing tokens or credentials. Forced process termination can prevent
cleanup; ordinary assertion failures still execute the cleanup block.

## Run it deliberately

Start PostgreSQL and configure the backend's normal database, embedding, and Gemini
settings. From `backend`, in PowerShell:

```powershell
npm.cmd run build
# Continue only if the build succeeded. The flag prevents accidental provider calls.
$env:RUN_LIVE_CONVERSATION_TEST = '1'
try {
  node --test tests/conversation.live.e2e.test.cjs
} finally {
  Remove-Item Env:RUN_LIVE_CONVERSATION_TEST
}
```

Without the flag the live test is skipped. Provider outages, quota limits, a missing
local model, or an unavailable database can fail the test; they are not reported as
successful verification. Questions are not automatically retried.

## Scope

This is a backend HTTP integration check, not a browser driving the real server.
Frontend browser checks remain separate. Logging in again proves database history can
be read without the original client session; it does not simulate a database restart
or server-side logout revocation. Earlier messages are still not model context.

## Verified result — 2026-10-10

Backend TypeScript build passed. The live test passed in approximately 10 seconds:
two cited Gemini answers, history recovered after a fresh login, one conversation
with four ordered messages, cross-organization access rejected, and fixture cleanup
completed. Running without the opt-in flag correctly skipped the test.

The initial restricted-network attempt failed to reach Gemini after upload processing
succeeded. Rerunning with approved network access passed; no production code change
was required. These results verify backend HTTP integration, not a live browser run.
