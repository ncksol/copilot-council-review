Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }

$extensionDir = Join-Path $copilotHome "extensions/council-orchestrator"
$skillDir = Join-Path $copilotHome "skills/council-review"

New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null

Copy-Item `
    (Join-Path $rootDir ".github/extensions/council-orchestrator/extension.mjs") `
    (Join-Path $extensionDir "extension.mjs") `
    -Force

Copy-Item `
    (Join-Path $rootDir "skills/council-review/SKILL.md") `
    (Join-Path $skillDir "SKILL.md") `
    -Force

Write-Host "Installed council-orchestrator to $(Join-Path $extensionDir 'extension.mjs')"
Write-Host "Installed council-review skill to $(Join-Path $skillDir 'SKILL.md')"
Write-Host "Restart Copilot CLI or run /clear in an interactive session to reload."
