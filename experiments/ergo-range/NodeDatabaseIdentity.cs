// Read-only identity checks for the fixed JRE/RocksDB disk experiment.
// This helper does not create, attach, format, map, unmap, or delete storage.
// A module inventory is one bounded point-in-time sample while the trusted JVM
// is waiting; it is not evidence about every module loaded during its lifetime.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

public static class NodeDatabaseIdentity
{
    public const int MaximumModules = 256;
    public const long MaximumHashedBytes = 128L * 1024L * 1024L;

    // Exact host component observed in ergo-node-system-component-provenance.json.
    // No WinSxS directory, signer, version family or basename wildcard is trusted.
    private const string CommonControlsPath = @"C:\WINDOWS\WinSxS\amd64_microsoft.windows.common-controls_6595b64144ccf1df_6.0.19041.6456_none_60b8a6cb71f64256\COMCTL32.dll";
    private const string CommonControlsSha256 = "4f3c45946d2e04915691d93b0606bdea1ebf60d89b884a42cbe226e65a03ea56";
    private const long CommonControlsBytes = 2715536L;

    private const uint ErrorSuccess = 0;
    private const uint ErrorFileNotFound = 2;
    private const uint StillActive = 259;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint ListModulesAll = 0x03;
    private const int MaximumPathCharacters = 32768;
    private const int DosDeviceBufferCharacters = 65536;

