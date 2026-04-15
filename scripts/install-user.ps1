Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    throw "copilot CLI is required but was not found in PATH."
}

copilot plugin install $rootDir

Write-Host "Installed plugin from $rootDir"
Write-Host "Restart Copilot CLI or run /clear in an interactive session to reload."
