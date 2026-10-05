# Frontend integration — Step 3: Protected navigation and shared session

## What changed

React Router now gives login, registration and the dashboard separate URLs:

| URL | Behavior |
| --- | --- |
| / | Redirect to login or the dashboard according to session state |
| /login | Login form; an existing session redirects to the dashboard |
| /register | Registration form; an existing session redirects to the dashboard |
| /dashboard | Available only after session verification |
| Anything else | Page-not-found screen with a home link |

React Router changes pages within the running React app, preserving the in-memory session. A browser refresh still resets it. When hosting this frontend later, configure the host to serve index.html for frontend routes such as /dashboard; Vite's development server already handles them.

## Why a shared provider?

Previously App owned the session directly. Future document and chat pages need the same token, organization and sign-out behavior. AuthProvider now owns that state. Any component inside it can call useAuth() to access it without passing session props through every intermediate component.

The provider has four states:

- anonymous: no session, show login.
- checking: a login/registration response supplied a session; verify it through /auth/me before showing protected content.
- authenticated: the backend accepted the token and returned matching user and organization IDs.
- unavailable: verification failed without a 401; keep the candidate session and offer retry or sign out.

For example: login succeeds, then /auth/me encounters a network outage. The user sees a retry screen rather than a password error. If /auth/me returns 401, the provider clears the session and the route guard returns to login with an explanation. A mismatched identity is rejected as well.

## Backend versus frontend authorization

ProtectedRoute controls which React content is rendered. It cannot protect database records by itself. Express still validates Bearer tokens and scopes document access by organization.

The current /auth/me endpoint verifies the JWT signature and expiry and returns its claims. It does not re-query organization membership or detect server-side membership changes immediately. Frontend verification does not add token revocation or change that backend behavior.

## Protected requests for upcoming pages

The provider exposes a request helper:

```ts
const { request } = useAuth();
// Inside a future chat submit handler:
const answer = await request('/chat/query', {
  method: 'POST',
  body: { question: 'How much annual leave do employees receive?' },
});
```

This helper attaches the current verified session token. A 401 clears that session; a 403 or 503 does not automatically log the user out. The current step does not yet add a chat form. Future protected features must use this helper to share expiry behavior. There is no background polling or expiry timer: expiration is discovered when verification or an authenticated request receives 401.

Request results belong to the session that started them. If the user signs out or changes session while a request runs, its late result is discarded. Session verification additionally uses AbortController to cancel the request on logout or replacement. This prevents old responses from restoring a signed-out session or populating a different user's screen.

## Try it

Run backend and frontend development servers as before. Open /dashboard while signed out: it should redirect to /login. Login with existing credentials: the app briefly checks /auth/me, then displays your workspace. Sign out: /dashboard is no longer available. Refresh the dashboard: in-memory state is lost, so login is required again.

## Verification

The browser suite covers direct URL access, registration URLs, refresh, successful verification, delayed verification, 401, identity mismatch, service failure plus retry, logout and late-response handling. Existing login and registration tests now also mock /auth/me and check the Bearer header. Tests use fictional responses, not real accounts or Gemini calls.

Run from frontend:

```powershell
npm.cmd run build
npm.cmd run lint
node --experimental-strip-types --test tests/api.test.mjs
npx.cmd playwright test
```

Next: document management UI, beginning with connecting a document upload form to the existing backend. Chat UI follows after users can supply their documents through the browser.
