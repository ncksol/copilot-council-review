#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"

install -d "$COPILOT_HOME/extensions/council-orchestrator"
install -d "$COPILOT_HOME/skills/council-review"

install -m 0644 \
    "$ROOT_DIR/.github/extensions/council-orchestrator/extension.mjs" \
    "$COPILOT_HOME/extensions/council-orchestrator/extension.mjs"

install -m 0644 \
    "$ROOT_DIR/skills/council-review/SKILL.md" \
    "$COPILOT_HOME/skills/council-review/SKILL.md"

printf '%s\n' "Installed council-orchestrator to $COPILOT_HOME/extensions/council-orchestrator/extension.mjs"
printf '%s\n' "Installed council-review skill to $COPILOT_HOME/skills/council-review/SKILL.md"
printf '%s\n' "Restart Copilot CLI or run /clear in an interactive session to reload."
