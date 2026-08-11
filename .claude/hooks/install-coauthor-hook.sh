#!/usr/bin/env bash
# SessionStart hook: make commits in this repo carry a Co-authored-by trailer
# attributing GitHub user jackowayed, so each commit links to that account.
#
# Why this exists: Claude Code on the web pins a commit's author/committer to
# Claude <noreply@anthropic.com> so the runner's signature verifies on GitHub,
# and it only auto-adds a human co-author when CCR_SESSION_ACCOUNT_EMAIL is set.
# In this account's org-context web sessions that variable is empty, so no human
# co-author is added. We add it ourselves via a repo-local commit-msg hook.
#
# core.hooksPath is left unset in those sessions, so .git/hooks/<name> runs.
# If a tool (e.g. husky) later points core.hooksPath elsewhere, this hook will
# stop running and the trailer logic must move into that hooks dir instead.
set -eu

TRAILER="Co-authored-by: jackowayed <18899+jackowayed@users.noreply.github.com>"
MARKER="managed-by: oy2 coauthor SessionStart hook"

common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
hooks_dir="$common_dir/hooks"
mkdir -p "$hooks_dir"
hook="$hooks_dir/commit-msg"

# Preserve a pre-existing, foreign commit-msg hook by chaining to it first.
# Detect our own managed hook so re-running this stays idempotent.
prior=""
if [ -f "$hook" ] && ! grep -q "$MARKER" "$hook"; then
  prior="$hook.pre-coauthor.$(date +%s)"
  mv "$hook" "$prior"
fi

{
  printf '#!/bin/sh\n'
  printf '# %s\n' "$MARKER"
  printf 'PRIOR=%s\n' "'$prior'"
  printf '[ -n "$PRIOR" ] && [ -x "$PRIOR" ] && { "$PRIOR" "$@" || exit $?; }\n'
  printf 'git interpret-trailers --in-place \\\n'
  printf '  --if-exists addIfDifferent \\\n'
  printf "  --trailer '%s' \\\\\n" "$TRAILER"
  printf '  "$1"\n'
} > "$hook"
chmod +x "$hook"

echo "coauthor commit-msg hook installed at $hook"
