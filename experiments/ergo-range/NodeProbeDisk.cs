// Fixed-purpose Windows disk-full control for the node experiment.
// The only virtual disk this helper can create is a new, fixed 64 MiB VHD.
// It deliberately has no open/reuse, formatting, partitioning, deletion,
// privilege-adjustment, process, or arbitrary-size surface.
//
// ABI source: virtdisk.h as documented by Microsoft Learn:
// CreateVirtualDisk, AttachVirtualDisk, DetachVirtualDisk,
// GetVirtualDiskInformation, and GetVirtualDiskPhysicalPath.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class NodeProbeDisk
{
    public const long VirtualDiskBytes = 64L * 1024L * 1024L;
    public const long FillLimitBytes = 65L * 1024L * 1024L;
    public const int FillBlockBytes = 1024 * 1024;
    public const string FillFileName = "fill.bin";

    private const uint ErrorSuccess = 0;
    private const uint ErrorInsufficientBuffer = 122;
    private const uint ErrorDiskFull = 112;

    // VIRTUAL_DISK_ACCESS_MASK: ATTACH_RW | DETACH | GET_INFO | CREATE.
    private const uint VirtualDiskAccess = 0x001E0000;
    // CREATE_VIRTUAL_DISK_FLAG_FULL_PHYSICAL_ALLOCATION.
    private const uint CreateFixed = 0x00000001;
    // ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER.  PERMANENT_LIFETIME is omitted.
    private const uint AttachNoDriveLetter = 0x00000002;
    private const uint GetVirtualDiskInfoSize = 1;
    private const uint GetVirtualDiskInfoProviderSubtype = 7;
    private const uint ProviderSubtypeFixed = 2;
    private const uint VirtualStorageTypeDeviceVhd = 2;
    private static readonly Guid MicrosoftVirtualStorageVendor =
        new Guid("EC984AEC-A0F9-47E9-901F-71415A66345B");

    private static readonly Regex ImagePathPattern = new Regex(
        @"^[A-Za-z]:\\(?:[^\\/:*?\""<>|\x00-\x1F]+\\)*[^\\/:*?\""<>|\x00-\x1F]+\.vhd\z",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex VolumeGuidRootPattern = new Regex(
        @"^\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\\z",
        RegexOptions.CultureInvariant);
    private static readonly Regex VolumeGuidTokenPattern = new Regex(
        @"^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\z",
        RegexOptions.CultureInvariant);

    public sealed class NativeOperationException : Win32Exception
    {
        public string Operation { get; private set; }
        public uint NativeError { get; private set; }
        public uint SecondaryNativeError { get; private set; }

        internal NativeOperationException(string operation, uint nativeError, uint secondaryNativeError = 0)
            : base(unchecked((int)nativeError), BuildMessage(operation, nativeError, secondaryNativeError))
        {
            Operation = operation;
            NativeError = nativeError;
            SecondaryNativeError = secondaryNativeError;
        }

        private static string BuildMessage(string operation, uint nativeError, uint secondaryNativeError)
        {
            string message = operation + " failed with Win32 error " + nativeError;
            if (secondaryNativeError != 0)
                message += "; cleanup failed with Win32 error " + secondaryNativeError;
            return message;
        }
    }

    public sealed class DiskInfo
    {
        public long VirtualSizeBytes { get; private set; }
        public long BackingSizeBytes { get; private set; }
        public uint ProviderSubtype { get; private set; }
        public string PhysicalPath { get; private set; }

        internal DiskInfo(long virtualSizeBytes, long backingSizeBytes, uint providerSubtype, string physicalPath)
        {
            VirtualSizeBytes = virtualSizeBytes;
            BackingSizeBytes = backingSizeBytes;
            ProviderSubtype = providerSubtype;
            PhysicalPath = physicalPath;
        }
    }

    public sealed class FillResult
    {
        public string FilePath { get; private set; }
        public long BytesWritten { get; private set; }
        public long AttemptedBytes { get; private set; }
        public long ElapsedMilliseconds { get; private set; }
        public bool DiskFullObserved { get; private set; }
        public uint NativeError { get; private set; }
        public string Status { get; private set; }
        public long VolumeTotalBytes { get; private set; }
        public long InitialFreeBytes { get; private set; }

        internal FillResult(
            string filePath,
            long bytesWritten,
            long attemptedBytes,
            long elapsedMilliseconds,
            bool diskFullObserved,
            long volumeTotalBytes,
            long initialFreeBytes)
        {
            FilePath = filePath;
            BytesWritten = bytesWritten;
            AttemptedBytes = attemptedBytes;
            ElapsedMilliseconds = elapsedMilliseconds;
            DiskFullObserved = diskFullObserved;
            NativeError = diskFullObserved ? ErrorDiskFull : ErrorSuccess;
            Status = diskFullObserved ? "disk-full" : "fill-limit-reached";
            VolumeTotalBytes = volumeTotalBytes;
            InitialFreeBytes = initialFreeBytes;
        }
    }

    // Owns the only handle that attached this VHD.  The VHD image is intentionally
    // retained; disposing only detaches and closes the handle.
    public sealed class AttachedDisk : IDisposable
    {
        private readonly object gate = new object();
        private readonly SafeVirtualDiskHandle handle;
        private bool attached;
        private bool disposed;

        public string ImagePath { get; private set; }
        public DiskInfo Info { get; private set; }

        // Binds each readback to this handle and refuses it before attachment.
        public string PhysicalPath
        {
            get
            {
                lock (gate)
                {
                    ThrowIfDisposed();
                    if (!attached)
                        throw new InvalidOperationException("VHD is not attached");
                    return ReadPhysicalPath(handle);
                }
            }
        }

        internal AttachedDisk(SafeVirtualDiskHandle handle, string imagePath, DiskInfo info)
        {
            this.handle = handle;
            ImagePath = imagePath;
            Info = info;
            attached = false;
        }

        public void Attach()
        {
            lock (gate)
            {
                ThrowIfDisposed();
                if (attached)
                    throw new InvalidOperationException("VHD is already attached");

                uint error = AttachVirtualDisk(handle, IntPtr.Zero, AttachNoDriveLetter, 0, IntPtr.Zero, IntPtr.Zero);
                ThrowIfFailed("AttachVirtualDisk", error);
                attached = true;
                string physicalPath = ReadPhysicalPath(handle);
                Info = new DiskInfo(Info.VirtualSizeBytes, Info.BackingSizeBytes, Info.ProviderSubtype, physicalPath);
            }
        }

        public void Detach()
        {
            lock (gate)
            {
                ThrowIfDisposed();
                if (!attached)
                    return;

                uint error = DetachVirtualDisk(handle, 0, 0);
                ThrowIfFailed("DetachVirtualDisk", error);
                attached = false;
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                    return;

                uint detachError = ErrorSuccess;
                if (attached && !handle.IsInvalid && !handle.IsClosed)
                    detachError = DetachVirtualDisk(handle, 0, 0);

                uint closeError = handle.CloseChecked();
                if (closeError == ErrorSuccess)
                {
                    // Without PERMANENT_LIFETIME, closing the last handle also
                    // detaches if an explicit detach happened to fail.
                    attached = false;
                    disposed = true;
                }
                else if (detachError == ErrorSuccess)
                {
                    attached = false;
                }

                if (detachError != ErrorSuccess || closeError != ErrorSuccess)
                {
                    uint primary = detachError != ErrorSuccess ? detachError : closeError;
                    uint secondary = detachError != ErrorSuccess ? closeError : ErrorSuccess;
                    throw new NativeOperationException("DetachVirtualDisk/CloseHandle", primary, secondary);
                }
            }
        }

        private void ThrowIfDisposed()
        {
            if (disposed)
                throw new ObjectDisposedException(nameof(AttachedDisk));
        }
    }

    // Creates exactly one fixed VHD.  The target must be a new local .vhd path;
    // CreateVirtualDisk is the create-new operation and this helper never opens it.
    public static AttachedDisk Create(string imagePath)
    {
        return CreateSized(imagePath, VirtualDiskBytes);
    }

    public static AttachedDisk CreateSync20GiB(string imagePath)
    {
        return CreateSized(imagePath, 20L * 1024L * 1024L * 1024L);
    }

    private static AttachedDisk CreateSized(string imagePath, long virtualBytes)
    {
        RequireWindowsX64();
        ValidateNativeLayout();
        string fullImagePath = ValidateImagePathForCreate(imagePath);

        SafeVirtualDiskHandle handle = null;
        try
        {
            VirtualStorageType storageType = new VirtualStorageType
            {
                DeviceId = VirtualStorageTypeDeviceVhd,
                VendorId = MicrosoftVirtualStorageVendor
            };
            CreateVirtualDiskParameters parameters = new CreateVirtualDiskParameters
            {
                Version = 1,
                UniqueId = Guid.Empty,
                MaximumSize = unchecked((ulong)virtualBytes),
                BlockSizeInBytes = 0,
                SectorSizeInBytes = 512,
                ParentPath = IntPtr.Zero,
                SourcePath = IntPtr.Zero
            };

            IntPtr nativeHandle;
            uint createError = CreateVirtualDisk(
                ref storageType,
                fullImagePath,
                VirtualDiskAccess,
                IntPtr.Zero,
                CreateFixed,
                0,
                ref parameters,
                IntPtr.Zero,
                out nativeHandle);
            ThrowIfFailed("CreateVirtualDisk", createError);
            if (nativeHandle == IntPtr.Zero || nativeHandle == new IntPtr(-1))
                throw new InvalidOperationException("CreateVirtualDisk returned an invalid handle without an error");
            // CreateVirtualDisk leaves its output handle undefined on failure, so
            // ownership begins only after its ERROR_SUCCESS return above.
            handle = SafeVirtualDiskHandle.FromSuccessfulCreate(nativeHandle);

            DiskSize size = ReadSize(handle);
            uint providerSubtype = ReadProviderSubtype(handle);
            if (size.VirtualSizeBytes != virtualBytes)
                throw new InvalidOperationException("Created VHD has an unexpected virtual size");
            if (providerSubtype != ProviderSubtypeFixed)
                throw new InvalidOperationException("Created VHD is not reported as fixed by its provider");

            return new AttachedDisk(
                handle,
                fullImagePath,
                new DiskInfo(size.VirtualSizeBytes, size.BackingSizeBytes, providerSubtype, null));
        }
        catch (Exception primary)
        {
            uint detachError = ErrorSuccess;
            uint closeError = ErrorSuccess;
            if (handle != null && !handle.IsInvalid && !handle.IsClosed)
            {
                closeError = handle.CloseChecked();
            }

            if (detachError != ErrorSuccess || closeError != ErrorSuccess)
            {
                uint cleanupError = detachError != ErrorSuccess ? detachError : closeError;
                throw new InvalidOperationException(
                    "VHD setup failed and cleanup also failed with Win32 error " + cleanupError,
                    primary);
            }
            throw;
        }
    }

    public static AttachedDisk CreateAttachedFixed64MiB(string imagePath)
    {
        AttachedDisk disk = Create(imagePath);
        try
        {
            disk.Attach();
            return disk;
        }
        catch
        {
            disk.Dispose();
            throw;
        }
    }

    // Pure validation hook.  It accepts only an already-normalized local path,
    // rejects existing files/directories, alternate streams, UNC/device paths and
    // any reparse-point ancestor.  The final create-new call remains authoritative.
    public static string ValidateImagePathForCreate(string imagePath)
    {
        if (String.IsNullOrWhiteSpace(imagePath) || !ImagePathPattern.IsMatch(imagePath))
            throw new ArgumentException("VHD target must be an absolute local .vhd path without streams", nameof(imagePath));

        string fullPath = Path.GetFullPath(imagePath);
        if (!String.Equals(imagePath, fullPath, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("VHD target must already be normalized", nameof(imagePath));
        if (File.Exists(fullPath) || Directory.Exists(fullPath))
            throw new IOException("VHD target already exists; refusing to open or reuse it");
        try
        {
            // File.Exists is false for some unresolved links; attributes still
            // expose an extant reparse target, which must never be reused.
            File.GetAttributes(fullPath);
            throw new IOException("VHD target already exists; refusing to open or reuse it");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }

        string directory = Path.GetDirectoryName(fullPath);
        if (String.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            throw new DirectoryNotFoundException("VHD target directory does not exist");
        RejectReparsePointAncestors(directory);
        return fullPath;
    }

    public static void ValidateNativeLayoutForTest()
    {
        RequireWindowsX64();
        ValidateNativeLayout();
    }

    // The worker receives the braced GUID token without a trailing slash, then
    // calls this method before passing the exact resulting root to Fill.
    public static string BuildVolumeGuidRoot(string volumeGuidToken)
    {
        if (String.IsNullOrWhiteSpace(volumeGuidToken) || !VolumeGuidTokenPattern.IsMatch(volumeGuidToken))
            throw new ArgumentException("Volume token must be one braced GUID without a trailing slash", nameof(volumeGuidToken));
        return "\\\\?\\Volume" + volumeGuidToken + "\\";
    }

    // Fills one fixed create-new file in 1 MiB writes, stopping at 65 MiB or the
    // one specifically observed ERROR_DISK_FULL condition.  All other failures
    // propagate; the helper never deletes or reuses fill.bin.
    public static FillResult Fill(string volumeGuidRoot)
    {
        RequireWindowsX64();
        string root = ValidateVolumeGuidRoot(volumeGuidRoot);
        string fillPath = root + FillFileName;
        VolumeSpace space = ReadVolumeSpace(root);
        if (space.TotalBytes == 0 || space.TotalBytes > VirtualDiskBytes)
            throw new InvalidOperationException("Volume capacity is outside the fixed 64 MiB VHD bound");
        if (space.AvailableBytes == 0)
            throw new InvalidOperationException("Volume has no initial free space; disk-full cannot be observed by Fill");

        byte[] block = new byte[FillBlockBytes];
        long bytesWritten = 0;
        long attemptedBytes = 0;
        bool diskFullObserved = false;
        Stopwatch stopwatch = Stopwatch.StartNew();

        using (FileStream stream = new FileStream(
            fillPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            FillBlockBytes,
            FileOptions.WriteThrough | FileOptions.SequentialScan))
        {
            try
            {
                while (bytesWritten < FillLimitBytes)
                {
                    attemptedBytes = checked(bytesWritten + block.Length);
                    stream.Write(block, 0, block.Length);
                    bytesWritten = stream.Position;
                }
                stream.Flush(true);
            }
            catch (IOException exception) when (IsDiskFull(exception))
            {
                diskFullObserved = true;
                bytesWritten = stream.Position;
            }
        }

        stopwatch.Stop();
        return new FillResult(
            fillPath,
            bytesWritten,
            attemptedBytes,
            stopwatch.ElapsedMilliseconds,
            diskFullObserved,
            space.TotalBytes,
            space.AvailableBytes);
    }

    // Pure validation hook for the worker's reconstructed root.
    public static string ValidateVolumeGuidRoot(string volumeGuidRoot)
    {
        if (String.IsNullOrWhiteSpace(volumeGuidRoot) || !VolumeGuidRootPattern.IsMatch(volumeGuidRoot))
            throw new ArgumentException("Volume root must be an exact \\?\\Volume{GUID}\\ root", nameof(volumeGuidRoot));
        return volumeGuidRoot;
    }

    private static DiskSize ReadSize(SafeVirtualDiskHandle handle)
    {
        GetVirtualDiskInfo info = new GetVirtualDiskInfo { Version = GetVirtualDiskInfoSize };
        uint size = unchecked((uint)Marshal.SizeOf(typeof(GetVirtualDiskInfo)));
        uint used;
        uint error = GetVirtualDiskInformation(handle, ref size, ref info, out used);
        ThrowIfFailed("GetVirtualDiskInformation(size)", error);
        if (info.VirtualSize > Int64.MaxValue || info.PhysicalSize > Int64.MaxValue)
            throw new InvalidOperationException("Virtual disk size exceeds the supported signed range");
        return new DiskSize((long)info.VirtualSize, (long)info.PhysicalSize);
    }

    private static uint ReadProviderSubtype(SafeVirtualDiskHandle handle)
    {
        GetVirtualDiskInfo info = new GetVirtualDiskInfo { Version = GetVirtualDiskInfoProviderSubtype };
        uint size = unchecked((uint)Marshal.SizeOf(typeof(GetVirtualDiskInfo)));
        uint used;
        uint error = GetVirtualDiskInformation(handle, ref size, ref info, out used);
        ThrowIfFailed("GetVirtualDiskInformation(provider subtype)", error);
        return info.ProviderSubtype;
    }

    private static string ReadPhysicalPath(SafeVirtualDiskHandle handle)
    {
        uint bytes = 512;
        for (int attempt = 0; attempt != 2; attempt++)
        {
            int characters = checked((int)((bytes + 1) / 2));
            StringBuilder path = new StringBuilder(characters);
            uint bufferBytes = checked((uint)(path.Capacity * sizeof(char)));
            uint error = GetVirtualDiskPhysicalPath(handle, ref bufferBytes, path);
            if (error == ErrorSuccess)
            {
                string value = path.ToString();
                if (!Regex.IsMatch(value, @"^\\\\\.\\PhysicalDrive[0-9]+\z", RegexOptions.CultureInvariant))
                    throw new InvalidOperationException("GetVirtualDiskPhysicalPath returned an unexpected physical path");
                return value;
            }
            if (error != ErrorInsufficientBuffer || attempt != 0 || bufferBytes == 0 || bufferBytes > 65536)
                ThrowIfFailed("GetVirtualDiskPhysicalPath", error);
            bytes = bufferBytes;
        }
        throw new InvalidOperationException("GetVirtualDiskPhysicalPath exhausted its fixed buffer retry");
    }

    private static void RejectReparsePointAncestors(string directory)
    {
        for (string current = directory; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            FileAttributes attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("VHD target has a reparse-point ancestor");
        }
    }

    private static bool IsDiskFull(IOException exception)
    {
        return (unchecked((uint)exception.HResult) & 0xffffU) == ErrorDiskFull;
    }

    private static VolumeSpace ReadVolumeSpace(string volumeGuidRoot)
    {
        ulong available;
        ulong total;
        ulong free;
        if (!GetDiskFreeSpaceEx(volumeGuidRoot, out available, out total, out free))
            throw new NativeOperationException("GetDiskFreeSpaceEx", unchecked((uint)Marshal.GetLastWin32Error()));
        if (available > Int64.MaxValue || total > Int64.MaxValue || free > Int64.MaxValue)
            throw new InvalidOperationException("Volume space exceeds the supported signed range");
        return new VolumeSpace((long)available, (long)total);
    }

    private static void RequireWindowsX64()
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8)
            throw new PlatformNotSupportedException("The disk control requires 64-bit Windows");
    }

    private static void ValidateNativeLayout()
    {
        if (Marshal.SizeOf(typeof(VirtualStorageType)) != 20 ||
            OffsetOf<VirtualStorageType>(nameof(VirtualStorageType.DeviceId)) != 0 ||
            OffsetOf<VirtualStorageType>(nameof(VirtualStorageType.VendorId)) != 4 ||
            Marshal.SizeOf(typeof(CreateVirtualDiskParameters)) != 56 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.Version)) != 0 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.UniqueId)) != 8 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.MaximumSize)) != 24 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.BlockSizeInBytes)) != 32 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.SectorSizeInBytes)) != 36 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.ParentPath)) != 40 ||
            OffsetOf<CreateVirtualDiskParameters>(nameof(CreateVirtualDiskParameters.SourcePath)) != 48 ||
            Marshal.SizeOf(typeof(GetVirtualDiskInfo)) != 32 ||
            OffsetOf<GetVirtualDiskInfo>(nameof(GetVirtualDiskInfo.Version)) != 0 ||
            OffsetOf<GetVirtualDiskInfo>(nameof(GetVirtualDiskInfo.VirtualSize)) != 8 ||
            OffsetOf<GetVirtualDiskInfo>(nameof(GetVirtualDiskInfo.PhysicalSize)) != 16 ||
            OffsetOf<GetVirtualDiskInfo>(nameof(GetVirtualDiskInfo.ProviderSubtype)) != 8)
            throw new InvalidOperationException("virtdisk ABI does not match the required x64 Windows layout");
    }

    private static int OffsetOf<T>(string field)
    {
        return checked((int)Marshal.OffsetOf(typeof(T), field));
    }

    private static void ThrowIfFailed(string operation, uint error)
    {
        if (error != ErrorSuccess)
            throw new NativeOperationException(operation, error);
    }

    private sealed class DiskSize
    {
        internal long VirtualSizeBytes;
        internal long BackingSizeBytes;

        internal DiskSize(long virtualSizeBytes, long backingSizeBytes)
        {
            VirtualSizeBytes = virtualSizeBytes;
            BackingSizeBytes = backingSizeBytes;
        }
    }

    private sealed class VolumeSpace
    {
        internal long AvailableBytes;
        internal long TotalBytes;

        internal VolumeSpace(long availableBytes, long totalBytes)
        {
            AvailableBytes = availableBytes;
            TotalBytes = totalBytes;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct VirtualStorageType
    {
        public uint DeviceId;
        public Guid VendorId;
    }

    // CREATE_VIRTUAL_DISK_PARAMETERS version 1: DWORD followed by an x64-aligned
    // union at byte 8.  This declares only the selected Version1 member.
    [StructLayout(LayoutKind.Explicit, Size = 56)]
    private struct CreateVirtualDiskParameters
    {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(8)] public Guid UniqueId;
        [FieldOffset(24)] public ulong MaximumSize;
        [FieldOffset(32)] public uint BlockSizeInBytes;
        [FieldOffset(36)] public uint SectorSizeInBytes;
        [FieldOffset(40)] public IntPtr ParentPath;
        [FieldOffset(48)] public IntPtr SourcePath;
    }

    // GET_VIRTUAL_DISK_INFO has a DWORD version followed by an x64-aligned union.
    // Size and ProviderSubtype are the only documented union members used here.
    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct GetVirtualDiskInfo
    {
        [FieldOffset(0)] public uint Version;
        [FieldOffset(8)] public ulong VirtualSize;
        [FieldOffset(16)] public ulong PhysicalSize;
        [FieldOffset(24)] public uint BlockSize;
        [FieldOffset(28)] public uint SectorSize;
        [FieldOffset(8)] public uint ProviderSubtype;
    }

    internal sealed class SafeVirtualDiskHandle : SafeHandle
    {
        public SafeVirtualDiskHandle() : base(IntPtr.Zero, true) { }

        internal static SafeVirtualDiskHandle FromSuccessfulCreate(IntPtr nativeHandle)
        {
            if (nativeHandle == IntPtr.Zero || nativeHandle == new IntPtr(-1))
                throw new ArgumentException("A successful virtual-disk create returned an invalid handle", nameof(nativeHandle));
            SafeVirtualDiskHandle safeHandle = new SafeVirtualDiskHandle();
            safeHandle.SetHandle(nativeHandle);
            return safeHandle;
        }

        public override bool IsInvalid
        {
            get { return handle == IntPtr.Zero || handle == new IntPtr(-1); }
        }

        protected override bool ReleaseHandle()
        {
            return CloseHandle(handle);
        }

        internal uint CloseChecked()
        {
            if (IsClosed || IsInvalid)
                return ErrorSuccess;

            bool addedRef = false;
            try
            {
                DangerousAddRef(ref addedRef);
                if (IsInvalid)
                    return ErrorSuccess;
                if (!CloseHandle(handle))
                    return unchecked((uint)Marshal.GetLastWin32Error());
                SetHandleAsInvalid();
                return ErrorSuccess;
            }
            finally
            {
                if (addedRef)
                    DangerousRelease();
            }
        }
    }

    [DllImport("virtdisk.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CreateVirtualDisk(
        ref VirtualStorageType virtualStorageType,
        string path,
        uint virtualDiskAccessMask,
        IntPtr securityDescriptor,
        uint flags,
        uint providerSpecificFlags,
        ref CreateVirtualDiskParameters parameters,
        IntPtr overlapped,
        out IntPtr handle);

    [DllImport("virtdisk.dll", ExactSpelling = true)]
    private static extern uint AttachVirtualDisk(
        SafeVirtualDiskHandle virtualDiskHandle,
        IntPtr securityDescriptor,
        uint flags,
        uint providerSpecificFlags,
        IntPtr parameters,
        IntPtr overlapped);

    [DllImport("virtdisk.dll", ExactSpelling = true)]
    private static extern uint DetachVirtualDisk(
        SafeVirtualDiskHandle virtualDiskHandle,
        uint flags,
        uint providerSpecificFlags);

    [DllImport("virtdisk.dll", ExactSpelling = true)]
    private static extern uint GetVirtualDiskInformation(
        SafeVirtualDiskHandle virtualDiskHandle,
        ref uint virtualDiskInfoSize,
        ref GetVirtualDiskInfo virtualDiskInfo,
        out uint sizeUsed);

    [DllImport("virtdisk.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetVirtualDiskPhysicalPath(
        SafeVirtualDiskHandle virtualDiskHandle,
        ref uint diskPathSizeInBytes,
        StringBuilder diskPath);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", EntryPoint = "GetDiskFreeSpaceExW", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetDiskFreeSpaceEx(
        string directoryName,
        out ulong freeBytesAvailableToCaller,
        out ulong totalNumberOfBytes,
        out ulong totalNumberOfFreeBytes);
}
