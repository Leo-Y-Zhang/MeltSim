#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Synchronous, idempotent: installs deps so lint/typecheck/tests work
# immediately. Only runs in a remote (web) session.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

# `npm install` (not `npm ci`) so a cached container layer's node_modules is
# reused and only updated, rather than wiped and reinstalled from scratch.
npm install

exit 0
