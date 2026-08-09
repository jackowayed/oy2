#!/usr/bin/env bash
#
# SessionStart hook for Claude Code on the web. All of the real work lives in
# scripts/dev-setup.sh so that Codex and any other tool can run the exact same
# setup — keep the logic there, not here.
set -euo pipefail

# Only for throwaway remote containers. A local checkout is the developer's own
# machine: don't start services or rewrite their database there.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

exec "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/scripts/dev-setup.sh"
