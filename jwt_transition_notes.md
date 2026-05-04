# Notes: JWT Auth Transition

## Current Flow
- `worker/lib.ts` creates opaque UUID session tokens and inserts them into the `sessions` table.
- `worker/routes/passkey.ts`, `worker/routes/email.ts`, and `worker/routes/oauth.ts` each set a long-lived `session` cookie after successful login or signup.
- `worker/index.ts` reads the `session` cookie, falls back to `X-Session-Token`, and queries `sessions JOIN users` on every request to populate `c.get("user")`.
- `src/App.tsx` calls `/api/auth/session` during `restoreSession()` to confirm the session and refresh `currentUser`.
- `src/App.tsx` already caches `currentUser` in `localStorage` as `cachedUser`.

## Important Constraints
- A `HttpOnly` JWT can remove the Worker-side session lookup, but frontend JavaScript cannot read it to restore user state without an API call.
- Avoiding the frontend boot call will use a separate JS-readable `auth_user` bootstrap cookie containing only non-sensitive display data.
- A one-week JWT should still include a `sid` claim backed by the existing indefinite `sessions` table. Normal requests avoid the DB lookup; expired-but-valid JWTs query by `sid` and get refreshed.
- User fields embedded in JWTs can become stale until token refresh or expiration. This mainly affects `username`, `email`, and `admin`.
- Admin endpoints should not trust the JWT `admin` claim. They should re-check `users.admin` server-side.
- Capacitor should continue relying on cookies; no bearer-token path is planned unless native testing shows cookies are unreliable.

## Relevant Files
- `worker/index.ts`: auth middleware and per-request session lookup.
- `worker/lib.ts`: `createSession()` and `authUserPayload()`.
- `worker/routes/auth.ts`: `/api/auth/session`, logout, account deletion.
- `worker/routes/admin.ts`: admin authorization should re-check `users.admin`.
- `worker/routes/passkey.ts`: passkey login/signup session issuance.
- `worker/routes/email.ts`: email login/signup session issuance.
- `worker/routes/oauth.ts`: OAuth login/signup session issuance.
- `src/App.tsx`: boot restore flow and cached user state.
- `src/utils.ts`: central API fetch wrapper.
