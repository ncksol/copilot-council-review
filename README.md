# copilot-council-review

`copilot-council-review` is a **GitHub Copilot CLI plugin** that packages:

1. A `council-review` skill for structured multi-perspective review.
2. A `council_run` MCP tool that performs true multi-session orchestration for persona generation, parallel reviewers, judge synthesis, and recommendation audit.

The plugin replaces the earlier extension-based packaging with a marketplace/installable plugin layout.

## Contents

| Path | Purpose |
| --- | --- |
| `plugin.json` | Copilot CLI plugin manifest. |
| `.mcp.json` | MCP server configuration for the council orchestrator tool. |
| `servers/council-mcp.mjs` | Standalone MCP server that runs the orchestration. |
| `skills/council-review/SKILL.md` | Skill that prefers `council_run` and falls back to prompt-only review when needed. |
| `.github/plugin/marketplace.json` | Marketplace manifest for plugin discovery and installation. |
| `scripts/install-user.sh` | Installs the plugin from a local checkout on macOS/Linux. |
| `scripts/install-user.ps1` | Installs the plugin from a local checkout on Windows PowerShell. |

## Requirements

- GitHub Copilot CLI with plugin support.
- Node.js 18+ available as `node`.

## Preferred install path

Register the repository as a marketplace:

```bash
copilot plugin marketplace add ncksol/copilot-council-review
```

Then install from that marketplace:

```bash
copilot plugin install copilot-council-review@copilot-council-review
```

## Reinstall after older versions

If you installed an earlier plugin build that timed out while loading `council-orchestrator`, reinstall it to get the framing/loader fix in `v0.1.2`:

```bash
copilot plugin uninstall copilot-council-review
copilot plugin marketplace add ncksol/copilot-council-review
copilot plugin install copilot-council-review@copilot-council-review
```

## Install from a local checkout

### macOS / Linux

```bash
./scripts/install-user.sh
```

### PowerShell

```powershell
./scripts/install-user.ps1
```

Both scripts install from the published GitHub marketplace entry so the MCP server lands in a stable path that the bootstrap loader can resolve reliably.

## Using the plugin

After installation, restart Copilot CLI or run `/clear`, then ask Copilot to use the skill:

```text
Use the council-review skill to review src/server.ts and docs/auth.md
```

Or ask for a council review directly and let Copilot invoke `council_run`.

## Notes

- This plugin does **not** provide the old `/council` extension slash command.
- The orchestrator uses isolated `copilot -p` runs under the hood so each phase is genuinely separate.
- Artifacts are written to `~/.copilot/files/council-runs/` by default, or to `artifactPath` when you provide one.
