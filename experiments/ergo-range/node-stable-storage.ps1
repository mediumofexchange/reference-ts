# Small stock-store operational test, not a disk-full, crash or sync qualification.
# Requires the separately inspected complete stable bundle; installs nothing.
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 PowerShell 7 required' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repo 'scratch/ergo-stable/bundle'
$run = Join-Path $repo 'scratch/ergo-stable/storage-run'
$source = Join-Path $PSScriptRoot 'NodeStableStorage.java'
$compiler = Join-Path $repo 'scratch/sync-preparation/ecj-3.37.0.jar'
$jar = Join-Path $bundle 'ergo-6.0.5.jar'
foreach ($path in @($repo,(Join-Path $repo 'scratch'),(Join-Path $repo 'scratch/ergo-stable'),$bundle,(Join-Path $bundle 'jre'))) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse root refused' }
}
if (Test-Path -LiteralPath $run) { throw 'Fresh run directory required' }
if ((Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash -ine '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588' -or
    (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash -ine 'cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545') { throw 'JAR/compiler pin mismatch' }
# Every bundled JRE file equals the previously measured stock Java 21.0.1 bundle.
$prior = (Get-Content -Raw (Join-Path $repo 'docs/ergo-node-startup-verification.json') | ConvertFrom-Json -AsHashtable).bundleManifest.files
$jreFiles = @($prior.GetEnumerator() | Where-Object { $_.Key.StartsWith('jre/') })
$actual = @(Get-ChildItem -LiteralPath (Join-Path $bundle 'jre') -Recurse -Force)
if (@($actual | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0 -or
    @($actual | Where-Object { -not $_.PSIsContainer }).Count -ne $jreFiles.Count) { throw 'JRE member mismatch' }
foreach ($entry in $jreFiles) {
    if ((Get-FileHash -LiteralPath (Join-Path $bundle $entry.Key) -Algorithm SHA256).Hash -ine $entry.Value) { throw 'JRE hash mismatch' }
}
if (-not $Execute) {
    [ordered]@{ status='prepared'; jarSha256='2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588';
        jreFiles=$jreFiles.Count; executed=$false } | ConvertTo-Json
    exit 0
}
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
foreach ($directory in @($run,"$run/data","$run/classes","$run/home","$run/tmp")) { New-Item -ItemType Directory -Path $directory | Out-Null }
[IO.File]::WriteAllText("$run/logback.xml",'<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%level %msg%n</pattern></encoder></appender><root level="INFO"><appender-ref ref="STDOUT"/></root></configuration>')
$java = Join-Path $bundle 'jre/bin/java.exe'
$jvm = @('-Xms32m','-Xmx256m',"-Duser.home=$run/home","-Djava.io.tmpdir=$run/tmp",
    "-Dlogback.configurationFile=$run/logback.xml","-XX:ErrorFile=$run/hs_err.log",'-XX:-CreateCoredumpOnCrash','-XX:-UsePerfData')
$results = [ordered]@{}
$socketSamples = 0
$observe = [Func[uint32,long,bool]] {
    param($childId,$capturedOutputBytes)
    $script:socketSamples++
    if (@([NodeProbeProcess]::Sockets($childId)).Count -ne 0) { throw 'Unexpected socket' }
    $files = @(Get-ChildItem -LiteralPath $run -Recurse -Force)
    if ($files.Count -gt 1024 -or @($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0 -or
        ($files | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum -gt 16777216) { throw 'Observed run budget exceeded' }
    return $false
}
foreach ($mode in @('compile','write','rollback','verify')) {
    $arguments = if ($mode -eq 'compile') {
        $jvm + @('-jar',$compiler,'-proc:none','-encoding','UTF-8','-source','8','-target','8','-classpath',$jar,'-d',"$run/classes",$source)
    } else {
        $jvm + @('-cp',"$run/classes;$jar",'NodeStableStorage',$mode,"$run/data")
    }
    $result = [NodeProbeProcess]::Run($java,$arguments,$run,$mode,1073741824UL,30000,65536,$observe)
    $results[$mode] = $result
    $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$run/processes.json"
    if ($result.Outcome -ne 'exited' -or $result.ExitCode -ne 0 -or -not $result.JobEmptyAfterCleanup -or
        -not $result.LimitsReadBackBeforeResume -or $result.TotalProcesses -ne 1 -or
        $result.CpuRateFlags -ne 5 -or $result.CpuRatePer10000 -ne 2500 -or $result.PeakCommitBytes -gt 1073741824UL) {
        throw "Stock storage process refused ($mode): $($result.Output)"
    }
    if ($mode -ne 'compile' -and @($result.Output -split '\r?\n' | Where-Object {
        $_ -ceq "MOE_STABLE_STORAGE=${mode}:passed;engine=org.fusesource.leveldbjni.JniDBFactory"
    }).Count -ne 1) { throw 'Missing exact worker result' }
}
$finalFiles = @(Get-ChildItem -LiteralPath $run -Recurse -Force -File)
$bytes = ($finalFiles | Measure-Object Length -Sum).Sum
if ($finalFiles.Count -gt 1024 -or $bytes -gt 16777216) { throw 'Final run budget exceeded' }
[ordered]@{ status='stock-versioned-store-operational-only'; jarSha256=(Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant();
    workerSha256=(Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant();
    launcherSha256=(Get-FileHash $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();
    supervisorSha256=(Get-FileHash (Join-Path $PSScriptRoot 'NodeProbeProcess.cs') -Algorithm SHA256).Hash.ToLowerInvariant();
    javaVersion='21.0.1'; socketSamples=$socketSamples; files=$finalFiles.Count; bytes=$bytes; processes=$results;
    limits='Four sequential processes; each 30 seconds, 1 GiB commit, 25% CPU scheduling, 64 KiB output. 16 MiB observed file threshold; no hard disk/network sandbox.';
    limitations='Normal close/reopen and known/unknown rollback only. Factory selection is observed, loaded DLL identity is not hashed. Synchronous observer calls can delay the nominal wall deadline. No power-loss/crash/disk-full/compaction stress, sync, native ABI proof or product recovery acceptance.'
} | ConvertTo-Json -Depth 10
