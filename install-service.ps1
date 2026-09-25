#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the Kaseya MDR (formerly RocketCyber) MCP server as a Windows service.

.DESCRIPTION
  Same pattern as the other SCC MCP servers (UniFi, UISP, Avanan, ConnectWise PSA, Datto RMM/EDR, SaaS-Alerts):
  - Checks Node.js (20.18.1+, installed for all users), runs npm ci + build
  - Creates .env from .env.suffolk.example on first run (with a generated MCP_BEARER_TOKEN)
  - Restricts .env to Administrators + SYSTEM (it holds the Kaseya MDR / RocketCyber API key)
  - Tests the Kaseya MDR connection (rocketcyber_get_account on a temporary local port)
  - Installs a Windows service (Automatic, delayed start, LocalSystem, restarts on failure)
    using WinSW (https://github.com/winsw/winsw). WinSW is downloaded from GitHub on
    first run; for an offline server, put WinSW-x64.exe in this folder first.
  - Optionally opens the Windows Firewall port for specific remote addresses
  - Confirms the endpoint rejects requests without the token

.EXAMPLE
  .\install-service.ps1
.EXAMPLE
  .\install-service.ps1 -OpenFirewall -RemoteAddress 192.168.97.10
.EXAMPLE
  .\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $PSScriptRoot,
    [string]$ServiceName = "SCC-KaseyaMDRClaudeMCP",
    [string]$WinSWVersion = "2.12.0",
    [switch]$OpenFirewall,
    [string[]]$RemoteAddress = @(),
    [switch]$SkipBuild,
    [switch]$SkipCheck,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-Location $InstallDir
$envFile    = Join-Path $InstallDir ".env"
$envExample = Join-Path $InstallDir ".env.suffolk.example"
$entry      = Join-Path $InstallDir "dist\entry.js"
$fwRule     = "$ServiceName (TCP-In)"
$svcExe     = Join-Path $InstallDir "$ServiceName.exe"
$svcXml     = Join-Path $InstallDir "$ServiceName.xml"
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

function Remove-Svc {
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        if (Test-Path $svcExe) { & $svcExe uninstall | Out-Null } else { sc.exe delete $ServiceName | Out-Null }
        Start-Sleep -Seconds 2
    }
}

function Get-EnvValue([string]$name, [string]$default = "") {
    if (-not (Test-Path $envFile)) { return $default }
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if (-not $line) { return $default }
    $v = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
    if ($v) { $v } else { $default }
}

function Invoke-Mcp([string]$url, [string]$token, [string]$method, [hashtable]$params = @{}) {
    $headers = @{ Accept = "application/json, text/event-stream" }
    if ($token) { $headers.Authorization = "Bearer $token" }
    $body = @{ jsonrpc = "2.0"; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 60
}

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
    Remove-Svc
    Get-NetFirewallRule -DisplayName $fwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host "Uninstalled service '$ServiceName'. Files in $InstallDir were left in place."
    return
}

# ---------------------------------------------------------------------- node
Write-Host "== Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js not found. Install Node.js LTS for all users (winget install OpenJS.NodeJS.LTS), open a new PowerShell, and re-run."
}
$node = $nodeCmd.Source
$nodeVer = [version]((& $node -v).TrimStart("v"))
if ($nodeVer -lt [version]"20.18.1") { throw "Node.js $nodeVer is too old; 20.18.1 or later is required." }
if ($node -like "$env:SystemDrive\Users\*") {
    Write-Warning "Node is installed per-user ($node). The service runs as SYSTEM; install Node for all users instead."
}
Write-Host "   using $node ($nodeVer)"

# --------------------------------------------------------------------- build
if (-not $SkipBuild) {
    # stop the running service so npm ci can replace node_modules
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Stop-Service -Name $ServiceName -Force }
    Write-Host "== Installing packages and building"
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
if (-not (Test-Path $entry)) { throw "$entry not found; run without -SkipBuild." }

# ---------------------------------------------------------------------- .env
if (-not (Test-Path $envFile)) {
    Write-Host "== Creating .env from .env.suffolk.example"
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $content = (Get-Content $envExample) -replace "^MCP_BEARER_TOKEN=.*$", "MCP_BEARER_TOKEN=$token"
    # No BOM: node --env-file reads the file as-is
    [System.IO.File]::WriteAllLines($envFile, $content, $utf8NoBom)
}

# Lock .env down: it contains the RocketCyber API key and the MCP token.
icacls $envFile /inheritance:r /grant:r "*S-1-5-32-544:(F)" "*S-1-5-18:(F)" | Out-Null

$required = "ROCKETCYBER_API_KEY"
$missing = $required | Where-Object { -not (Get-EnvValue $_) }
if ($missing) {
    Write-Warning "Edit $envFile ($($missing -join ', ')), save, then re-run this script."
    notepad $envFile
    return
}
$token = Get-EnvValue "MCP_BEARER_TOKEN"
if (-not $token) { throw "MCP_BEARER_TOKEN is empty in $envFile. Set a long random value and re-run." }
if ((Get-EnvValue "MCP_TRANSPORT") -ne "http") { throw "MCP_TRANSPORT must be http in $envFile (otherwise the server starts in stdio mode and exits)." }

