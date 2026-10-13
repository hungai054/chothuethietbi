# Chay server dev:  .\scripts\dev.ps1 web   hoac   .\scripts\dev.ps1 admin
# Nap lai PATH tu Windows (terminal mo truoc khi cai pnpm se thieu thu muc npm) roi chay pnpm.cmd
# (dung .cmd vi PowerShell mac dinh chan script .ps1).
param([Parameter(Mandatory = $true)][ValidateSet('web', 'admin')][string]$App)

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
  Write-Host 'Khong tim thay pnpm. Cai bang: npm.cmd install -g pnpm' -ForegroundColor Red
  exit 1
}
Write-Host "Dang chay $App (Ctrl+C de dung)" -ForegroundColor Green
pnpm.cmd "dev:$App"
