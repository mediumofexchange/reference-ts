# Manual, public standard-runner compilation only. Never loads the output DLL.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$report = [ordered]@{status='refused'; phase='host'; candidateLoaded=$false; databaseAcceptance=$false; errors=@()}
$watch = [Diagnostics.Stopwatch]::StartNew()
function FileRecord([string]$path) {
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected ordinary file' }
    return [ordered]@{name=$item.Name; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}
}
function Run([string]$tool, [string[]]$arguments) {
    & $tool @arguments
    if ($LASTEXITCODE -ne 0) { throw "Tool failed with exit $LASTEXITCODE : $tool" }
}
try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or
        $env:GITHUB_REPOSITORY -cne 'mediumofexchange/reference-ts' -or
        $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cne 'refs/heads/main') {
        throw 'Only the fixed manual public Windows CI job is supported'
    }
    $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    if ($event.repository.private -ne $false) { throw 'Public repository required' }
    $pins = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'native-build-inputs.json') | ConvertFrom-Json
    $report.imageVersion = $env:ImageVersion
    $report.workflowCommit = $env:GITHUB_SHA
    $report.runId = $env:GITHUB_RUN_ID
    $image = @($pins.images | Where-Object { $_.version -ceq $env:ImageVersion })
    if ($image.Count -ne 1) { throw 'Runner image differs from reviewed inputs' }
    $report.imageSourceCommit = $image[0].sourceCommit
    $report.imageManifestSha256 = $image[0].manifestSha256
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ($repo -cne [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)) { throw 'Unexpected workspace' }
    $root = Join-Path $repo 'scratch/native-build'
    $source = Join-Path $root 'source'
    $build = Join-Path $root 'build'
    if (Test-Path -LiteralPath $build) { throw 'Build directory must be absent' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    $report.freeBefore = $drive.AvailableFreeSpace
    if ($report.freeBefore -lt 8GB) { throw 'At least 8 GiB free required' }

    $report.phase = 'inputs'
    $sourceHead = (& git -C $source rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceHead -cne $pins.sourceCommit) { throw 'Source commit mismatch' }
    Run -tool git -arguments @('-C',$source,'diff','--exit-code','HEAD','--')
    $report.sourceCommit = $sourceHead
    $report.sourceTree = (& git -C $source rev-parse 'HEAD^{tree}').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Source tree unavailable' }
    $javaHome = $env:JAVA_HOME_21_X64
    $javaRelease = Get-Content -Raw -LiteralPath (Join-Path $javaHome 'release')
    if ($javaRelease -notmatch ('(?m)^JAVA_VERSION="'+[regex]::Escape($pins.javaVersion)+'"')) { throw 'JDK version mismatch' }
    $env:JAVA_HOME = $javaHome
    $env:PATH = (Join-Path $javaHome 'bin') + ';' + $env:PATH
    $cmake = (Get-Command cmake).Source
    $cmakeVersion = (& $cmake --version)[0]
    if ($LASTEXITCODE -ne 0 -or $cmakeVersion -cne ('cmake version '+$pins.cmakeVersion)) { throw 'CMake version mismatch' }
    $vs = 'C:\Program Files\Microsoft Visual Studio\2022\Enterprise'
    $vcVersion = (Get-Content -Raw -LiteralPath (Join-Path $vs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')).Trim()
    if ($vcVersion -cnotmatch '^14\.44\.[0-9]+$') { throw 'Expected MSVC v143 14.44 toolset' }
    $vcRoot = Join-Path $vs ('VC/Tools/MSVC/'+$vcVersion)
    $vcBin = Join-Path $vcRoot 'bin/Hostx64/x64'
    $sdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
    $sdkVersion = $pins.windowsSdkVersion
    $report.toolset = $vcVersion
    $report.javaRelease = $javaRelease.Trim()
    $report.tools = @()
    foreach ($file in @($cmake,(Join-Path $javaHome 'bin/javac.exe'),(Join-Path $javaHome 'bin/jar.exe'),
        (Join-Path $javaHome 'include/jni.h'),(Join-Path $javaHome 'include/win32/jni_md.h'),
        (Join-Path $vcBin 'cl.exe'),(Join-Path $vcBin 'c1xx.dll'),(Join-Path $vcBin 'c2.dll'),
        (Join-Path $vcBin 'link.exe'),(Join-Path $vcBin 'dumpbin.exe'),
        (Join-Path $sdkRoot "bin/$sdkVersion/x64/rc.exe"),
        (Join-Path $sdkRoot "Lib/$sdkVersion/ucrt/x64/libucrt.lib"),
        (Join-Path $vcRoot 'lib/x64/libcmt.lib'))) { $report.tools += FileRecord $file }
    # This records selected tools/headers/libraries; it is not a complete OS or
    # transitive toolchain attestation. Output remains an unadopted candidate.
    $testLibs = Join-Path $source 'java/test-libs'
    New-Item -ItemType Directory -Force -Path $testLibs | Out-Null
    $report.dependencies = @()
    foreach ($dep in $pins.dependencies) {
        $dest = Join-Path $testLibs $dep.file
        if (Test-Path -LiteralPath $dest) { throw 'Unexpected existing build dependency' }
        Invoke-WebRequest -Uri ('https://repo.maven.apache.org/maven2/'+$dep.path) -OutFile $dest -TimeoutSec 60
        $record = FileRecord $dest
        if ($record.bytes -ne $dep.bytes -or $record.sha256 -cne $dep.sha256) { throw 'Build dependency pin mismatch' }
        $report.dependencies += $record
    }
    # The prefilled pins satisfy CMake's unconditional test-jar existence checks.
    # If that assumption changes, fail at a local missing URL, never its S3 fallback.
    $configureArgs = @('-S',$source,'-B',$build,'-G','Visual Studio 17 2022','-A','x64',
        '-T',"v143,version=$vcVersion",'-DCMAKE_BUILD_TYPE=Release',
        "-DCMAKE_SYSTEM_VERSION=$sdkVersion",'-DCMAKE_CXX_STANDARD=17',
        '-DWITH_JNI=ON','-DROCKSDB_BUILD_SHARED=OFF','-DROCKSDB_SKIP_THIRDPARTY=ON',
        '-DWITH_MD_LIBRARY=OFF','-DPORTABLE=ON','-DFAIL_ON_WARNINGS=ON',
        '-DWITH_TESTS=OFF','-DWITH_BENCHMARK_TOOLS=OFF','-DWITH_CORE_TOOLS=OFF','-DWITH_TOOLS=OFF',
        '-DWITH_TRACE_TOOLS=OFF','-DWITH_BENCHMARK=OFF','-DWITH_EXAMPLES=OFF',
        '-DWITH_GFLAGS=OFF','-DWITH_JEMALLOC=OFF','-DWITH_SNAPPY=OFF','-DWITH_LZ4=OFF',
        '-DWITH_ZLIB=OFF','-DWITH_ZSTD=OFF','-DWITH_XPRESS=OFF','-DWITH_LIBURING=OFF',
        '-DWITH_DYNAMIC_EXTENSION=OFF','-DCUSTOM_DEPS_URL=file:///nonexistent-moe-build-dependencies')
    $report.configureArguments = $configureArgs
    $report.phase = 'configure'
    Run -tool $cmake -arguments $configureArgs
    $report.cache = FileRecord (Join-Path $build 'CMakeCache.txt')
    $report.effectiveCache = @(Get-Content -LiteralPath (Join-Path $build 'CMakeCache.txt') |
        Where-Object { $_ -cmatch '^(CMAKE_(BUILD_TYPE|CXX_COMPILER|CXX_FLAGS[^:]*|GENERATOR[^:]*|SYSTEM_VERSION|VS[^:]*)|Java_[A-Z_]+|JAVA_[A-Z_]+|WITH_[A-Z_]+|ROCKSDB_[A-Z_]+|PORTABLE):[^=]+=' })
    $report.buildVersionSource = Get-Content -Raw -LiteralPath (Join-Path $build 'build_version.cc')
    # Generate test JNI headers as well: upstream JNI_NATIVE_SOURCES includes
    # test helper wrappers. This compiles Java classes; it does not run tests.
    $report.phase = 'java-headers'
    Run -tool $cmake -arguments @('--build',$build,'--config','Release','--target','rocksdbjni_test_classes','--parallel','2')
    $report.phase = 'native-compile'
    Run -tool $cmake -arguments @('--build',$build,'--config','Release','--target','rocksdbjava','--parallel','2')
    $report.phase = 'static-output'
    $dll = Join-Path $build 'java/Release/librocksdbjni-win64.dll'
    $jar = Join-Path $build 'java/rocksdbjni-10.2.1-win64.jar'
    $report.dll = FileRecord $dll
    $report.jar = FileRecord $jar
    if ($report.dll.bytes -gt 32MB -or $report.jar.bytes -gt 32MB) { throw 'Output exceeds 32 MiB per file' }
    # dumpbin parses the library as data. No LoadLibrary, JVM JNI load or ctest.
    Run -tool (Join-Path $vcBin 'dumpbin.exe') -arguments @('/DEPENDENTS',$dll)
    Run -tool (Join-Path $vcBin 'dumpbin.exe') -arguments @('/EXPORTS',$dll)
    Run -tool git -arguments @('-C',$source,'diff','--exit-code','HEAD','--')
    $report.freeAfter = $drive.AvailableFreeSpace
    $files = @(Get-ChildItem -LiteralPath $root -File -Recurse)
    $report.scratchFiles = $files.Count
    $report.scratchBytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($report.freeAfter -lt 2GB -or $report.scratchBytes -gt 8GB) { throw 'Final observed storage budget exceeded' }
    $report.status = 'compiled-unadopted-native-candidate'
    $report.phase = 'complete'
} catch {
    $report.errors += $_.Exception.Message
} finally {
    $report.elapsedMs = $watch.ElapsedMilliseconds
    Write-Output 'MOE_NATIVE_BUILD_REPORT_BEGIN'
    $report | ConvertTo-Json -Depth 10
    Write-Output 'MOE_NATIVE_BUILD_REPORT_END'
}
if ($report.status -cne 'compiled-unadopted-native-candidate') { exit 1 }
