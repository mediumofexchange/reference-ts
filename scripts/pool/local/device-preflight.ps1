# Partial read-only observation; never changes device configuration.
param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/device-storage.ps1"
try { $report = Get-DeviceStorageReport -Directory $Directory }
catch { $report = New-DeviceStorageReport @([pscustomobject]@{ id = 'observation'; status = 'unknown' }) }
$report | ConvertTo-Json -Depth 5 -Compress
switch ($report.automaticChecks) {
    'pass' { exit 0 } # Only automatic observations passed; qualified is still false.
    'fail' { exit 2 }
    default { exit 3 }
}
