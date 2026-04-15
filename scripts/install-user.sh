#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_REPO="${PLUGIN_REPO:-ncksol/copilot-council-review}"
PLUGIN_NAME="copilot-council-review"

if ! command -v copilot >/dev/null 2>&1; then
    printf '%s\n' "copilot CLI is required but was not found in PATH." >&2
    exit 1
fi

copilot plugin uninstall "$PLUGIN_NAME" >/dev/null 2>&1 || true
copilot plugin marketplace add "$PLUGIN_REPO" >/dev/null 2>&1 || true
copilot plugin install "$PLUGIN_NAME@$PLUGIN_NAME"

printf '%s\n' "Installed plugin from marketplace $PLUGIN_REPO"
printf '%s\n' "Restart Copilot CLI or run /clear in an interactive session to reload."
