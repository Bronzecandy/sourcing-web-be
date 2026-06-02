# Tao DB app local tren PostgreSQL Windows (khong Docker).
# Chay tu thu muc be: npm run setup:app-db:windows

param(
  [string]$PostgresUser = "postgres",
  [string]$DbHost = "localhost",
  [int]$Port = 5432
)

$ErrorActionPreference = "Stop"
$sqlRole = Join-Path $PSScriptRoot "setup-app-db-windows.sql"

function Find-Psql {
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @(
    ${env:ProgramFiles},
    ${env:ProgramFiles(x86)}
  ) | Where-Object { $_ }

  foreach ($root in $roots) {
    $pgRoot = Join-Path $root "PostgreSQL"
    if (-not (Test-Path $pgRoot)) { continue }
    $bins = @(Get-ChildItem -Path $pgRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "bin\psql.exe" } |
      Where-Object { Test-Path $_ })
    if ($bins.Count -gt 0) { return $bins[0] }
  }
  return $null
}

$psqlRaw = Find-Psql
if (-not $psqlRaw) {
  Write-Host "Khong tim thay psql." -ForegroundColor Yellow
  Write-Host "PostgreSQL 18 thuong o:" -ForegroundColor Yellow
  Write-Host "  C:\Program Files\PostgreSQL\18\bin" -ForegroundColor Gray
  Write-Host ""
  Write-Host "Them thu muc bin vao PATH (User), mo PowerShell moi, hoac chay:" -ForegroundColor Yellow
  Write-Host '  $env:Path += ";C:\Program Files\PostgreSQL\18\bin"' -ForegroundColor White
  Write-Host "Chi tiet: docs/auth-local-setup-windows-postgres.md" -ForegroundColor Yellow
  exit 1
}

Write-Host "Dung psql: $psqlRaw" -ForegroundColor DarkGray

Write-Host "Nhap mat khau PostgreSQL superuser ($PostgresUser)..." -ForegroundColor Cyan
$secure = Read-Host "Password" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
$env:PGPASSWORD = $plain

function Invoke-Psql {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & "$psqlRaw" @Args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Tao role sourcing..." -ForegroundColor Cyan
Invoke-Psql -f $sqlRole -h $DbHost -p $Port -U $PostgresUser
Invoke-Psql -c "ALTER ROLE sourcing CREATEDB" -h $DbHost -p $Port -U $PostgresUser

Write-Host "Kiem tra database sourcing_app_local..." -ForegroundColor Cyan
$existsOut = & "$psqlRaw" -h $DbHost -p $Port -U $PostgresUser -tAc "SELECT 1 FROM pg_database WHERE datname='sourcing_app_local'" 2>&1
$existsCode = $LASTEXITCODE
$existsStr = if ($null -eq $existsOut) { "" } else { ("$existsOut").Trim() }

if ($existsCode -ne 0) {
  Write-Host "Loi khi kiem tra database (exit $existsCode):" -ForegroundColor Red
  Write-Host $existsOut -ForegroundColor Red
  exit $existsCode
}

if ($existsStr -ne "1") {
  Write-Host "Tao database sourcing_app_local..." -ForegroundColor Cyan
  Invoke-Psql -c "CREATE DATABASE sourcing_app_local OWNER sourcing" -h $DbHost -p $Port -U $PostgresUser
} else {
  Write-Host "Database sourcing_app_local da ton tai, bo qua." -ForegroundColor Yellow
}

Write-Host "Cap quyen schema..." -ForegroundColor Cyan
Invoke-Psql -d sourcing_app_local -c "GRANT ALL ON SCHEMA public TO sourcing; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sourcing; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO sourcing;" -h $DbHost -p $Port -U $PostgresUser

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "OK. DATABASE_URL_APP trong .env (port $Port)." -ForegroundColor Green
Write-Host "Tiep theo:" -ForegroundColor Cyan
Write-Host "  npm run prisma:migrate:app" -ForegroundColor White
Write-Host "  npm run seed:app" -ForegroundColor White
Write-Host "  npm run dev" -ForegroundColor White
