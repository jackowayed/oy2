#!/usr/bin/env bash
#
# Codex setup script. Point the Codex environment's setup command at
# `.codex/setup.sh` (or at `scripts/dev-setup.sh` directly).
#
# Codex has no SessionStart hook, so unlike the Claude wrapper this runs
# unconditionally — a Codex container is always a throwaway sandbox.
set -euo pipefail

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/dev-setup.sh"
