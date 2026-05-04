# JWT Auth Transition Plan

## Objective
Move from opaque database-backed session tokens to one-week signed JWTs so authenticated requests do not need to call the session table, and the app can avoid the boot-time `/api/auth/session` call in the common case.

## Current State
- `worker/lib.ts` creates a random UUID token and stores it in `sessions`.
- `worker/index.ts` validates every request by reading the `session` cookie and querying `sessions JOIN users`.
- `src/App.tsx` calls `/api/auth/session` during startup before treating the user as authenticated.
- Login/signup routes in `worker/routes/passkey.ts`, `worker/routes/email.ts`, and `worker/routes/oauth.ts` all issue the same `session` cookie through duplicated `setSessionCookie()` helpers.

## Target State
- Login/signup creates an indefinite database session row and issues a signed JWT with a one-week `exp`.
- The Worker verifies the JWT locally using Web Crypto and populates `c.set("user", ...)` without querying `sessions`.
- Expired-but-valid JWTs fall back to the `sessions` table, mint a fresh one-week JWT, and continue the request.
- The frontend boots from a JS-readable bootstrap cookie or cached user snapshot and only corrects state if a later API request returns `401`.
- `/api/auth/session` remains as the explicit refresh/repair endpoint for expired JWTs and cold boot edge cases, but is no longer part of normal app boot.

## Token Shape
Use a compact, minimal payload:

```json
{
  "sub": "123",
  "sid": "session-uuid",
  "username": "alice",
  "email": "alice@example.com",
  "admin": true,
  "iat": 1777910400,
  "exp": 1778515200
}
```

Notes:
- `sub` is the canonical user id.
- `sid` is the canonical database session token. It is only queried when the JWT is expired or when a route explicitly needs the durable session handle.
- Keep only fields required to build `authUserPayload()`.
- Sign with `HS256` using a new `JWT_SECRET` Worker secret, or `EdDSA`/`ES256` if we want asymmetric key rotation later.
- Use one week exactly: `60 * 60 * 24 * 7`.
- Treat the `admin` claim as a UI hint only. Admin endpoints must re-check `users.admin` from the database.

## Cookie Strategy
Use the existing cookie name, `session`, to minimize routing and client changes:

- `HttpOnly: true`
- `Secure: true`
- `SameSite: Strict`
- `Path: /`
- `Max-Age`: keep longer than one week, matching the current long-lived cookie behavior, so expired JWTs can still reach the server and refresh through the indefinite `sessions` row.

Add a second JS-readable bootstrap cookie, `auth_user`, containing only non-sensitive display data from `authUserPayload()`:

- `HttpOnly: false`
- `Secure: true`
- `SameSite: Strict`
- `Path: /`
- `Max-Age`: match the `session` cookie

The frontend may use `auth_user` to initialize UI without `/api/auth/session`, but authorization must only trust the signed `session` JWT. Clear both cookies on logout and account deletion.

## Implementation Phases

### 1. Centralize Token Issuance
- Replace `createSession(c, user)` with `createAuthToken(c, user)` in `worker/lib.ts`.
- Add `setAuthCookie(c, token)` in one shared place and delete duplicated `setSessionCookie()` helpers from passkey, email, and OAuth routes.
- Keep creating `sessions` rows. The row's token becomes the JWT `sid` claim and remains the durable refresh handle.
- Keep the function return shape simple: routes already have the `user` and can continue returning `authUserPayload(user)`.

### 2. Add JWT Helpers
- Add helpers in `worker/lib.ts` or a new `worker/auth.ts`:
  - `signAuthJwt(c, user)`
  - `verifyAuthJwt(c, token)`
  - `verifyAuthJwtIgnoringExpiration(c, token)`
  - `authUserFromJwtPayload(payload)`
- Prefer Web Crypto directly to avoid adding a dependency unless the implementation becomes noisy.
- Add `JWT_SECRET` to `worker/types.ts`, `.env.example`, and deployment secrets documentation.

