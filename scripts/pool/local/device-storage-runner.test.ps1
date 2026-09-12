# Exercise script invocation and LASTEXITCODE propagation as used by hosted CI.
$ErrorActionPreference = 'Stop'
$pwsh = (Get-Process -Id $PID).Path
$suite = Join-Path $PSScriptRoot 'device-storage.test.ps1'
$quotedSuite = "'" + $suite.Replace("'", "''") + "'"
$command = '$ErrorActionPreference = ''Stop''; & ' + $quotedSuite +
    '; if (Test-Path -LiteralPath variable:\LASTEXITCODE) { exit $LASTEXITCODE }'
$output = & $pwsh -NoProfile -Command $command 2>&1
$suiteExit = $LASTEXITCODE
if ($suiteExit -ne 0) { throw "Device storage suite failed under CI invocation (exit $suiteExit): $($output -join [Environment]::NewLine)" }
if (($output -join "`n") -notmatch 'Device storage checks passed \([0-9]+ assertions;') {
    throw 'Device storage suite did not report completed assertions'
}
$output | Write-Output
Write-Output 'Device storage CI invocation passed (exit 0 after expected CLI refusal).'
exit 0
