param(
    [string]$Bridge,
    [string]$Extension,
    [string]$Node,
    [string]$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agy_chrome_bridge'
)
$ErrorActionPreference = 'Stop'
if (-not $Bridge) {
    $Bridge = if (Test-Path (Join-Path $PSScriptRoot 'bridge.cjs')) { Join-Path $PSScriptRoot 'bridge.cjs' } else { Join-Path $PSScriptRoot '..\src\bridge.cjs' }
}
if (-not $Extension) {
    $Extension = if (Test-Path (Join-Path $PSScriptRoot 'extension')) { Join-Path $PSScriptRoot 'extension' } else { Join-Path $PSScriptRoot '..\extension' }
}
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source }
$sourceBridge = (Resolve-Path -LiteralPath $Bridge).Path
$sourceExtension = (Resolve-Path -LiteralPath $Extension).Path
$nodePath = (Resolve-Path -LiteralPath $Node).Path
$version = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) { throw 'Node.js 18 or newer is required. No changes made.' }
$root = Join-Path $env:LOCALAPPDATA 'agy-chrome-bridge'
$bridgeDirectory = Join-Path $root 'bridge'
$bridgePath = Join-Path $bridgeDirectory 'bridge.cjs'
$hostPath = Join-Path $bridgeDirectory 'host.cmd'
$legacyBin = Join-Path $root 'bin\agy-chrome-bridge.exe'
$installedExtension = Join-Path $root 'extension'
$manifestPath = Join-Path $root 'com.agy_chrome_bridge.json'
$configPath = Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
$registryExisted = Test-Path -LiteralPath $RegistryPath
$previousRegistration = if ($registryExisted) { (Get-Item -LiteralPath $RegistryPath).GetValue('') } else { $null }
if ($previousRegistration -and $previousRegistration -ne $manifestPath) { throw 'A different native host already owns com.agy_chrome_bridge. No changes made.' }
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $existing = $config.mcpServers.'agy-chrome-bridge'
    if ($existing) {
        $legacy = $existing.command -eq $legacyBin
        $ours = $existing.command -eq $nodePath -and @($existing.args).Count -eq 2 -and $existing.args[0] -eq $bridgePath -and $existing.args[1] -eq '--mcp'
        if (-not $legacy -and -not $ours) { throw 'A different MCP server already owns agy-chrome-bridge. No changes made.' }
    }
}
if (Get-Process -Name 'agy-chrome-bridge' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $legacyBin }) {
    throw 'The previous bridge is running. Disconnect the extension and exit AGY sessions before upgrading. No changes made.'
}
$nodeProcesses = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
if ($nodeProcesses | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($bridgePath) }) {
    throw 'The bridge is running. Disconnect the extension and exit AGY sessions before upgrading. No changes made.'
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$stage = Join-Path $root "stage_$stamp"
New-Item -ItemType Directory -Path (Join-Path $stage 'bridge') -Force | Out-Null
Copy-Item -LiteralPath $sourceBridge -Destination (Join-Path $stage 'bridge\bridge.cjs')
Copy-Item -LiteralPath $sourceExtension -Destination (Join-Path $stage 'extension') -Recurse
$escapedNode = $nodePath.Replace('%', '%%')
$cmd = "@echo off`r`nchcp 65001 >nul`r`nsetlocal DisableDelayedExpansion`r`n`"$escapedNode`" `"%~dp0bridge.cjs`"`r`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'bridge\host.cmd'), $cmd, [System.Text.UTF8Encoding]::new($false))
$native = @{ name = 'com.agy_chrome_bridge'; description = 'AGY Chrome Bridge'; path = $hostPath; type = 'stdio'; allowed_origins = @('chrome-extension://deankghpcmnggohdfkoaggafbmjmkmlj/') }
[System.IO.File]::WriteAllText((Join-Path $stage 'host.json'), ($native | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
$configBackup = "$configPath.backup_agy_chrome_$stamp"
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination $configBackup }
$paths = @(
    @{ Target = $bridgeDirectory; Source = (Join-Path $stage 'bridge') },
    @{ Target = $installedExtension; Source = (Join-Path $stage 'extension') },
    @{ Target = $manifestPath; Source = (Join-Path $stage 'host.json') }
)
$moved = [System.Collections.Generic.List[object]]::new()
$registryChanged = $false
$mcpStarted = $false
try {
    foreach ($item in $paths) {
        $backup = "$($item.Target).backup_$stamp"
        if (Test-Path -LiteralPath $item.Target) { Move-Item -LiteralPath $item.Target -Destination $backup } else { $backup = $null }
        $record = @{ Target = $item.Target; Backup = $backup; Installed = $false }
        $moved.Add($record)
        Move-Item -LiteralPath $item.Source -Destination $item.Target
        $record.Installed = $true
    }
    if (-not $registryExisted) { New-Item -Path $RegistryPath -Force | Out-Null }
    $registryChanged = $true
    Set-Item -LiteralPath $RegistryPath -Value $manifestPath
    $mcpStarted = $true
    & agy mcp add agy-chrome-bridge -- $nodePath $bridgePath --mcp
    if ($LASTEXITCODE -ne 0) { throw "AGY MCP registration failed with exit code $LASTEXITCODE" }
} catch {
    if ($mcpStarted) {
        if (Test-Path -LiteralPath $configBackup) { Copy-Item -LiteralPath $configBackup -Destination $configPath -Force }
        elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
    }
    if ($registryChanged) {
        if ($registryExisted) {
            if ($null -ne $previousRegistration) { Set-Item -LiteralPath $RegistryPath -Value $previousRegistration }
            else { (Get-Item -LiteralPath $RegistryPath).DeleteValue('', $false) }
        } else { Remove-Item -LiteralPath $RegistryPath }
    }
    for ($i = $moved.Count - 1; $i -ge 0; $i--) {
        $record = $moved[$i]
        if ($record.Installed) { Remove-Item -LiteralPath $record.Target -Recurse -Force }
        if ($record.Backup) { Move-Item -LiteralPath $record.Backup -Destination $record.Target }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
Write-Output "Installed Node bridge: $bridgePath"
Write-Output "Load unpacked extension in the selected Chrome profile: $installedExtension"
