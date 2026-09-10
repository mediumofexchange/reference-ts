# Internal fixed worker. Launch only through node-disk-control.ps1's Job Object.
param([Parameter(Mandatory)][string]$Volume)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess -or
    $Volume -cnotmatch '^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\z') {
    throw 'Expected Windows x64 and exact volume GUID'
}
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeDisk.cs')
[NodeProbeDisk]::Fill($Volume + '\') | ConvertTo-Json -Compress
