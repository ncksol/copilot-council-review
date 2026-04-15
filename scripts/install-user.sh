#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v copilot >/dev/null 2>&1; then
    printf '%s\n' "copilot CLI is required but was not found in PATH." >&2
    exit 1
fi

copilot plugin install "$ROOT_DIR"

printf '%s\n' "Installed plugin from $ROOT_DIR"
printf '%s\n' "Restart Copilot CLI or run /clear in an interactive session to reload."
