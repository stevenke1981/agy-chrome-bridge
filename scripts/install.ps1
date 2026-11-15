param(
    [string]$Binary,
    [string]$Extension,
    [string]$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agy_chrome_bridge'
)
$ErrorActionPreference = 'Stop'
if (-not $Binary) {
    $Binary = if (Test-Path (Join-Path $PSScriptRoot 'agy-chrome-bridge.exe')) { Join-Path $PSScriptRoot 'agy-chrome-bridge.exe' } else { Join-Path $PSScriptRoot '..\target\release\agy-chrome-bridge.exe' }
}
if (-not $Extension) {
    $Extension = if (Test-Path (Join-Path $PSScriptRoot 'extension')) { Join-Path $PSScriptRoot 'extension' } else { Join-Path $PSScriptRoot '..\extension' }
}
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$extensionPath = (Resolve-Path -LiteralPath $Extension).Path
$root = Join-Path $env:LOCALAPPDATA 'agy-chrome-bridge'
$bin = Join-Path $root 'bin\agy-chrome-bridge.exe'
$installedExtension = Join-Path $root 'extension'
$manifestPath = Join-Path $root 'com.agy_chrome_bridge.json'
$regPath = $RegistryPath
$configPath = Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
$registryExisted = Test-Path $regPath
$existingRegistration = if ($registryExisted) { (Get-Item $regPath).GetValue('') } else { $null }
if ($existingRegistration -and $existingRegistration -ne $manifestPath) { throw 'A different native host already owns com.agy_chrome_bridge. No changes made.' }
if (Test-Path $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $existing = $config.mcpServers.'agy-chrome-bridge'
    if ($existing -and $existing.command -ne $bin) { throw 'A different MCP server already owns agy-chrome-bridge. No changes made.' }
}
if (Get-Process -Name 'agy-chrome-bridge' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $bin }) {
    throw 'The installed bridge is running. Disconnect the extension and exit AGY sessions before upgrading. No changes made.'
}
New-Item -ItemType Directory -Force -Path (Split-Path $bin), $root | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$stage = Join-Path $root "stage_$stamp"
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $stage 'agy-chrome-bridge.exe')
Copy-Item -LiteralPath $extensionPath -Destination (Join-Path $stage 'extension') -Recurse
$native = @{ name = 'com.agy_chrome_bridge'; description = 'AGY Chrome Bridge'; path = $bin; type = 'stdio'; allowed_origins = @('chrome-extension://deankghpcmnggohdfkoaggafbmjmkmlj/') }
[System.IO.File]::WriteAllText((Join-Path $stage 'host.json'), ($native | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
$configBackup = "$configPath.backup_agy_chrome_$stamp"
if (Test-Path $configPath) { Copy-Item -LiteralPath $configPath -Destination $configBackup }
$paths = @(
    @{ Target = $bin; Source = (Join-Path $stage 'agy-chrome-bridge.exe') },
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
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    $registryChanged = $true
    Set-Item -Path $regPath -Value $manifestPath
    $mcpStarted = $true
    & agy mcp add agy-chrome-bridge -- $bin --mcp
    if ($LASTEXITCODE -ne 0) { throw "AGY MCP registration failed with exit code $LASTEXITCODE" }
} catch {
    if ($mcpStarted) {
        if (Test-Path -LiteralPath $configBackup) { Copy-Item -LiteralPath $configBackup -Destination $configPath -Force }
        elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
    }
    if ($registryChanged) {
        if ($registryExisted) {
            if ($null -ne $existingRegistration) { Set-Item -Path $regPath -Value $existingRegistration }
            else { (Get-Item $regPath).DeleteValue('', $false) }
        } else { Remove-Item -LiteralPath $regPath }
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
Write-Output "Installed bridge: $bin"
Write-Output "Load unpacked extension in the selected Chrome profile: $installedExtension"
