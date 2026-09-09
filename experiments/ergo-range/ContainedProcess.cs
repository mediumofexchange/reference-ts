// Windows-only fixed-corpus experiment, not a sandbox for untrusted programs.
// Configured job limits are measured here; hard containment remains unproven.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Collections.Generic;

public static class ContainedProcess {
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

    public sealed class Result {
        public string Case, Outcome, Output;
        public uint ExitCode;
        public long ElapsedMs;
        public ulong PeakCommitBytes, PeakProcessCommitBytes, CommitLimitBytes;
        public ulong BeforeResumePeakCommitBytes, BeforeResumePeakProcessCommitBytes;
        public long UserCpuTicks, KernelCpuTicks;
        public long UserCpuLimitTicks, JobUserCpuTicks, JobKernelCpuTicks;
        public uint TotalProcesses, ActiveProcessesAfterExit, LimitTerminatedProcesses;
        public uint BeforeResumeTotalProcesses, BeforeResumeActiveProcesses;
        public ulong SampledPeakPrivateCommitBytes, SampledMaxPrivateCommitBytes;
        public ulong BeforeResumePrivateCommitBytes;
        public uint MemorySamples;
        public uint MaxSampledAssociatedProcesses;
        public ProcessObservation[] ObservedProcesses;
        public bool LimitsReadBackBeforeResume, JobEmptyAfterCleanup;
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
    public static Result Run(string node, string worker, string name, uint cpuMs, uint wallMs, uint outputBytes) {
        if (IntPtr.Size != 8 || cpuMs == 0 || wallMs == 0 || outputBytes == 0 || outputBytes > 1048576)
            throw new ArgumentException("Requires x64 and finite budgets");
        const ulong memory = 256UL * 1024 * 1024;
        // JOB_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | JOB_MEMORY |
        // DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE. No breakaway flags.
        const uint flags = 0x4 | 0x8 | 0x100 | 0x200 | 0x400 | 0x2000;
        IntPtr job = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero, input = IntPtr.Zero;
        IntPtr list = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero;
        bool listReady = false, assigned = false;
        ProcessInfo child = new ProcessInfo();
        Result result = null;
        try {
            job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero); Require(job != IntPtr.Zero);
            var limits = new Limits { Basic = new Basic { Flags = flags, JobTime = cpuMs * 10000L, ActiveProcesses = 1 },
                ProcessMemory = new UIntPtr(memory), JobMemory = new UIntPtr(memory) };
            uint size = (uint)Marshal.SizeOf<Limits>();
            Require(SetInformationJobObject(job, 9, ref limits, size));
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
            var command = new StringBuilder(Quote(node) + " " + Quote(worker) + " " + Quote(name));
            // CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT.
            Require(CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000 | 0x80000,
                IntPtr.Zero, Path.GetDirectoryName(worker), ref startup, out child));
            assigned = true;
            Require(IsProcessInJob(child.Process, job, out bool member));
            if (!member) throw new Exception("Child not in configured job");
            Require(QueryInformationJobObject(job, 9, out Limits installed, size, IntPtr.Zero));
            if (installed.Basic.Flags != flags || installed.Basic.JobTime != cpuMs * 10000L ||
                installed.Basic.ActiveProcesses != 1 || installed.ProcessMemory.ToUInt64() != memory ||
                installed.JobMemory.ToUInt64() != memory) throw new Exception("Job limits not installed");
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
            string outcome = "exited";
            while (true) {
                if (clock.ElapsedMilliseconds >= wallMs) { outcome = "wall-limit"; break; }
                maxActive = Math.Max(maxActive, ObserveProcesses(job, observed));
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
                PeakCommitBytes = measured.PeakJobMemory.ToUInt64(),
                PeakProcessCommitBytes = measured.PeakProcessMemory.ToUInt64(), CommitLimitBytes = memory,
                BeforeResumePeakCommitBytes = installed.PeakJobMemory.ToUInt64(),
                BeforeResumePeakProcessCommitBytes = installed.PeakProcessMemory.ToUInt64(),
                UserCpuTicks = user, KernelCpuTicks = kernel,
                UserCpuLimitTicks = cpuMs * 10000L,
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
                Output = outcome == "exited" && exit == 0 ? Encoding.UTF8.GetString(output.ToArray()) : "" };
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
            if (cleanupUnresolved) throw new Exception("Cleanup termination unresolved");
        }
    }
}
