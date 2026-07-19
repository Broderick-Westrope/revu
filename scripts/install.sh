#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

EDITOR_CMD="${1:-}"
if [[ -z "$EDITOR_CMD" ]]; then
  if command -v cursor >/dev/null 2>&1; then
    EDITOR_CMD="cursor"
  elif command -v code >/dev/null 2>&1; then
    EDITOR_CMD="code"
  else
    echo "error: neither 'cursor' nor 'code' found on PATH; pass one as an argument" >&2
    exit 1
  fi
fi

echo "==> compiling"
npm run compile

echo "==> testing"
npm test

echo "==> packaging"
npx @vscode/vsce package --no-dependencies -o revu.vsix

echo "==> installing via $EDITOR_CMD"
"$EDITOR_CMD" --install-extension revu.vsix 2>/dev/null

echo "done — reload the editor window to pick up the new version"
