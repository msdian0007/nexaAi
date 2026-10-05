# Frontend integration — Step 1: API and authentication foundation

The backend RAG evaluation is complete. The roadmap's recommended implementation order puts Chat UI after RAG; the current frontend still needs authentication before it can call protected APIs. Earlier work used Phase 3 for document/RAG development, while the original plan has different numbering. These frontend steps use descriptive names to avoid confusing those sequences.

## What this step adds

`src/services/api.ts` is the shared HTTP client. `src/features/auth/auth.api.ts` defines login, registration and identity calls matching the current Express endpoints. `.env.example` documents the public backend address.

For example, a future login form will call:

```ts
const session = await login({ email, password });
const identity = await getIdentity(session.token);
```

The first call sends JSON to POST /api/v1/auth/login. Express verifies the password and returns a token, user, organization and role. The second call sends GET /api/v1/auth/me with `Authorization: Bearer <token>`. Express verifies that token and returns its identity claims. This is how the browser tells the backend which authenticated session is making the request. Merely hiding a page in React does not authorize access; the backend remains responsible for access checks.

## Why centralize HTTP behavior?

Every feature needs a backend address, JSON parsing and useful errors. A shared client keeps these behaviors consistent. Native fetch already provides the transport, so this small step needs no new packages.

The client checks the HTTP status and the backend's `{ success: true, data: ... }` envelope, then returns `data`. The TypeScript types document the expected fields; they do not validate every nested response field at runtime.

The token is an explicit argument for protected calls. There is no global token storage yet. Login and registration calls therefore do not accidentally attach a previous user's token. Passwords and tokens are not logged or persisted by this layer.

`ApiError` contains a user-facing message, HTTP status and optional backend code. A 401 can be handled by login UI; a 503 can show temporary service unavailability. Network failures use status 0 because no HTTP response was received. Backend error text is not displayed verbatim because existing auth handlers can include internal error details.

Requests have a 60-second timeout. A page can also provide an AbortSignal to cancel a request when the user navigates away. Cancellation is preserved as cancellation, instead of being shown as a network error. There are no automatic retries, which avoids accidentally submitting a registration twice.

## Configuration

The default API base is `http://localhost:5000/api/v1`. To override it, create `frontend/.env.local` using `.env.example`, then restart Vite. The repository already ignores `*.local`.

`VITE_` variables are browser-visible configuration. The API URL is public. Gemini keys and JWT signing secrets belong only in the backend environment.

## Validation and scope

From frontend, use:

```powershell
node --experimental-strip-types --test tests/api.test.mjs
npm.cmd run build
npm.cmd run lint
```

The tests run on the project's Node 22 environment with controlled HTTP responses. They check JSON and Bearer headers, path restrictions, error sanitization, unexpected payloads, network failures and cancellation. They do not create real accounts or call Gemini.

This step does not change the visible dashboard. The next step adds login/register screens and in-memory session state, connecting these functions to a user-facing flow. Protected dashboard navigation and the chat interface follow in separate steps.
