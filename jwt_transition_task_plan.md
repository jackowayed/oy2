# Task Plan: JWT Auth Transition

## Goal
Plan a transition from database-backed session-token validation to one-week JWT-backed auth that avoids the current session validation API/database round trip.

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: Research current auth flow
- [x] Phase 3: Write transition plan
- [x] Phase 4: Review with owner before implementation
- [x] Phase 5: Execute transition

## Key Questions
1. Is the API call to avoid the frontend boot call to `/api/auth/session`, the Worker session lookup query, or both?
2. Should logout be best-effort client-side only, or should the backend retain server-side revocation?
3. Is it acceptable for user display data embedded in a token to be stale for up to one week?

## Decisions Made
- Keep the primary auth credential as a `Secure`, `HttpOnly`, `SameSite=Strict` cookie.
- Use one-week JWT expiration.
- Keep indefinite `sessions` rows as the durable refresh handle.
- Include a session id (`sid`) in the JWT so expired-but-valid JWTs can fall back to the database session.
- Keep `/api/auth/session` for refresh/repair when JWTs expire.
- Add a JS-readable `auth_user` bootstrap cookie for frontend startup.
- Re-check `users.admin` in admin endpoints.
- Do not add a Capacitor bearer-token path in the first pass.
- Avoid a database migration for the initial plan because the existing `sessions` table remains in use.

## Errors Encountered
- Existing `task_plan.md` and `notes.md` are for an unrelated completed task, so JWT-specific files were created instead of overwriting them.

## Status
**Implemented** - JWT transition completed and validated with check, lint, format, and tests.
