// Fixed-purpose Windows node experiment. Derived from the retained decoder supervisor.
// CPU rate scheduling is distinct from exact CPU time. No filesystem/network sandbox.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

public static class NodeProbeProcess {
    public sealed class ApiReply { public int Status; public string Body; public int Bytes; }
    public sealed class StartupReader : IDisposable {
        readonly HttpClient client;
        readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        readonly HashSet<string> attempted = new HashSet<string>();
        public StartupReader() {
            client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false });
            client.Timeout = Timeout.InfiniteTimeSpan;
        }
        public async Task<ApiReply> ReadOnce(string endpoint) {
            if ((endpoint != "/info" && endpoint != "/peers/connected" && endpoint != "/wallet/status") || !attempted.Add(endpoint))
                throw new ArgumentException("Endpoint not allowed or already attempted");
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token)) {
                timeout.CancelAfter(5000); // One deadline covers headers AND the entire body.
                using (var request = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:19053" + endpoint))
                using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)) {
                    if (response.Content.Headers.ContentEncoding.Count != 0) throw new Exception("Encoded API response refused");
                    using (var input = await response.Content.ReadAsStreamAsync(timeout.Token))
                    using (var output = new MemoryStream()) {
                        var buffer = new byte[4096];
                        int count;
                        while ((count = await input.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) != 0) {
                            if (output.Length + count > 1048576) throw new Exception("API response byte budget exceeded");
                            output.Write(buffer, 0, count);
                        }
                        return new ApiReply { Status = (int)response.StatusCode, Bytes = (int)output.Length,
                            Body = new UTF8Encoding(false, true).GetString(output.ToArray()) };
                    }
                }
            }
        }
        public void Dispose() { lifetime.Cancel(); client.Dispose(); lifetime.Dispose(); }
    }
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, uint cls, uint reserved);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr table, ref uint size, bool order, uint family, uint cls, uint reserved);
    public sealed class SocketObservation {
        public string Protocol, LocalAddress, RemoteAddress;
        public uint LocalPort, RemotePort, State;
    }
    static string Address(IntPtr row, int offset, int bytes) {
        var value = new byte[bytes]; Marshal.Copy(IntPtr.Add(row, offset), value, 0, bytes);
        return new IPAddress(value).ToString();
    }
    static uint Port(IntPtr row, int offset) { return (uint)(Marshal.ReadByte(row, offset) * 256 + Marshal.ReadByte(row, offset + 1)); }
    public static SocketObservation[] Sockets(uint processId) {
        var result = new List<SocketObservation>();
        foreach (uint family in new uint[] { 2, 23 }) foreach (bool tcp in new bool[] { true, false }) {
            uint size = 0;
            uint error = tcp ? GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0)
                : GetExtendedUdpTable(IntPtr.Zero, ref size, false, family, 1, 0);
            if (error != 122 || size < 4 || size > 1048576) throw new Exception("Socket table size/query unresolved");
            IntPtr table = Marshal.AllocHGlobal((int)size);
            try {
                uint capacity = size;
                error = tcp ? GetExtendedTcpTable(table, ref size, false, family, 5, 0)
                    : GetExtendedUdpTable(table, ref size, false, family, 1, 0);
                // A concurrent table resize refuses this observation; never read past allocation.
                if (error != 0 || size > capacity) throw new Exception("Socket table snapshot unresolved: " + error);
                int stride = tcp ? (family == 2 ? 24 : 56) : (family == 2 ? 12 : 28);
                uint count = unchecked((uint)Marshal.ReadInt32(table));
                if (count > (capacity - 4) / stride) throw new Exception("Socket table row budget exceeded");
                for (int i = 0; i < count; i++) {
                    IntPtr row = IntPtr.Add(table, 4 + i * stride);
                    uint owner = unchecked((uint)Marshal.ReadInt32(row, stride - 4));
                    if (owner != processId) continue;
                    bool ipv4 = family == 2;
                    result.Add(new SocketObservation { Protocol = tcp ? "tcp" : "udp",
                        LocalAddress = Address(row, tcp && ipv4 ? 4 : 0, ipv4 ? 4 : 16),
                        LocalPort = Port(row, ipv4 ? (tcp ? 8 : 4) : 20),
                        RemoteAddress = tcp ? Address(row, ipv4 ? 12 : 24, ipv4 ? 4 : 16) : null,
                        RemotePort = tcp ? Port(row, ipv4 ? 16 : 44) : 0,
                        State = tcp ? unchecked((uint)Marshal.ReadInt32(row, ipv4 ? 0 : 48)) : 0 });
                    if (result.Count > 64) throw new Exception("Node socket inventory budget exceeded");
                }
            } finally { Marshal.FreeHGlobal(table); }
        }
        return result.ToArray();
    }
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public Basic Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CpuRate { public uint Flags, Rate; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CpuRate info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out CpuRate info, uint size, IntPtr returned);
    [StructLayout(LayoutKind.Sequential)] struct Security {
        public int Length;
        public IntPtr Descriptor;
        public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessMemory {
        public uint Size, PageFaults;
        public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool;
        public UIntPtr PeakNonPagedPool, NonPagedPool, Pagefile, PeakPagefile, Private;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessIds {
        public uint Assigned, Count;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public ulong[] Ids;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {
        public Startup Startup;
        public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, IntPtr name);
    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateNamedJob(IntPtr sa, string name);
    [DllImport("kernel32.dll", EntryPoint = "OpenJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenNamedJob(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref Limits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Limits info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ProcessIds info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr process, ref ProcessMemory info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PeekNamedPipe(IntPtr pipe, IntPtr data, uint size, IntPtr read, out uint available, IntPtr left);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] ids, uint capacity);

    public sealed class Result {
        public string Case, Outcome, Output, LaunchMode;
        public uint ExitCode, CreationFlags;
        public long ElapsedMs, CapturedOutputBytes;
        public ulong PeakCommitBytes, PeakProcessCommitBytes, CommitLimitBytes;
        public ulong BeforeResumePeakCommitBytes, BeforeResumePeakProcessCommitBytes;
        public long UserCpuTicks, KernelCpuTicks;
        public long JobUserCpuTicks, JobKernelCpuTicks; public uint CpuRateFlags, CpuRatePer10000;
        public uint TotalProcesses, ActiveProcessesAfterExit, LimitTerminatedProcesses;
        public uint BeforeResumeTotalProcesses, BeforeResumeActiveProcesses;
        public ulong SampledPeakPrivateCommitBytes, SampledMaxPrivateCommitBytes;
        public ulong BeforeResumePrivateCommitBytes;
        public uint MemorySamples;
        public uint MaxSampledAssociatedProcesses;
        public ProcessObservation[] ObservedProcesses;
        public bool LimitsReadBackBeforeResume, JobEmptyAfterCleanup, ParentConsoleVerified;
        public bool ChildTokenChecked, ChildElevated;
    }
    // Trusted-host lease shared only with the fixed disk owner. The owner must
    // terminate and observe an empty job before removing the node's volume.
    // Holding its handle means parent death alone no longer triggers kill-on-close.
    public sealed class VolumeJob : IDisposable {
        internal IntPtr Handle;
        internal bool Creator;
        internal bool Used;
        internal VolumeJob(IntPtr handle, bool creator) { Handle = handle; Creator = creator; }
        public uint ActiveProcesses {
            get {
                if (Handle == IntPtr.Zero) throw new ObjectDisposedException("VolumeJob");
                Require(QueryInformationJobObject(Handle, 1, out Accounting a, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                return a.ActiveProcesses;
            }
        }
        public void StopAndConfirmEmpty() {
            if (Handle == IntPtr.Zero) throw new ObjectDisposedException("VolumeJob");
            Require(TerminateJobObject(Handle, 0xe0000001));
            var clock = Stopwatch.StartNew();
            while (ActiveProcesses != 0) {
                if (clock.ElapsedMilliseconds > 5000) throw new Exception("Volume job termination unresolved");
                Thread.Sleep(25);
            }
        }
        public void Dispose() {
            if (Handle == IntPtr.Zero) return;
            StopAndConfirmEmpty();
            Require(CloseHandle(Handle)); Handle = IntPtr.Zero;
        }
    }
    static string VolumeJobName(string nonce) {
        if (!Guid.TryParseExact(nonce, "N", out Guid parsed) || parsed == Guid.Empty)
            throw new ArgumentException("Fresh volume run GUID required");
        return "Local\\moe-node-volume-" + nonce;
    }
    public static VolumeJob CreateVolumeJob(string nonce) {
        IntPtr handle = CreateNamedJob(IntPtr.Zero, VolumeJobName(nonce));
        int error = Marshal.GetLastWin32Error();
        Require(handle != IntPtr.Zero);
        if (error == 183) { CloseHandle(handle); throw new Exception("Volume job already exists"); }
        return new VolumeJob(handle, true);
    }
    public static VolumeJob OpenVolumeJob(string nonce) {
        IntPtr handle = OpenNamedJob(0x4 | 0x8, false, VolumeJobName(nonce)); // QUERY | TERMINATE
        Require(handle != IntPtr.Zero);
        return new VolumeJob(handle, false);
    }
    public static Result RunOnVolumeJob(VolumeJob lease, string executable, string[] arguments, string directory, Func<uint, long, bool> observe) {
        if (lease == null || !lease.Creator || lease.Used || lease.Handle == IntPtr.Zero || lease.ActiveProcesses != 0)
            throw new ArgumentException("Fresh creator volume job required");
        lease.Used = true;
        return RunCore(executable, arguments, directory, "offline-volume-node", 4294967296UL, 120000, 15728640, observe, false, lease.Handle);
    }
    public sealed class ProcessObservation {
        public uint ProcessId;
        public string Image;
        public int QueryError;
    }
    static uint ObserveProcesses(IntPtr job, Dictionary<uint, ProcessObservation> observed) {
        Require(QueryInformationJobObject(job, 3, out ProcessIds ids, (uint)Marshal.SizeOf<ProcessIds>(), IntPtr.Zero));
        if (ids.Count > 16) throw new Exception("Process inventory exceeds fixed diagnostic budget");
        for (int i = 0; i < ids.Count; i++) {
            uint id = checked((uint)ids.Ids[i]);
            if (observed.ContainsKey(id)) continue;
            if (observed.Count == 16) throw new Exception("Process history exceeds fixed diagnostic budget");
            var item = new ProcessObservation { ProcessId = id };
            IntPtr handle = OpenProcess(0x1000, false, id); // QUERY_LIMITED_INFORMATION
            if (handle == IntPtr.Zero) item.QueryError = Marshal.GetLastWin32Error();
            else {
                try {
                    Require(IsProcessInJob(handle, job, out bool member));
                    if (!member) { item.QueryError = 1168; observed.Add(id, item); continue; }
                    var path = new StringBuilder(1024);
                    uint length = 1024;
                    if (QueryFullProcessImageNameW(handle, 0, path, ref length)) item.Image = path.ToString();
                    else item.QueryError = Marshal.GetLastWin32Error();
                } finally { CloseHandle(handle); }
            }
            observed.Add(id, item);
        }
        return ids.Count;
    }
    static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string arg) {
        // Only fixed local executable/script paths and case names are accepted.
        if (arg.Contains("\"") || arg.EndsWith("\\") || arg.Contains("\n") || arg.Contains("\r"))
            throw new ArgumentException("Unsupported fixed argument");
        return "\"" + arg + "\"";
    }
    public static Result Run(string executable, string[] arguments, string directory, string name, ulong memory, uint wallMs, uint outputBytes, Func<uint, long, bool> observe) {
        return RunCore(executable, arguments, directory, name, memory, wallMs, outputBytes, observe, false);
    }
    // Only for the trusted offline disk worker: PowerShell ConsoleHost requires a console.
    // No console is allocated/attached or reconfigured. Shared console lifetime/control
    // and its existing host's resources remain outside this worker's Job Object.
    public static void RequireExistingConsole() {
        var ids = new uint[256];
        uint count = GetConsoleProcessList(ids, (uint)ids.Length);
        if (count == 0 || count > ids.Length) throw new Exception("Existing parent console unresolved");
        uint parent;
        using (var current = Process.GetCurrentProcess()) parent = checked((uint)current.Id);
        for (int i = 0; i < count; i++) if (ids[i] == parent) return;
        throw new Exception("Parent missing from existing console");
    }
    public static Result RunWithInheritedConsole(string executable, string[] arguments, string directory, string name, ulong memory, uint wallMs, uint outputBytes, Func<uint, long, bool> observe) {
        RequireExistingConsole();
        return RunCore(executable, arguments, directory, name, memory, wallMs, outputBytes, observe, true);
    }
    static Result RunCore(string executable, string[] arguments, string directory, string name, ulong memory, uint wallMs, uint outputBytes, Func<uint, long, bool> observe, bool inheritConsole, IntPtr volumeJob = default(IntPtr)) {
        if (IntPtr.Size != 8 || wallMs == 0 || wallMs > 120000 || outputBytes == 0 || outputBytes > 16777216 || memory < 268435456UL || memory > 4294967296UL)
            throw new ArgumentException("Requires x64 and finite budgets");
        // Suspended, explicit Unicode environment and creation-time job assignment.
        // All existing callers retain DETACHED_PROCESS; the fixed disk worker can
        // inherit a verified existing console without requesting another conhost.
        string launchMode = inheritConsole ? "inherited-console" : "detached";
        uint creationFlags = 0x4U | 0x80000U | 0x400U | (inheritConsole ? 0U : 0x8U);
        const uint flags = 0x8 | 0x100 | 0x200 | 0x400 | 0x2000;
        IntPtr job = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero, input = IntPtr.Zero;
        IntPtr list = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, environment = IntPtr.Zero;
        bool listReady = false, assigned = false;
        ProcessInfo child = new ProcessInfo();
        Result result = null;
        try {
            if (volumeJob == IntPtr.Zero) { job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); Require(job != IntPtr.Zero); }
            else Require(DuplicateHandle(GetCurrentProcess(), volumeJob, GetCurrentProcess(), out job, 0, false, 2));
            var limits = new Limits { Basic = new Basic { Flags = flags, ActiveProcesses = 1 },
                ProcessMemory = new UIntPtr(memory), JobMemory = new UIntPtr(memory) };
            uint size = (uint)Marshal.SizeOf<Limits>();
            Require(SetInformationJobObject(job, 9, ref limits, size));
            var cpu = new CpuRate { Flags = 0x1 | 0x4, Rate = 2500 };
            uint cpuSize = (uint)Marshal.SizeOf<CpuRate>();
            Require(SetInformationJobObject(job, 15, ref cpu, cpuSize));
            var security = new Security { Length = Marshal.SizeOf<Security>(), Inherit = 1 };
            Require(CreatePipe(out read, out write, ref security, 4096));
            Require(SetHandleInformation(read, 1, 0));
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Require(input != new IntPtr(-1));
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            Require(bytes != IntPtr.Zero);
            list = Marshal.AllocHGlobal(bytes);
            Require(InitializeProcThreadAttributeList(list, 2, 0, ref bytes)); listReady = true;
            handles = Marshal.AllocHGlobal(2 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, write);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: inherit only NUL and the output pipe.
            Require(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            // PROC_THREAD_ATTRIBUTE_JOB_LIST: join at creation, avoiding a
            // suspended orphan if the supervisor dies before explicit assignment.
            Require(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupEx { Startup = new Startup { Size = Marshal.SizeOf<StartupEx>(),
                Flags = 0x100, Input = input, Output = write, Error = write }, Attributes = list };
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(" ").Append(Quote(argument));
            // No PATH, Java/Node injection options, proxy variables or inherited credentials.
            string systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
            if (string.IsNullOrEmpty(systemRoot)) throw new Exception("Missing SystemRoot");
            environment = Marshal.StringToHGlobalUni("SystemRoot=" + systemRoot + "\0TEMP=" + directory + "\0TMP=" + directory + "\0USERPROFILE=" + directory + "\0\0");
            Require(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, creationFlags,
                environment, directory, ref startup, out child));
            assigned = true;
            if (volumeJob != IntPtr.Zero) {
                Require(OpenProcessToken(child.Process, 0x8, out IntPtr token));
                try {
                    Require(GetTokenInformation(token, 20, out int elevated, 4, out int returned));
                    if (returned != 4 || elevated != 0) throw new Exception("Volume node must have an ordinary token");
                } finally { CloseHandle(token); }
            }
            Require(IsProcessInJob(child.Process, job, out bool member));
            if (!member) throw new Exception("Child not in configured job");
            Require(QueryInformationJobObject(job, 9, out Limits installed, size, IntPtr.Zero));
            if (installed.Basic.Flags != flags || installed.Basic.JobTime != 0 ||
                installed.Basic.ActiveProcesses != 1 || installed.ProcessMemory.ToUInt64() != memory ||
                installed.JobMemory.ToUInt64() != memory) throw new Exception("Job limits not installed");
            Require(QueryInformationJobObject(job, 15, out CpuRate installedCpu, cpuSize, IntPtr.Zero));
            if (installedCpu.Flags != cpu.Flags || installedCpu.Rate != cpu.Rate) throw new Exception("CPU rate not installed");
            uint memorySize = (uint)Marshal.SizeOf<ProcessMemory>();
            var initialMemory = new ProcessMemory { Size = memorySize };
            Require(GetProcessMemoryInfo(child.Process, ref initialMemory, memorySize));
            Require(QueryInformationJobObject(job, 1, out Accounting initialAccounting,
                (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
            ulong peakPrivate = initialMemory.PeakPagefile.ToUInt64();
            ulong maxPrivate = initialMemory.Private.ToUInt64();
            uint memorySamples = 1;
            var observed = new Dictionary<uint, ProcessObservation>();
            uint maxActive = ObserveProcesses(job, observed);
            CloseHandle(write); write = IntPtr.Zero;
            var clock = Stopwatch.StartNew();
            Require(ResumeThread(child.Thread) != uint.MaxValue);
            var output = new MemoryStream();
            byte[] buffer = new byte[4096];
            string outcome = "exited"; long nextObservation = 0;
            while (true) {
                if (clock.ElapsedMilliseconds >= wallMs) { outcome = "wall-limit"; break; }
                maxActive = Math.Max(maxActive, ObserveProcesses(job, observed));
                if (observe != null && clock.ElapsedMilliseconds >= nextObservation) {
                    nextObservation = clock.ElapsedMilliseconds + 250;
                    if (observe(child.ProcessId, output.Length)) { outcome = "observer-complete"; break; }
                }
                var sample = new ProcessMemory { Size = memorySize };
                if (GetProcessMemoryInfo(child.Process, ref sample, memorySize)) {
                    peakPrivate = Math.Max(peakPrivate, sample.PeakPagefile.ToUInt64());
                    maxPrivate = Math.Max(maxPrivate, sample.Private.ToUInt64());
                    memorySamples++;
                } else {
                    // Exit can race the sample. Other telemetry failures are fatal.
                    int error = Marshal.GetLastWin32Error();
                    if (WaitForSingleObject(child.Process, 0) != 0) throw new Win32Exception(error);
                }
                bool peek = PeekNamedPipe(read, IntPtr.Zero, 0, IntPtr.Zero, out uint available, IntPtr.Zero);
                if (!peek && Marshal.GetLastWin32Error() != 109) Require(false);
                if (peek && available > 0) {
                    uint count = Math.Min(available, (uint)buffer.Length);
                    Require(ReadFile(read, buffer, count, out uint got, IntPtr.Zero));
                    if (output.Length + got > outputBytes) { outcome = "output-limit"; break; }
                    output.Write(buffer, 0, (int)got);
                    continue;
                }
                uint wait = WaitForSingleObject(child.Process, 5);
                if (wait == 0) {
                    // Drain once more after exit; no descendant may retain the pipe.
                    peek = PeekNamedPipe(read, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero);
                    if (!peek && Marshal.GetLastWin32Error() != 109) Require(false);
                    if (!peek || available == 0) break;
                } else if (wait != 258) Require(false);
            }
            if (outcome != "exited") Require(TerminateJobObject(job, 0xE0000001));
            if (WaitForSingleObject(child.Process, 5000) != 0) throw new Exception("Child termination unresolved");
            Require(GetExitCodeProcess(child.Process, out uint exit));
            Require(GetProcessTimes(child.Process, out var created, out var ended, out var kernel, out var user));
            Require(QueryInformationJobObject(job, 9, out Limits measured, size, IntPtr.Zero));
            Require(QueryInformationJobObject(job, 1, out Accounting accounting,
                (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
            result = new Result { Case = name, Outcome = outcome, ExitCode = exit, ElapsedMs = clock.ElapsedMilliseconds,
                ChildTokenChecked = volumeJob != IntPtr.Zero, ChildElevated = false,
                LaunchMode = launchMode, CreationFlags = creationFlags, ParentConsoleVerified = inheritConsole,
                PeakCommitBytes = measured.PeakJobMemory.ToUInt64(),
                PeakProcessCommitBytes = measured.PeakProcessMemory.ToUInt64(), CommitLimitBytes = memory,
                BeforeResumePeakCommitBytes = installed.PeakJobMemory.ToUInt64(),
                BeforeResumePeakProcessCommitBytes = installed.PeakProcessMemory.ToUInt64(),
                UserCpuTicks = user, KernelCpuTicks = kernel,
                CpuRateFlags = installedCpu.Flags, CpuRatePer10000 = installedCpu.Rate,
                JobUserCpuTicks = accounting.User, JobKernelCpuTicks = accounting.Kernel,
                TotalProcesses = accounting.TotalProcesses, ActiveProcessesAfterExit = accounting.ActiveProcesses,
                BeforeResumeTotalProcesses = initialAccounting.TotalProcesses,
                BeforeResumeActiveProcesses = initialAccounting.ActiveProcesses,
                LimitTerminatedProcesses = accounting.TerminatedProcesses,
                BeforeResumePrivateCommitBytes = initialMemory.Private.ToUInt64(),
                SampledPeakPrivateCommitBytes = peakPrivate, SampledMaxPrivateCommitBytes = maxPrivate,
                MemorySamples = memorySamples,
                MaxSampledAssociatedProcesses = maxActive,
                ObservedProcesses = new List<ProcessObservation>(observed.Values).ToArray(),
                LimitsReadBackBeforeResume = true,
                CapturedOutputBytes = output.Length, Output = Encoding.UTF8.GetString(output.ToArray()) };
            return result;
        } finally {
            // Failure before assignment must also kill the still-suspended process.
            bool cleanupUnresolved = false;
            if (child.Process != IntPtr.Zero) {
                if (assigned) TerminateJobObject(job, 0xE0000002);
                // Also cover an unexpected failed/false membership readback.
                TerminateProcess(child.Process, 0xE0000002);
                cleanupUnresolved = WaitForSingleObject(child.Process, 5000) != 0;
                // Console helpers can outlive the target. Verify the whole job,
                // not just the handle of the process we explicitly created.
                if (assigned) {
                    var cleanupClock = Stopwatch.StartNew();
                    while (true) {
                        if (!QueryInformationJobObject(job, 1, out Accounting remaining,
                            (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero)) {
                            cleanupUnresolved = true; break;
                        }
                        if (remaining.ActiveProcesses == 0) {
                            if (result != null) {
                                result.JobEmptyAfterCleanup = true;
                                result.JobUserCpuTicks = remaining.User;
                                result.JobKernelCpuTicks = remaining.Kernel;
                                result.TotalProcesses = remaining.TotalProcesses;
                                result.LimitTerminatedProcesses = remaining.TerminatedProcesses;
                            }
                            break;
                        }
                        if (cleanupClock.ElapsedMilliseconds >= 5000) { cleanupUnresolved = true; break; }
                        System.Threading.Thread.Sleep(5);
                    }
                }
            }
            foreach (var handle in new[] { child.Thread, child.Process, read, write, input, job })
                if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
            if (listReady) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (cleanupUnresolved) throw new Exception("Cleanup termination unresolved");
        }
    }
}
