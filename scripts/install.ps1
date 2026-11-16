param(
    [string]$Bridge,
    [string]$Gateway,
    [string]$Extension,
    [string]$Node,
    [string]$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agy_chrome_bridge'
)
$ErrorActionPreference = 'Stop'
function Remove-RegistryDefaultValue([string]$Path) {
    if ($Path -notmatch '^HKCU:\\(.+)$') { throw 'Only HKCU native host keys are supported' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Matches[1], $true)
    try { $key.DeleteValue('', $false) } finally { $key.Dispose() }
}
if (-not $Bridge) {
    $Bridge = if (Test-Path (Join-Path $PSScriptRoot 'bridge.cjs')) { Join-Path $PSScriptRoot 'bridge.cjs' } else { Join-Path $PSScriptRoot '..\src\bridge.cjs' }
}
if (-not $Gateway) {
    $Gateway = if (Test-Path (Join-Path $PSScriptRoot 'gateway.cjs')) { Join-Path $PSScriptRoot 'gateway.cjs' } else { Join-Path $PSScriptRoot '..\src\gateway.cjs' }
}
if (-not $Extension) {
    $Extension = if (Test-Path (Join-Path $PSScriptRoot 'extension')) { Join-Path $PSScriptRoot 'extension' } else { Join-Path $PSScriptRoot '..\extension' }
}
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source }
$sourceBridge = (Resolve-Path -LiteralPath $Bridge).Path
$sourceGateway = (Resolve-Path -LiteralPath $Gateway).Path
$sourceExtension = (Resolve-Path -LiteralPath $Extension).Path
$sourceWs = if (Test-Path (Join-Path $PSScriptRoot 'node_modules\ws')) { Join-Path $PSScriptRoot 'node_modules\ws' } else { Join-Path $PSScriptRoot '..\node_modules\ws' }
$sourceWs = (Resolve-Path -LiteralPath $sourceWs).Path
$nodePath = (Resolve-Path -LiteralPath $Node).Path
$version = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) { throw 'Node.js 18 or newer is required. No changes made.' }
$root = Join-Path $env:LOCALAPPDATA 'agy-chrome-bridge'
$bridgeDirectory = Join-Path $root 'bridge'
$bridgePath = Join-Path $bridgeDirectory 'bridge.cjs'
$gatewayPath = Join-Path $bridgeDirectory 'gateway.cjs'
$upgrading = Test-Path -LiteralPath $bridgePath
$legacyBin = Join-Path $root 'bin\agy-chrome-bridge.exe'
$installedExtension = Join-Path $root 'extension'
$manifestPath = Join-Path $root 'com.agy_chrome_bridge.json'
$configPath = Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
$registryExisted = Test-Path -LiteralPath $RegistryPath
$previousRegistration = if ($registryExisted) { (Get-Item -LiteralPath $RegistryPath).GetValue('') } else { $null }
if ($previousRegistration -and $previousRegistration -ne $manifestPath) { throw 'A different native host already owns com.agy_chrome_bridge. No changes made.' }
$installedConfig = Join-Path $installedExtension 'bridge_config.json'
if (Test-Path -LiteralPath $installedConfig) {
    $pairToken = (Get-Content -Raw -Encoding UTF8 -LiteralPath $installedConfig | ConvertFrom-Json).token
    if ($pairToken -notmatch '^[a-f0-9]{64}$') { throw 'Installed bridge configuration is invalid. No changes made.' }
} else {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pairToken = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
function Remove-OldBackups([string]$Directory, [string]$Filter) {
    $stale = Get-ChildItem -LiteralPath $Directory -Filter $Filter -Force -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 2
    foreach ($item in $stale) {
        try { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop }
        catch { Write-Warning "Could not remove old backup $($item.FullName): $($_.Exception.Message)" }
    }
}
if (Test-Path -LiteralPath $configPath) {
    try { $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json }
    catch {
        throw ('Cannot read {0} as JSON; it may contain comments or trailing commas. No changes made. Add the server manually with: agy mcp add agy-chrome-bridge -- "{1}" "{2}" --mcp' -f $configPath, $nodePath, $bridgePath)
    }
    $existing = $config.mcpServers.'agy-chrome-bridge'
    if ($existing) {
        $legacy = $existing.command -eq $legacyBin
        $ours = $existing.command -and (Split-Path -Leaf $existing.command) -eq 'node.exe' -and @($existing.args).Count -eq 2 -and $existing.args[0] -eq $bridgePath -and $existing.args[1] -eq '--mcp'
        if (-not $legacy -and -not $ours) { throw 'A different MCP server already owns agy-chrome-bridge. No changes made.' }
    }
}
if (Get-Process -Name 'agy-chrome-bridge' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $legacyBin }) {
    throw 'The previous bridge is running. Disconnect the extension and exit AGY sessions before upgrading. No changes made.'
}
$nodeProcesses = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
if ($nodeProcesses | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($bridgePath) -and $_.CommandLine.Contains('--mcp') }) {
    throw 'The bridge is running. Exit AGY CLI and IDE sessions before upgrading. No changes made.'
}
$gatewayProcesses = @($nodeProcesses | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($gatewayPath) })
if ($gatewayProcesses.Count -gt 0) {
    $killHint = 'If it cannot be stopped, end node PID {0} manually (Stop-Process -Id {0} -Force) and run this installer again.' -f ($gatewayProcesses.ProcessId -join ', ')
    & $nodePath $bridgePath --shutdown
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the previous gateway. No changes made. $killHint" }
    Start-Sleep -Milliseconds 300
    if (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($gatewayPath) }) {
        throw "The previous gateway is still running. No changes made. $killHint"
    }
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$stage = Join-Path $root "stage_$stamp"
New-Item -ItemType Directory -Path (Join-Path $stage 'bridge') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'bridge\node_modules\ws\lib') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'extension') -Force | Out-Null
Copy-Item -LiteralPath $sourceBridge -Destination (Join-Path $stage 'bridge\bridge.cjs')
Copy-Item -LiteralPath $sourceGateway -Destination (Join-Path $stage 'bridge\gateway.cjs')
foreach ($name in @('index.js', 'package.json', 'LICENSE')) { Copy-Item -LiteralPath (Join-Path $sourceWs $name) -Destination (Join-Path (Join-Path $stage 'bridge\node_modules\ws') $name) }
Get-ChildItem -LiteralPath (Join-Path $sourceWs 'lib') -File -Filter '*.js' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path (Join-Path $stage 'bridge\node_modules\ws\lib') $_.Name) }
foreach ($name in @('manifest.json', 'background.js', 'popup.html', 'popup.js')) { Copy-Item -LiteralPath (Join-Path $sourceExtension $name) -Destination (Join-Path (Join-Path $stage 'extension') $name) }
$configText = @{ token = $pairToken } | ConvertTo-Json -Compress
$configPathStage = Join-Path $stage 'extension\bridge_config.json'
[System.IO.File]::WriteAllText($configPathStage, $configText, [System.Text.UTF8Encoding]::new($false))
$sid = (& (Join-Path $env:SystemRoot 'System32\whoami.exe') /user /fo csv /nh).Trim().Split(',')[-1].Trim('"')
if ($sid -notmatch '^S-1-(?:\d+-)*\d+$') { throw 'Cannot determine current user SID' }
& (Join-Path $env:SystemRoot 'System32\icacls.exe') $configPathStage /inheritance:r /grant:r "*${sid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict bridge configuration ACL' }
$configBackup = "$configPath.backup_agy_chrome_$stamp"
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination $configBackup }
$paths = @(
    @{ Target = $bridgeDirectory; Source = (Join-Path $stage 'bridge') },
    @{ Target = $installedExtension; Source = (Join-Path $stage 'extension') }
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
    if (Test-Path -LiteralPath $manifestPath) {
        $backup = "$manifestPath.backup_$stamp"
        Move-Item -LiteralPath $manifestPath -Destination $backup
        $moved.Add(@{ Target = $manifestPath; Backup = $backup; Installed = $false })
    }
    if ($registryExisted) {
        $registryChanged = $true
        Remove-RegistryDefaultValue $RegistryPath
    }
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
            else { Remove-RegistryDefaultValue $RegistryPath }
        }
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
Remove-OldBackups $root 'bridge.backup_*'
Remove-OldBackups $root 'extension.backup_*'
Remove-OldBackups $root 'com.agy_chrome_bridge.json.backup_*'
Remove-OldBackups (Split-Path -Parent $configPath) 'mcp_config.json.backup_agy_chrome_*'
Write-Output "Installed Node bridge: $bridgePath"
Write-Output "Load unpacked extension in the selected Chrome profile: $installedExtension"
if ($upgrading) { Write-Output 'Reload the extension in chrome://extensions in each profile where it is loaded, so the updated background script takes effect.' }
