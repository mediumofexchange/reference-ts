# Fixed path syntax probe. No disk image, mounted-volume access, RocksDB or node.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repo 'scratch/node-startup/bundle'
$compiler = Join-Path $repo 'scratch/sync-preparation/ecj-3.37.0.jar'
$run = Join-Path $repo 'scratch/node-volume-path'
if (Test-Path -LiteralPath $run) { throw 'Requires an absent path-probe directory' }
$pins = (Get-Content -Raw (Join-Path $repo 'docs/ergo-node-startup-verification.json') | ConvertFrom-Json -AsHashtable).bundleManifest.files
foreach ($entry in $pins.GetEnumerator()) {
    if ((Get-FileHash -LiteralPath (Join-Path $bundle $entry.Key) -Algorithm SHA256).Hash -ine $entry.Value) { throw 'Bundle pin mismatch' }
}
$compilerHash = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
if ($compilerHash -cne 'cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545') { throw 'Compiler pin mismatch' }
foreach ($path in @($run,"$run/tmp","$run/home","$run/classes")) { New-Item -ItemType Directory -Path $path | Out-Null }
$java = Join-Path $bundle 'jre/bin/java.exe'
$jvm = @('-Xms32m','-Xmx256m',"-Djava.io.tmpdir=$run/tmp","-Duser.home=$run/home",
    '-XX:-UsePerfData','-XX:-CreateCoredumpOnCrash',"-XX:ErrorFile=$run/hs_err.log")
function Assert-PathProbeProcess($Result) {
    if ($Result.Outcome -cne 'exited' -or $Result.ExitCode -ne 0 -or
        -not $Result.LimitsReadBackBeforeResume -or -not $Result.JobEmptyAfterCleanup -or
        $Result.TotalProcesses -ne 1 -or $Result.MaxSampledAssociatedProcesses -ne 1 -or
        $Result.CommitLimitBytes -ne 1073741824UL -or $Result.PeakCommitBytes -gt 1073741824UL -or
        $Result.CpuRateFlags -ne 5 -or $Result.CpuRatePer10000 -ne 2500 -or
        $Result.ElapsedMs -gt 30000 -or $Result.CapturedOutputBytes -gt 65536) {
        throw "Path probe process refused: $($Result.Output)"
    }
}
$compileArgs = $jvm + @('-jar',$compiler,'-proc:none','-encoding','UTF-8','-source','8','-target','8',
    '-d',"$run/classes",(Join-Path $PSScriptRoot 'NodeVolumePathCheck.java'))
$compile = [NodeProbeProcess]::Run($java,$compileArgs,$run,'compile-path-probe',1073741824UL,30000,65536,$null)
Assert-PathProbeProcess $compile
$arguments = $jvm + @('-cp',"$run/classes",'NodeVolumePathCheck')
$result = [NodeProbeProcess]::Run($java,$arguments,$run,'jre-path-syntax',1073741824UL,30000,65536,$null)
Assert-PathProbeProcess $result
$observed = $result.Output | ConvertFrom-Json -AsHashtable
if ($observed.javaVersion -cne '21.0.1' -or $observed.cases.Count -ne 5) { throw 'Unexpected JRE or specimen count' }
$names = @('volume-guid-root','volume-guid-child','drive-child','extended-drive-child','extended-unc-child')
for ($i=0; $i -lt $names.Count; $i++) {
    $case = $observed.cases[$i]
    if ($case.name -cne $names[$i]) { throw 'Specimen order changed' }
    if ($i -lt 2) {
        if ($case.nioError -cne 'Long path prefix can only be used with an absolute path' -or
            $case.fileToPathError -cne $case.nioError -or $null -ne $case.nioPath -or $null -ne $case.fileToPath) {
            throw 'Expected volume GUID syntax refusal was not reproduced'
        }
    } elseif ($null -ne $case.nioError -or $null -ne $case.fileToPathError -or
        -not $case.nioAbsolute -or $case.fileToPath -cne $case.nioPath) { throw 'Ordinary absolute path control failed' }
}
$files = @(Get-ChildItem -LiteralPath $run -Recurse -File)
if ($files.Count -ne 1 -or $files[0].Name -cne 'NodeVolumePathCheck.class' -or $files[0].Length -gt 65536) { throw 'Unexpected final probe files' }
$hashes = [ordered]@{}
foreach ($file in @('NodeVolumePathCheck.java','node-volume-path.ps1','NodeProbeProcess.cs')) {
    $hashes[$file]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
[ordered]@{ status='jre-volume-guid-nio-refusal'; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    javaSha256=$pins['jre/bin/java.exe']; jreModulesSha256=$pins['jre/lib/modules']; compilerSha256=$compilerHash;
    compile=$compile; compileArguments=$compileArgs; process=$result; arguments=$arguments; observations=$observed;
    generatedClassSha256=(Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant();
    finalRunBytes=$files[0].Length; files=$hashes;
    limitations=@('Syntax-only Path/File.toPath observations for fixed non-existent specimens; no stat, open, canonicalization or network lookup of those specimens.',
        'Neither RocksDB nor Ergo classes are on the worker classpath. No disk is created, attached, mapped, written or detached by this probe.',
        'Drive and UNC syntax acceptance does not prove file access, local-volume ownership, JNI compatibility or a mounted-volume control.',
        'Two sequential JVMs, each 30 s / 1 GiB commit / 25% CPU / one process / 64 KiB output; no filesystem sandbox.') } | ConvertTo-Json -Depth 12