# ---------------------------------------------------------------------- check
if (-not $SkipCheck) {
    Write-Host "== Testing Kaseya MDR connection"
    $checkPort = 18772
    # --env-file does not override variables already set, so these win for the test run
    $env:MCP_HTTP_HOST = "127.0.0.1"; $env:MCP_HTTP_PORT = "$checkPort"
    $proc = Start-Process -FilePath $node -ArgumentList "--env-file=`"$envFile`"", "`"$entry`"" `
        -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    Remove-Item Env:MCP_HTTP_HOST, Env:MCP_HTTP_PORT
    try {
        # Wait for the server to come up (first start can be slow while Defender scans node_modules)
        $up = $false
        for ($i = 0; $i -lt 30 -and -not $up -and -not $proc.HasExited; $i++) {
            Start-Sleep -Seconds 1
            try { Invoke-RestMethod "http://127.0.0.1:$checkPort/health" -TimeoutSec 2 | Out-Null; $up = $true } catch {}
        }
        if ($proc.HasExited) { throw "Server exited during startup (code $($proc.ExitCode)). Run: node --env-file=.env dist\entry.js" }
        if (-not $up) { throw "Server did not answer on port $checkPort within 30 seconds." }
        $r = Invoke-Mcp "http://127.0.0.1:$checkPort/mcp" $token "tools/call" @{ name = "rocketcyber_get_account"; arguments = @{} }
        $text = $r.result.content[0].text
        if ($r.result.isError) { throw "Kaseya MDR check FAILED: $text (check ROCKETCYBER_API_KEY / ROCKETCYBER_REGION)" }
        $acct = try { ($text | ConvertFrom-Json).data } catch { $null }
        $name = if ($acct.accountName) { "$($acct.accountName) (id $($acct.id))" } else { "account info" }
        Write-Host "   OK: Kaseya MDR returned $name"
    } finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    }
}

# -------------------------------------------------------------------- service
Write-Host "== Installing Windows service '$ServiceName'"
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "logs") | Out-Null

if (-not (Test-Path $svcExe)) {
    $local = Join-Path $InstallDir "WinSW-x64.exe"
    if (Test-Path $local) {
        Copy-Item $local $svcExe
    } else {
        $url = "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe"
        Write-Host "   downloading WinSW $WinSWVersion"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $svcExe -UseBasicParsing
    }
    Write-Host "   WinSW SHA256: $((Get-FileHash $svcExe -Algorithm SHA256).Hash)"
}

$xml = @"
<service>
  <id>$ServiceName</id>
  <name>$ServiceName</name>
  <description>Kaseya MDR (formerly RocketCyber) MCP server for Claude. $InstallDir</description>
  <executable>$node</executable>
  <arguments>--env-file="$envFile" "$entry"</arguments>
  <workingdirectory>$InstallDir</workingdirectory>
  <startmode>Automatic</startmode>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$InstallDir\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>5120</sizeThreshold>
    <keepFiles>3</keepFiles>
  </log>
</service>
"@
[System.IO.File]::WriteAllText($svcXml, $xml, $utf8NoBom)

Remove-Svc
& $svcExe install
if ($LASTEXITCODE -ne 0) { throw "Service install failed" }
sc.exe config $ServiceName start= delayed-auto | Out-Null
Start-Service -Name $ServiceName
Write-Host "   service status: $((Get-Service $ServiceName).Status)"

# ------------------------------------------------------------------ firewall
$mcpHost = Get-EnvValue "MCP_HTTP_HOST" "0.0.0.0"
$mcpPort = [int](Get-EnvValue "MCP_HTTP_PORT" "8772")
if ($OpenFirewall) {
    if ($mcpHost -in @("127.0.0.1", "localhost", "::1")) {
        Write-Warning "MCP_HTTP_HOST is $mcpHost (loopback only), so no firewall rule is needed."
    } else {
        Get-NetFirewallRule -DisplayName $fwRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        $fwArgs = @{ DisplayName = $fwRule; Direction = "Inbound"; Protocol = "TCP";
                     LocalPort = $mcpPort; Action = "Allow"; Profile = "Domain,Private" }
        if ($RemoteAddress.Count) { $fwArgs.RemoteAddress = $RemoteAddress }
        else { Write-Warning "No -RemoteAddress given; the port is open to the whole Domain/Private network." }
        New-NetFirewallRule @fwArgs | Out-Null
        Write-Host "   firewall: TCP $mcpPort allowed from $(if ($RemoteAddress.Count) { $RemoteAddress -join ', ' } else { 'any (Domain/Private)' })"
    }
}

# ---------------------------------------------------------------- verify up
$probeHost = if ($mcpHost -in @("0.0.0.0", "::")) { "127.0.0.1" } else { $mcpHost }
$probe = "http://${probeHost}:$mcpPort/mcp"
for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-RestMethod "http://${probeHost}:$mcpPort/health" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}
try {
    Invoke-Mcp $probe "" "tools/list" | Out-Null
    Write-Warning "Endpoint answered without a token. That should not happen; check MCP_BEARER_TOKEN."
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        $n = (Invoke-Mcp $probe $token "tools/list").result.tools.Count
        Write-Host "== Running: $probe (rejects requests without the token; $n tools with it)"
    } else {
        Write-Warning "Could not confirm the server is up ($($_.Exception.Message)). See $InstallDir\logs"
    }
}
Write-Host ""
Write-Host "Bearer token is MCP_BEARER_TOKEN in $envFile"
Write-Host "Manage:  Restart-Service $ServiceName   (or services.msc)"
Write-Host "Logs:    Get-Content '$InstallDir\logs\$ServiceName.err.log' -Tail 50 -Wait"