### 3. Replace Middleware Validation
- Update `worker/index.ts` auth middleware to:
  - read `session` cookie or `X-Session-Token`;
  - verify the JWT signature and `exp`;
  - populate `user` from token claims when the JWT is unexpired;
  - if the JWT is expired but the signature is otherwise valid, query `sessions JOIN users` by `sid`, mint fresh `session` and `auth_user` cookies, and populate `user`;
  - set a session id variable from the `sid` claim for logout/account deletion.
- Remove the per-request `sessions JOIN users` query from the normal unexpired-JWT path.
- Update admin route authorization to re-check `users.admin` from the database for admin endpoints, regardless of the JWT `admin` claim.

### 4. Update Logout and Account Deletion
- Logout should delete the `sessions` row identified by the JWT `sid`, then clear both `session` and `auth_user`.
- Account deletion should delete the user and clear both cookies.
- No token-version or denylist mechanism is included in the first pass. Deleting the `sessions` row prevents future refresh after JWT expiry, but a copied unexpired JWT remains valid until its one-week `exp` unless we add a per-request revocation lookup.

### 5. Remove Normal Boot Session Call
- Change `restoreSession()` in `src/App.tsx` to:
  - read `auth_user` first, then fall back to `cachedUser`;
  - call `loadData()` directly when a cached user exists;
  - clear cached auth state and show login on any authenticated API `401`.
- Update the shared `api()` wrapper in `src/App.tsx` or `apiFetch()` in `src/utils.ts` so `401` becomes the single invalid-session signal.
- Keep `/api/auth/session` as a repair path for cases where `loadData()` gets a `401` because the JWT expired and the request did not refresh cleanly. That endpoint should use the same expired-JWT `sid` fallback and set fresh cookies.
- Do not add an `Authorization: Bearer` path for Capacitor in the first pass. Assume cookies are reliable enough across iOS and Android, and revisit only if native testing proves otherwise.

### 6. Tests
- Update worker test utilities so inserted sessions are no longer required for authenticated requests.
- Add tests for:
  - successful login sets a JWT-looking `session` cookie;
  - successful login sets an `auth_user` bootstrap cookie;
  - authenticated routes accept a valid JWT without a session table row;
  - expired but otherwise valid JWT falls back to `sessions`, succeeds, and refreshes cookies;
  - expired JWT with missing/deleted `sid` returns unauthenticated;
  - admin endpoints re-check `users.admin`;
  - logout deletes the session row and clears both cookies;
  - account deletion clears both cookies;
  - tampered JWT is rejected.
- Update frontend tests, if present, around boot behavior and `401` cache clearing.

### 7. Rollout
- Deploy support for old opaque session tokens, new unexpired JWTs, and expired-but-valid JWT refresh:
  - try JWT verification first;
  - if JWT verification fails because the token is an old opaque session token, fall back to the old session DB lookup;
  - if JWT verification succeeds but `exp` is expired, query by `sid`;
  - when either fallback succeeds, mint fresh `session` and `auth_user` cookies.
- After the compatibility window, remove old opaque token support. Keep `sessions` because it provides indefinite duration and weekly refresh.
- Update `production_schema.sql` only if dropping `sessions` or adding revocation/version columns.

## Recommended First-Pass Tradeoff
Use one-week JWTs with an indefinite database session backing row. This removes the session lookup from normal requests while preserving long-lived login and weekly refresh. The tradeoff is one database lookup roughly once per week per active client, plus an admin-status database check on admin endpoints. Logout clears the client cookies immediately and deletes the refresh session, but cannot revoke a copied unexpired JWT without adding a lookup or denylist.

## Decisions Locked
- Admin endpoints re-check `users.admin` from the database.
- `/api/auth/session` stays and can refresh expired-but-valid JWTs by falling back to the indefinite `sessions` row.
- Add a JS-readable `auth_user` bootstrap cookie for frontend startup.
- Do not add a Capacitor bearer-token auth path unless native cookie testing shows a concrete problem.
