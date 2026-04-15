# copilot-council-review

`copilot-council-review` packages a GitHub Copilot CLI review workflow as two pieces:

1. A `council-review` skill that knows how to run a structured multi-perspective review.
2. A `council-orchestrator` extension that performs true multi-session orchestration for persona generation, parallel reviewers, judge synthesis, and recommendation audit.

## Contents

| Path | Purpose |
| --- | --- |
| `.github/extensions/council-orchestrator/extension.mjs` | Project-local Copilot CLI extension. |
| `skills/council-review/SKILL.md` | Copilot skill that prefers the `council_run` tool and falls back to prompt-only review when needed. |
| `scripts/install-user.sh` | Installs the extension and skill into `~/.copilot` for machine-wide interactive use on macOS/Linux. |
| `scripts/install-user.ps1` | Installs the extension and skill into `~/.copilot` for machine-wide interactive use on Windows PowerShell. |

## Requirements

- GitHub Copilot CLI with extension support.
- Interactive Copilot CLI sessions for the full orchestrated flow.

## Use it in this repo

Clone the repo, start `copilot` from the repo root, then run either of these:

```text
/council Review this architecture decision and prioritise the risks.
```

or ask Copilot to use the skill:

```text
Use the council-review skill to review src/server.ts and docs/auth.md
```

## Install for use anywhere

### macOS / Linux

```bash
./scripts/install-user.sh
```

### PowerShell

```powershell
./scripts/install-user.ps1
```

The scripts copy the extension into `~/.copilot/extensions/council-orchestrator/` and the skill into `~/.copilot/skills/council-review/`.

After installing, restart Copilot CLI or run `/clear` in an existing interactive session.

## Notes

- The skill prefers the `council_run` extension tool when it is available.
- The extension is intended for interactive Copilot CLI use. Non-interactive `copilot -p` flows are not the primary target.
- Council artifacts are written into the Copilot session workspace, not into this repository.
