# Frontend integration — Step 5: Ask questions in the browser

## What this step connects

The protected /chat page connects the frontend to POST /api/v1/chat/query. After uploading a document and seeing Ready for questions, open Chat and ask a complete question, such as: How many days of annual leave do full-time employees receive?

Important code sections have comments explaining their purpose: duplicate-request protection, authenticated calls, request cancellation, response validation, safe text rendering, and passage numbering.

## Follow a question through the code

1. ChatPage stores the draft question in React state. Empty or whitespace-only questions cannot be sent; input is limited to 1,000 characters, matching the backend.
2. On submission, the question is trimmed, the previous result is cleared, and the form is disabled. A ref prevents rapid duplicate submissions before the disabled state renders.
3. The shared authenticated request helper sends only `{ question }` with the session's Bearer token. The backend determines the organization from that token; the browser does not select a tenant or provide its own sources.
4. The backend embeds the question, retrieves document passages, prepares context, calls Gemini when evidence exists, and validates the answer and citations. This step reuses that existing pipeline.
5. parseChatAnswer checks the response shape at runtime before rendering. TypeScript alone cannot guarantee that a server returned the expected fields. The frontend checks question identity and source mappings, but does not attempt to determine whether the answer is factually correct.
6. The answer is displayed with its status and source filenames. [S1] in the answer matches [S1] in the source list. Passage numbers are chunkIndex + 1 for readability; they are not PDF page numbers. Sources are text metadata, not download links, because a document-download endpoint has not been built.

## Outcomes versus errors

| Result | Screen behavior |
| --- | --- |
| answered | Answer found, answer text, and supporting sources |
| insufficient_information | Not enough information; may include a partial answer and citations |
| conflicting_evidence | Conflicting information with the answer and conflicting sources |
| Provider outage, timeout, blocked/invalid output | Error message; preserve the question for a deliberate retry |
| 401 | Shared session handling returns to login |

An insufficient-information answer is a successful API response. It means the evidence cannot fully answer the question. An unavailable provider means generation failed; the UI does not pretend that no evidence exists. Requests are not automatically retried because that could spend additional quota.

## Safety and lifecycle

Answer and filename strings are rendered using React text interpolation, not raw HTML or a Markdown-to-HTML converter. HTML-looking content stays text. Similarity is not displayed as a confidence percentage because it measures retrieval similarity, not factual reliability.

Navigating away aborts the browser request and ignores late results. It cannot undo a provider request already sent by the backend. The shared session helper also prevents a response from an old session being shown to a newly signed-in user.

## Scope

Only the latest question and answer are displayed while this page is mounted. Navigating away, refreshing or signing out clears this view. Questions do not use earlier messages as context: ask a complete question each time. No database conversation history or streaming was added in this step.

## Try it

Start the backend and frontend, sign in, upload the fictional employee handbook through Documents, and wait for Ready for questions. Open Chat and ask about annual leave. A supported response should mention 18 days and cite the handbook. Ask an unrelated question to check the insufficient-information state.

Tests use controlled responses and do not send your real uploaded documents to Gemini. When you submit a question manually, the existing backend sends selected document excerpts to the configured Gemini provider.

## Verification

Chrome tests exercise trimmed request bodies, Bearer authentication, pending-state lockout, safe rendering of HTML-looking output, source labels, missing/partial/conflicting evidence, provider errors, expired sessions, invalid source mappings, mobile layout, and navigation during requests. The full browser suite also checks existing auth and document features.

From frontend:

```powershell
npm.cmd run build
npm.cmd run lint
node --experimental-strip-types --test tests/api.test.mjs tests/upload.test.mjs
npx.cmd playwright test
```

Next: plan conversation persistence, beginning with the database representation of conversations, messages and cited-source snapshots. Saving history and using it as model context are separate features.
