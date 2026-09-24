param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

function Convert-ToPlainText([Security.SecureString]$Secure) {
  if (-not $Secure) { return "" }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

Write-Host ""
Write-Host "=== Token Dedupe Migration ==="
$modeLabel = if ($Apply) { "APPLY (writes to DB)" } else { "DRY-RUN (no writes)" }
Write-Host "Mode: $modeLabel"
Write-Host ""

$defaultHost = "androidaccountapp.berliex.mongodb.net"
$defaultDb = "Accounts-Android-App"

$hostInput = Read-Host "Atlas host [$defaultHost]"
if ([string]::IsNullOrWhiteSpace($hostInput)) { $hostInput = $defaultHost }

$dbInput = Read-Host "Database name [$defaultDb]"
if ([string]::IsNullOrWhiteSpace($dbInput)) { $dbInput = $defaultDb }

$username = Read-Host "Database username"
if ([string]::IsNullOrWhiteSpace($username)) {
  throw "Database username is required."
}

$securePass = Read-Host "Database password" -AsSecureString
$plainPass = Convert-ToPlainText $securePass
if ([string]::IsNullOrWhiteSpace($plainPass)) {
  throw "Database password is required."
}

$encUser = [uri]::EscapeDataString($username)
$encPass = [uri]::EscapeDataString($plainPass)
$args = @("scripts/token-dedupe-migration.js")
if ($Apply) { $args += "--apply" }

function Invoke-Migration([string]$MongoUri) {
  $env:MONGODB_URI = $MongoUri
  $output = node @args 2>&1
  $output | ForEach-Object { Write-Host $_ }
  return [PSCustomObject]@{
    ExitCode = $LASTEXITCODE
    Output = ($output -join "`n")
  }
}

$isDirectSeedMode = $hostInput.Contains(",") -or $hostInput.Contains(":")
$mongoUriSrv = "mongodb+srv://$encUser`:$encPass@$hostInput/$dbInput?retryWrites=true&w=majority&appName=AndroidAccountApp&serverSelectionTimeoutMS=15000&connectTimeoutMS=15000&socketTimeoutMS=30000"

Write-Host ""
if ($isDirectSeedMode) {
  Write-Host "Running migration (direct seed-list mode)..."
  $mongoUriSeedDirect = "mongodb://$encUser`:$encPass@$hostInput/$dbInput?tls=true&authSource=admin&retryWrites=true&w=majority&appName=AndroidAccountApp&serverSelectionTimeoutMS=15000&connectTimeoutMS=15000&socketTimeoutMS=30000"
  $result = Invoke-Migration -MongoUri $mongoUriSeedDirect
  $exitCode = $result.ExitCode
} else {
  Write-Host "Running migration (SRV mode)..."
  $result = Invoke-Migration -MongoUri $mongoUriSrv
  $exitCode = $result.ExitCode
}

if ($exitCode -ne 0 -and $result.Output -match "querySrv ECONNREFUSED") {
  Write-Host ""
  Write-Host "SRV lookup failed. Trying seed-list fallback..."
  try {
    $srvRecords = Resolve-DnsName "_mongodb._tcp.$hostInput" -Type SRV -ErrorAction Stop |
      Where-Object { $_.Type -eq "SRV" -and $_.NameTarget }

    if (-not $srvRecords -or $srvRecords.Count -eq 0) {
      throw "No SRV records found for host."
    }

    $seedList = ($srvRecords | ForEach-Object {
      "$($_.NameTarget.TrimEnd('.')):$($_.Port)"
    }) -join ","

    $mongoUriSeed = "mongodb://$encUser`:$encPass@$seedList/$dbInput?tls=true&authSource=admin&retryWrites=true&w=majority&appName=AndroidAccountApp&serverSelectionTimeoutMS=15000&connectTimeoutMS=15000&socketTimeoutMS=30000"
    $result = Invoke-Migration -MongoUri $mongoUriSeed
    $exitCode = $result.ExitCode
  } catch {
    Write-Host "Seed-list fallback preparation failed: $($_.Exception.Message)"
    $exitCode = 1
  }
}

if ($exitCode -ne 0) {
  throw "Migration failed with exit code $exitCode"
}

Write-Host ""
Write-Host "Migration finished successfully."
