Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pluginRepo = if ($env:PLUGIN_REPO) { $env:PLUGIN_REPO } else { "ncksol/copilot-council-review" }
$pluginName = "copilot-council-review"

if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    throw "copilot CLI is required but was not found in PATH."
}

try {
    copilot plugin uninstall $pluginName | Out-Null
} catch {
}

try {
    copilot plugin marketplace add $pluginRepo | Out-Null
} catch {
}

copilot plugin install "$pluginName@$pluginName"

Write-Host "Installed plugin from marketplace $pluginRepo"
Write-Host "Restart Copilot CLI or run /clear in an interactive session to reload."