    private static readonly Regex VolumeGuidRootPattern = new Regex(
        @"^\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\\z",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Sha256Pattern = new Regex(
        @"^[0-9A-Fa-f]{64}\z", RegexOptions.CultureInvariant);
    private static readonly Regex LocalAbsolutePathPattern = new Regex(
        @"^[A-Za-z]:\\", RegexOptions.CultureInvariant);

    public sealed class NativeOperationException : Win32Exception
    {
        public string Operation { get; private set; }
        public uint NativeError { get; private set; }

        internal NativeOperationException(string operation, uint nativeError)
            : base(unchecked((int)nativeError), operation + " failed with Win32 error " + nativeError)
        {
            Operation = operation;
            NativeError = nativeError;
        }
    }

    public sealed class DriveLetterEvidence
    {
        public char Letter { get; private set; }
        public bool LogicalDrivePresent { get; private set; }
        public uint QueryDosDeviceError { get; private set; }
        public string[] DosTargets { get; private set; }

        public DriveLetterEvidence(char letter, bool logicalDrivePresent,
            uint queryDosDeviceError, string[] dosTargets)
        {
            Letter = NormalizeDriveLetter(letter);
            LogicalDrivePresent = logicalDrivePresent;
            QueryDosDeviceError = queryDosDeviceError;
            DosTargets = dosTargets == null ? new string[0] : (string[])dosTargets.Clone();
        }
    }

    public sealed class MappingRecord
    {
        public char DriveLetter { get; private set; }
        public string DriveRoot { get; private set; }
        public string VolumeGuidRoot { get; private set; }
        public string NativeTarget { get; private set; }

        internal MappingRecord(char driveLetter, string volumeGuidRoot, string nativeTarget)
        {
            DriveLetter = driveLetter;
            DriveRoot = driveLetter + @":\";
            VolumeGuidRoot = volumeGuidRoot;
            NativeTarget = nativeTarget;
        }
    }

    public sealed class ModuleRecord
    {
        public string Path { get; private set; }
        public string Sha256 { get; private set; }
        public long LengthBytes { get; private set; }
        public string Classification { get; private set; }

        public ModuleRecord(string path, string sha256, long lengthBytes)
            : this(path, sha256, lengthBytes, null) { }

        internal ModuleRecord(string path, string sha256, long lengthBytes, string classification)
        {
            Path = path;
            Sha256 = sha256;
            LengthBytes = lengthBytes;
            Classification = classification;
        }
    }

    // Chooses the highest unused ordinary letter. Both Windows views are read:
    // QueryDosDevice reservations count as occupied even without a logical bit.
    public static char SelectUnusedDriveLetter()
    {
        RequireWindowsX64();
        uint mask = GetLogicalDrives();
        if (mask == 0)
            throw new NativeOperationException("GetLogicalDrives", unchecked((uint)Marshal.GetLastWin32Error()));

        DriveLetterEvidence[] evidence = new DriveLetterEvidence['Z' - 'D' + 1];
        int index = 0;
        for (char letter = 'D'; letter <= 'Z'; letter++)
        {
            bool logical = (mask & (1U << (letter - 'A'))) != 0;
            uint error;
            string[] targets = QueryDosTargets(letter + ":", out error);
            evidence[index++] = new DriveLetterEvidence(letter, logical, error, targets);
        }
        return SelectUnusedDriveLetterForTest(evidence);
    }

    public static char SelectUnusedDriveLetterForTest(DriveLetterEvidence[] evidence)
    {
        if (evidence == null || evidence.Length != 'Z' - 'D' + 1)
            throw new ArgumentException("Evidence must contain every ordinary letter D through Z", nameof(evidence));

        bool[] seen = new bool[26];
        bool[] unused = new bool[26];
        foreach (DriveLetterEvidence item in evidence)
        {
            if (item == null)
                throw new ArgumentException("Drive-letter evidence contains a null entry", nameof(evidence));
            char letter = NormalizeDriveLetter(item.Letter);
            int offset = letter - 'A';
            if (letter < 'D' || seen[offset])
                throw new ArgumentException("Drive-letter evidence is duplicated or outside D through Z", nameof(evidence));
            seen[offset] = true;

            ValidateDosQueryResult(item.QueryDosDeviceError, item.DosTargets, "QueryDosDevice(" + letter + ":)");
            if (item.LogicalDrivePresent && item.QueryDosDeviceError == ErrorFileNotFound)
                throw new InvalidOperationException("Logical-drive and DOS-device evidence disagree for " + letter + ":");
            unused[offset] = !item.LogicalDrivePresent && item.QueryDosDeviceError == ErrorFileNotFound;
        }

        for (char letter = 'D'; letter <= 'Z'; letter++)
            if (!seen[letter - 'A'])
                throw new ArgumentException("Drive-letter evidence is incomplete", nameof(evidence));
        for (char letter = 'Z'; letter >= 'D'; letter--)
            if (unused[letter - 'A'])
                return letter;
        throw new InvalidOperationException("No unused ordinary drive letter is available from D through Z");
    }

    public static MappingRecord VerifyDriveMapping(char driveLetter, string expectedVolumeGuidRoot)
    {
        RequireWindowsX64();
        char letter = NormalizeDriveLetter(driveLetter);
        string expected = NormalizeVolumeGuidRoot(expectedVolumeGuidRoot);
        string root = letter + @":\";

        StringBuilder volume = new StringBuilder(50);
        if (!GetVolumeNameForVolumeMountPoint(root, volume, volume.Capacity))
            throw new NativeOperationException("GetVolumeNameForVolumeMountPoint(" + root + ")",
                unchecked((uint)Marshal.GetLastWin32Error()));

        uint letterError;
        string[] letterTargets = QueryDosTargets(letter + ":", out letterError);
        if (letterError != ErrorSuccess)
            throw new NativeOperationException("QueryDosDevice(" + letter + ":)", letterError);
        uint volumeError;
        string[] volumeTargets = QueryDosTargets(VolumeDeviceName(expected), out volumeError);
        if (volumeError != ErrorSuccess)
            throw new NativeOperationException("QueryDosDevice(" + VolumeDeviceName(expected) + ")", volumeError);

        FileAttributes rootAttributes = File.GetAttributes(root);
        bool rootReparse = (rootAttributes & FileAttributes.ReparsePoint) != 0;
        return VerifyDriveMappingForTest(letter, expected, volume.ToString(), letterTargets, volumeTargets, rootReparse);
    }

    public static MappingRecord VerifyDriveMappingForTest(char driveLetter, string expectedVolumeGuidRoot,
        string reportedVolumeGuidRoot, string[] letterTargets, string[] volumeTargets, bool driveRootIsReparsePoint)
    {
        char letter = NormalizeDriveLetter(driveLetter);
        string expected = NormalizeVolumeGuidRoot(expectedVolumeGuidRoot);
        string reported = NormalizeVolumeGuidRoot(reportedVolumeGuidRoot);
        if (!String.Equals(expected, reported, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Drive root resolves to a different volume GUID");
        if (driveRootIsReparsePoint)
            throw new IOException("Drive root is a reparse point");

        string letterTarget = RequireSingleDosTarget(letterTargets, "drive letter");
        string volumeTarget = RequireSingleDosTarget(volumeTargets, "volume GUID");
        if (!String.Equals(letterTarget, volumeTarget, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Drive-letter and volume-GUID DOS targets differ");
        return new MappingRecord(letter, expected, letterTarget);
    }

    public static void VerifyDriveLetterAbsent(char driveLetter)
    {
        RequireWindowsX64();
        char letter = NormalizeDriveLetter(driveLetter);
        uint mask = GetLogicalDrives();
        if (mask == 0)
            throw new NativeOperationException("GetLogicalDrives", unchecked((uint)Marshal.GetLastWin32Error()));
        uint error;
        string[] targets = QueryDosTargets(letter + ":", out error);
        VerifyDriveLetterAbsentForTest(letter, mask, error, targets);
    }

    public static void VerifyDriveLetterAbsentForTest(char driveLetter, uint logicalDriveMask,
        uint queryDosDeviceError, string[] dosTargets)
    {
        char letter = NormalizeDriveLetter(driveLetter);
        ValidateDosQueryResult(queryDosDeviceError, dosTargets, "QueryDosDevice(" + letter + ":)");
        if ((logicalDriveMask & (1U << (letter - 'A'))) != 0 || queryDosDeviceError != ErrorFileNotFound)
            throw new InvalidOperationException("Drive-letter mapping or DOS-device reservation remains for " + letter + ":");
    }

    public static ModuleRecord[] CaptureAndVerifyModules(int processId, string runRoot,
        string bundleRoot, string expectedRocksDbDllPath, string expectedRocksDbSha256,
        IDictionary pinnedBundleManifest)
    {
        RequireWindowsX64();
        if (processId <= 0)
            throw new ArgumentOutOfRangeException(nameof(processId));

        IntPtr process = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, unchecked((uint)processId));
        if (process == IntPtr.Zero)
            throw new NativeOperationException("OpenProcess(module inventory)", unchecked((uint)Marshal.GetLastWin32Error()));
        try
        {
            RequireProcessActive(process, "before module inventory");
            IntPtr[] handles = new IntPtr[MaximumModules + 1];
            uint bytesNeeded;
            if (!EnumProcessModulesEx(process, handles, unchecked((uint)(handles.Length * IntPtr.Size)),
                out bytesNeeded, ListModulesAll))
                throw new NativeOperationException("EnumProcessModulesEx", unchecked((uint)Marshal.GetLastWin32Error()));
            if (bytesNeeded % IntPtr.Size != 0)
                throw new InvalidOperationException("EnumProcessModulesEx returned a malformed byte count");
            uint moduleCount = bytesNeeded / unchecked((uint)IntPtr.Size);
            if (moduleCount == 0 || moduleCount > MaximumModules)
                throw new InvalidOperationException("Loaded-module count is outside the 1 through 256 bound");

            List<string> paths = new List<string>(checked((int)moduleCount));
            for (int index = 0; index < moduleCount; index++)
            {
                StringBuilder path = new StringBuilder(MaximumPathCharacters);
                uint length = GetModuleFileNameEx(process, handles[index], path, path.Capacity);
                if (length == 0)
                    throw new NativeOperationException("GetModuleFileNameEx", unchecked((uint)Marshal.GetLastWin32Error()));
                if (length >= path.Capacity - 1)
                    throw new InvalidOperationException("Loaded-module path exceeds the fixed path buffer");
                paths.Add(NormalizeLocalAbsolutePath(path.ToString(), "loaded module path"));
            }
            RequireProcessActive(process, "after module inventory");

            Dictionary<string, ModuleRecord> hashed = new Dictionary<string, ModuleRecord>(StringComparer.OrdinalIgnoreCase);
            List<ModuleRecord> records = new List<ModuleRecord>(paths.Count);
            long bytesHashed = 0;
            foreach (string path in paths)
            {
                RejectReparsePointAncestors(path);
                ModuleRecord record;
                if (!hashed.TryGetValue(path, out record))
                {
                    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                        FileShare.Read, 1024 * 1024, FileOptions.SequentialScan))
                    {
                        long length = stream.Length;
                        if (length < 0 || length > MaximumHashedBytes - bytesHashed)
                            throw new InvalidOperationException("Loaded-module hashes exceed the 128 MiB byte bound");
                        bytesHashed = checked(bytesHashed + length);
                        using (SHA256 sha256 = SHA256.Create())
                            record = new ModuleRecord(path, ToHex(sha256.ComputeHash(stream)), length);
                    }
                    hashed.Add(path, record);
                }
                records.Add(record);
            }
            RequireProcessActive(process, "after module hashing");
            return VerifyModulePolicy(records.ToArray(), runRoot, bundleRoot, expectedRocksDbDllPath,
                expectedRocksDbSha256, pinnedBundleManifest, true);
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static ModuleRecord[] VerifyModulePolicyForTest(ModuleRecord[] modules, string runRoot,
        string bundleRoot, string expectedRocksDbDllPath, string expectedRocksDbSha256,
        IDictionary pinnedBundleManifest)
    {
        return VerifyModulePolicy(modules, runRoot, bundleRoot, expectedRocksDbDllPath,
            expectedRocksDbSha256, pinnedBundleManifest, false);
    }

    private static ModuleRecord[] VerifyModulePolicy(ModuleRecord[] modules, string runRoot,
        string bundleRoot, string expectedRocksDbDllPath, string expectedRocksDbSha256,
        IDictionary pinnedBundleManifest, bool checkFileSystem)
    {
        if (modules == null || modules.Length == 0 || modules.Length > MaximumModules)
            throw new ArgumentException("Module inventory must contain 1 through 256 records", nameof(modules));
        string run = NormalizeDirectoryRoot(runRoot, nameof(runRoot));
        string bundle = NormalizeDirectoryRoot(bundleRoot, nameof(bundleRoot));
        if (PathsOverlap(run, bundle))
            throw new ArgumentException("Run and pinned-bundle roots must not overlap");
        string rocks = NormalizeLocalAbsolutePath(expectedRocksDbDllPath, nameof(expectedRocksDbDllPath));
        if (!IsUnderRoot(rocks, run) || !String.Equals(Path.GetExtension(rocks), ".dll", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Expected RocksDB DLL must be a DLL below the run root", nameof(expectedRocksDbDllPath));
        string rocksHash = NormalizeHash(expectedRocksDbSha256, nameof(expectedRocksDbSha256));
        string system = NormalizeDirectoryRoot(Environment.SystemDirectory, "systemDirectory");

        Dictionary<string, string> pins = BuildPinnedPaths(bundle, pinnedBundleManifest);
        long totalBytes = 0;
        int rocksCount = 0;
        int commonControlsCount = 0;
        ModuleRecord[] verified = new ModuleRecord[modules.Length];
        for (int index = 0; index < modules.Length; index++)
        {
            ModuleRecord item = modules[index];
            if (item == null)
                throw new ArgumentException("Module inventory contains a null record", nameof(modules));
            string path = NormalizeLocalAbsolutePath(item.Path, "module path");
            string hash = NormalizeHash(item.Sha256, "module hash");
            if (item.LengthBytes < 0 || item.LengthBytes > MaximumHashedBytes - totalBytes)
                throw new InvalidOperationException("Module inventory exceeds the 128 MiB byte bound");
            totalBytes = checked(totalBytes + item.LengthBytes);
            if (checkFileSystem)
                RejectReparsePointAncestors(path);

            string classification;
            if (String.Equals(path, rocks, StringComparison.OrdinalIgnoreCase))
            {
                rocksCount++;
                if (!String.Equals(hash, rocksHash, StringComparison.Ordinal))
                    throw new InvalidOperationException("Loaded RocksDB DLL hash differs from the expected hash");
                classification = "rocksdb-pinned";
            }
            else
            {
                string pinnedHash;
                if (pins.TryGetValue(path, out pinnedHash))
                {
                    if (!String.Equals(hash, pinnedHash, StringComparison.Ordinal))
                        throw new InvalidOperationException("Loaded pinned-bundle module hash differs from its manifest");
                    classification = "bundle-pinned";
                }
                else if (String.Equals(path, CommonControlsPath, StringComparison.OrdinalIgnoreCase))
                {
                    if (++commonControlsCount != 1 || item.LengthBytes != CommonControlsBytes ||
                        !String.Equals(hash, CommonControlsSha256, StringComparison.Ordinal))
                        throw new InvalidOperationException("Loaded Common Controls module differs from the exact reviewed component");
                    classification = "system-component-pinned";
                }
                else if (IsUnderRoot(path, system))
                {
                    if (IsUnpinnedRocksNativeLibrary(path))
                        throw new InvalidOperationException("RocksDB JNI or optional compression DLL is not an exact pinned-bundle entry: " + path);
                    classification = "system-observed";
                }
                else
                {
                    throw new InvalidOperationException("Loaded module is outside the expected RocksDB path, pinned bundle, exact reviewed component, and system directory: " + path);
                }
            }
            verified[index] = new ModuleRecord(path, hash, item.LengthBytes, classification);
        }
        if (rocksCount != 1)
            throw new InvalidOperationException("Exactly one expected RocksDB DLL module must be loaded");
        return verified;
    }

    private static Dictionary<string, string> BuildPinnedPaths(string bundleRoot, IDictionary manifest)
    {
        if (manifest == null || manifest.Count == 0)
            throw new ArgumentException("Pinned bundle manifest is empty", nameof(manifest));
        Dictionary<string, string> pins = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in manifest)
        {
            string relative = entry.Key as string;
            string hash = entry.Value as string;
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) ||
                relative.IndexOf(':') >= 0 || relative.IndexOf('\0') >= 0)
                throw new ArgumentException("Pinned bundle manifest contains an invalid relative path", nameof(manifest));
            relative = relative.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
            string path = Path.GetFullPath(Path.Combine(bundleRoot, relative));
            if (!IsUnderRoot(path, bundleRoot))
                throw new ArgumentException("Pinned bundle manifest path escapes the bundle root", nameof(manifest));
            if (pins.ContainsKey(path))
                throw new ArgumentException("Pinned bundle manifest resolves two entries to one path", nameof(manifest));
            pins.Add(path, NormalizeHash(hash, "manifest hash"));
        }
        return pins;
    }

    private static string NormalizeDirectoryRoot(string path, string parameterName)
    {
        if (String.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Directory root is empty", parameterName);
        string full = NormalizeLocalAbsolutePath(path, parameterName);
        return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    private static string NormalizeLocalAbsolutePath(string path, string parameterName)
    {
        if (String.IsNullOrWhiteSpace(path) || !LocalAbsolutePathPattern.IsMatch(path))
            throw new ArgumentException("Path must use an ordinary absolute local drive path", parameterName);
        return Path.GetFullPath(path);
    }

    private static bool IsUnderRoot(string path, string root)
    {
        string full = Path.GetFullPath(path);
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && full.Length > root.Length;
    }

    private static bool PathsOverlap(string first, string second)
    {
        return first.StartsWith(second, StringComparison.OrdinalIgnoreCase) ||
            second.StartsWith(first, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsUnpinnedRocksNativeLibrary(string path)
    {
        if (!String.Equals(Path.GetExtension(path), ".dll", StringComparison.OrdinalIgnoreCase))
            return false;
        string name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
        if (name.Contains("rocksdbjni"))
            return true;
        // Pinned RocksDB 10.2.1 CompressionType libraryName values are
        // snappy, z, bzip2, lz4, xpress and zstd (LZ4HC also maps to lz4).
        // Cover both System.mapLibraryName's Windows form and common native
        // distributions which retain the Unix-style lib prefix.
        if (name.StartsWith("lib", StringComparison.Ordinal))
            name = name.Substring(3);
        return name == "snappy" || name == "z" || name == "zlib" ||
            name == "bzip2" || name == "bz2" || name == "lz4" || name == "lz4hc" ||
            name == "xpress" || name == "zstd";
    }

    private static string NormalizeHash(string hash, string parameterName)
    {
        if (String.IsNullOrWhiteSpace(hash) || !Sha256Pattern.IsMatch(hash))
            throw new ArgumentException("SHA-256 value must contain exactly 64 hexadecimal characters", parameterName);
        return hash.ToLowerInvariant();
    }

    private static string ToHex(byte[] bytes)
    {
        StringBuilder text = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes)
            text.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        return text.ToString();
    }

    private static string NormalizeVolumeGuidRoot(string volumeGuidRoot)
    {
        if (String.IsNullOrWhiteSpace(volumeGuidRoot) || !VolumeGuidRootPattern.IsMatch(volumeGuidRoot))
            throw new ArgumentException("Volume root must be an exact \\\\?\\Volume{GUID}\\ root", nameof(volumeGuidRoot));
        return volumeGuidRoot;
    }

    private static string VolumeDeviceName(string volumeGuidRoot)
    {
        return volumeGuidRoot.Substring(4, volumeGuidRoot.Length - 5);
    }

    private static char NormalizeDriveLetter(char driveLetter)
    {
        char letter = Char.ToUpperInvariant(driveLetter);
        if (letter < 'D' || letter > 'Z')
            throw new ArgumentOutOfRangeException(nameof(driveLetter), "Drive letter must be in D through Z");
        return letter;
    }

    private static void ValidateDosQueryResult(uint error, string[] targets, string operation)
    {
        if (error != ErrorSuccess && error != ErrorFileNotFound)
            throw new NativeOperationException(operation, error);
        int count = targets == null ? 0 : targets.Length;
        if ((error == ErrorSuccess && count == 0) || (error == ErrorFileNotFound && count != 0))
            throw new InvalidOperationException(operation + " returned inconsistent targets and status");
        if (targets != null)
            foreach (string target in targets)
                if (String.IsNullOrWhiteSpace(target) || target.IndexOf('\0') >= 0)
                    throw new InvalidOperationException(operation + " returned an invalid DOS target");
    }

    private static string RequireSingleDosTarget(string[] targets, string label)
    {
        if (targets == null || targets.Length != 1 || String.IsNullOrWhiteSpace(targets[0]))
            throw new InvalidOperationException("Expected one unambiguous DOS target for " + label);
        return targets[0];
    }

    private static string[] QueryDosTargets(string deviceName, out uint error)
    {
        char[] buffer = new char[DosDeviceBufferCharacters];
        uint length = QueryDosDevice(deviceName, buffer, unchecked((uint)buffer.Length));
        if (length == 0)
        {
            error = unchecked((uint)Marshal.GetLastWin32Error());
            if (error != ErrorFileNotFound)
                throw new NativeOperationException("QueryDosDevice(" + deviceName + ")", error);
            return new string[0];
        }
        error = ErrorSuccess;
        List<string> targets = new List<string>();
        int start = 0;
        int end = checked((int)length);
        while (start < end && buffer[start] != '\0')
        {
            int terminator = Array.IndexOf(buffer, '\0', start, end - start);
            if (terminator < 0)
                throw new InvalidOperationException("QueryDosDevice returned an unterminated target list");
            targets.Add(new string(buffer, start, terminator - start));
            start = terminator + 1;
        }
        if (targets.Count == 0)
            throw new InvalidOperationException("QueryDosDevice returned an empty target list");
        return targets.ToArray();
    }

    private static void RejectReparsePointAncestors(string path)
    {
        string full = Path.GetFullPath(path);
        for (string current = full; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Loaded-module path has a reparse-point ancestor: " + current);
        }
    }

    private static void RequireProcessActive(IntPtr process, string phase)
    {
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode))
            throw new NativeOperationException("GetExitCodeProcess(" + phase + ")", unchecked((uint)Marshal.GetLastWin32Error()));
        if (exitCode != StillActive)
            throw new InvalidOperationException("Process exited " + phase);
    }

    private static void RequireWindowsX64()
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8)
            throw new PlatformNotSupportedException("Identity checks require 64-bit Windows");
    }

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern uint GetLogicalDrives();

    [DllImport("kernel32.dll", EntryPoint = "QueryDosDeviceW", CharSet = CharSet.Unicode,
        SetLastError = true, ExactSpelling = true)]
    private static extern uint QueryDosDevice(string deviceName, [Out] char[] targetPath, uint maximumCharacters);

    [DllImport("kernel32.dll", EntryPoint = "GetVolumeNameForVolumeMountPointW", CharSet = CharSet.Unicode,
        SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeNameForVolumeMountPoint(string volumeMountPoint,
        StringBuilder volumeName, int bufferLength);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("psapi.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumProcessModulesEx(IntPtr process, [Out] IntPtr[] modules,
        uint bytes, out uint bytesNeeded, uint filterFlag);

    [DllImport("psapi.dll", EntryPoint = "GetModuleFileNameExW", CharSet = CharSet.Unicode,
        SetLastError = true, ExactSpelling = true)]
    private static extern uint GetModuleFileNameEx(IntPtr process, IntPtr module,
        StringBuilder fileName, int size);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
