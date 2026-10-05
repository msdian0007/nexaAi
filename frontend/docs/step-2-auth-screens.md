# Frontend integration — Step 2: Login, registration and session state

## What you can do now

The frontend opens on a login screen. Choose Create an account to register a user and a new organization using the existing backend. After login or registration succeeds, the page displays the returned name, email, organization and role. Sign out returns to a clean login form.

Start the backend with `npm.cmd run dev` from backend and the frontend with the same command from frontend. Open the Vite URL printed in the terminal. Existing Postman-created credentials work here too. New registration creates real database records; use login when you already have an account.

## Follow one login request

1. The user submits the form. Browser validation catches missing fields and invalid email format.
2. AuthForm reads the values. It trims surrounding whitespace from names and email, but preserves the password exactly.
3. The form disables its fields and buttons and announces that the request is in progress. A synchronous ref also guards against duplicate submissions before React renders the disabled state.
4. The existing login function calls Express. The backend checks the password and returns the session. React does not verify passwords or create its own JWT.
5. App stores the session using `useState`. React renders the workspace because the session is no longer null. The form unmounts and its field values are discarded.
6. On failure, the form shows a safe error, moves focus to it, and unlocks so the user can correct the input and try again.

Registration follows the same sequence, adding full name and organization name and an eight-character password minimum matching the current backend. The browser catches ordinary mistakes; backend validation and authorization are still essential. Whitespace-only names are rejected before sending the request.

## What session state means

The session is the backend's token plus user, organization and role metadata held in React memory. No password or token is written to localStorage, sessionStorage or cookies. Refreshing closes that in-memory session and shows login again. This is deliberate for this step; durable login can be designed separately.

Sign out clears local state. It does not revoke the already-issued JWT on the server; that token retains its existing expiry. Likewise, conditionally showing the workspace is a UI behavior, not an authorization boundary. Express must validate tokens on every protected API call. Automatic session-expiry handling and protected navigation are subsequent work.

## Component responsibilities

- App owns the current session and chooses between the form and workspace.
- AuthForm owns mode, loading and error state, field collection and request cancellation.
- auth.api.ts owns endpoint calls and types from Step 1.
- CSS provides responsive layout, labels, focus indicators and status/error presentation. The original dashboard used utility classes without an installed utility CSS framework; this step uses ordinary CSS.

Switching modes remounts the form to clear credentials and resets errors. Switching is disabled while a request is pending. Unmounting aborts an active request; a cancelled request cannot later sign the user in through this form.

## Verification

```powershell
npm.cmd run build
npm.cmd run lint
node --experimental-strip-types --test tests/api.test.mjs
npx.cmd playwright test
```

The browser suite uses installed Chrome in headless mode, starts an isolated Vite server on port 4173, and intercepts authentication responses. It checks actual UI interactions: login, registration payloads, loading lockout, errors and focus, sign out, refresh behavior, validation and mobile overflow. It does not create accounts in the real database. API-client tests remain separate.

Playwright is a development-only dependency. Other machines need Chrome installed for this configuration, or can change the channel to an installed Playwright browser. Test output directories are ignored by Git.

## Next step

Add protected dashboard navigation and shared session access so document and chat pages can use the signed-in identity. The document upload and chat interfaces remain separate steps.
