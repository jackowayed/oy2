* Use `yarn` for package management.
* Run `yarn check && yarn lint:fix && yarn format:fix` after writing code.
* Avoid defensive programming. To the extent possible, rely on the type system for guarantees instead.
* Ask questions if your instructions are unclear.
* The current production schema is stored in `production_schema.sql`. Keep it updated if you add database migrations.
* In a fresh sandbox, run `./scripts/dev-setup.sh` before anything else. It
  installs dependencies, starts Postgres, applies migrations and writes a
  placeholder `.dev.vars`. Claude Code on the web runs it automatically via a
  SessionStart hook; Codex should run it as its setup script (`.codex/setup.sh`).
  Then `source ./.dev-env` in any shell that runs `yarn dev`.
* `yarn test`, `yarn check` and `yarn lint` need no database — the worker tests
  run against the in-memory fake in `tests/worker/testUtils.ts`.
* No sandbox reaches Resend, Apple/Google OAuth, Google Maps or push, so any
  flow that signs a user in will fail there. Only the logged-out UI is
  reachable in a browser.
