# Reproducible preparation only: compile the worker and run pure Java unit tests.
# Never calls NodeDatabaseControl.main, extracts/loads RocksDB JNI, or creates a DB.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run=Join-Path $repo 'scratch/node-database-compile-test'
$bundle=Join-Path $repo 'scratch/node-startup/bundle'
$compiler=Join-Path $repo 'scratch/sync-preparation/ecj-3.37.0.jar'
$manifest=Join-Path $repo 'docs/ergo-node-startup-verification.json'
function Assert-CompileAncestors([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Nonordinary compilation directory ancestor' }
        }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
function Assert-CompileFile([string]$Path) {
    Assert-CompileAncestors ([IO.Path]::GetDirectoryName($Path))
    $item=Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected ordinary input file' }
}
if ($repo -cnotmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $run)) { throw 'Requires local repository and absent fixed compilation directory' }
foreach ($path in @($run,$bundle)) { Assert-CompileAncestors $path }
foreach ($path in @($compiler,$manifest)) { Assert-CompileFile $path }
$sourcePins=[ordered]@{}
foreach ($name in @('node-database-compile.test.ps1','NodeDatabaseControl.java','NodeDatabaseControlTest.java','NodeProbeProcess.cs','node-database-evidence.ps1')) {
    $path=Join-Path $PSScriptRoot $name
    Assert-CompileFile $path
    $sourcePins[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$pins=(Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json -AsHashtable).bundleManifest.files
if ($pins.Count -ne 167) { throw 'Unexpected pinned bundle file count' }
# Bounded manual traversal rejects redirection before visiting child directories.
$queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($bundle)
$count=0; $entries=0
while ($queue.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
        $entries++
        if ($entries -gt 256 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Bundle redirection or entry budget' }
        if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
        $relative=[IO.Path]::GetRelativePath($bundle,$item.FullName).Replace('\','/')
        if (-not $pins.ContainsKey($relative) -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ine $pins[$relative]) { throw 'Bundle pin mismatch or extra file' }
        $count++
    }
}
if ($count -ne 167) { throw 'Missing pinned bundle files' }
$compilerHash=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
if ($compilerHash -cne 'cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545') { throw 'Compiler pin mismatch' }
. (Join-Path $PSScriptRoot 'node-database-evidence.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
foreach ($path in @($run,"$run/tmp","$run/home","$run/classes")) { [void][IO.Directory]::CreateDirectory($path) }
$java=Join-Path $bundle 'jre/bin/java.exe'
$jar=Join-Path $bundle 'ergo-6.1.5.jar'
$jvm=@('-Xms32m','-Xmx256m',"-Djava.io.tmpdir=$run/tmp","-Duser.home=$run/home",
    '-XX:-UsePerfData','-XX:-CreateCoredumpOnCrash',"-XX:ErrorFile=$run/hs_err.log")
$compileArgs=$jvm+@('-jar',$compiler,'-proc:none','-encoding','UTF-8','-source','8','-target','8',
    '-cp',$jar,'-d',"$run/classes",(Join-Path $PSScriptRoot 'NodeDatabaseControl.java'),(Join-Path $PSScriptRoot 'NodeDatabaseControlTest.java'))
$compile=[NodeProbeProcess]::Run($java,$compileArgs,$run,'compile-database-control',1073741824UL,30000,65536,$null)
Assert-DatabaseProcess $compile
if ($compile.Output.Length -ne 0) { throw 'Compiler warnings or unexpected output' }
$testArgs=$jvm+@('-cp',("$run/classes;"+$jar),'NodeDatabaseControlTest')
$test=[NodeProbeProcess]::Run($java,$testArgs,$run,'database-status-and-write-roots-unit',1073741824UL,30000,65536,$null)
Assert-DatabaseProcess $test
$observed=$test.Output | ConvertFrom-Json -AsHashtable
if ($observed.Count -ne 3 -or $observed.status -cne 'passed' -or $observed.cases -ne 18 -or $observed.test -cne 'status-write-roots-and-jni-names') { throw 'Unexpected pure Java unit evidence' }
$classPins=[ordered]@{}
foreach ($name in @('NodeDatabaseControl.class','NodeDatabaseControlTest.class')) {
    $path=Join-Path $run "classes/$name"
    Assert-CompileFile $path
    if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'Compiled class size bound' }
    $classPins[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
# Only the two generated classes may remain. No broad recursive read is needed.
if (@(Get-ChildItem -LiteralPath "$run/classes" -Force).Count -ne 2 -or
    @(Get-ChildItem -LiteralPath "$run/tmp" -Force).Count -ne 0 -or
    @(Get-ChildItem -LiteralPath "$run/home" -Force).Count -ne 0 -or
    @(Get-ChildItem -LiteralPath $run -Force).Count -ne 3) { throw 'Unexpected compiler/unit-test residue' }
[ordered]@{
    status='database-worker-compiled-pure-java-tests-passed'; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    runPath=$run; bundleFilesVerified=$count; bundleManifestSha256=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant();
    bundlePins=$pins; compilerSha256=$compilerHash; sourcePins=$sourcePins; classPins=$classPins;
    compileArguments=$compileArgs; compile=$compile; testArguments=$testArgs; test=$test; observations=$observed;
    limitations=@('Compilation and 18 pure Java status/path/filename checks only; worker main and JNI/database work are not executed.',
        'Two sequential JVMs, each 30 seconds / 1 GiB commit / 25% CPU / one process / 64 KiB captured output.',
        'Script-owned output is limited to two classes under the fresh fixed scratch directory; host supervisor/JRE/OS activity is not a filesystem sandbox.',
        'Trusted stable host administration and source/input paths assumed. This does not demonstrate VHD mapping, module identity, disk-full behavior or traffic containment.')
} | ConvertTo-Json -Depth 12
