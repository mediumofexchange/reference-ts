// Fixed-purpose Windows host-interface sampler for the bounded node experiment.
// It measures successful host-interface octets, not a process or physical-wire quota.
// Sampling cannot detect a counter reset or interface change that regrows to the
// same identity and counter values between two observations.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class NodeTrafficCounter
{
    public sealed class Row
    {
        public string Id { get; }
        public int Type { get; }
        public int Status { get; }
        public ulong Received { get; }
        public ulong Sent { get; }
        public ulong ReceiveErrors { get; }
        public ulong SendErrors { get; }
        public ulong ReceiveDiscards { get; }
        public ulong SendDiscards { get; }

        public Row(
            string id,
            int type,
            int status,
            ulong received,
            ulong sent,
            ulong receiveErrors,
            ulong sendErrors,
            ulong receiveDiscards,
            ulong sendDiscards)
        {
            Id = id;
            Type = type;
            Status = status;
            Received = received;
            Sent = sent;
            ReceiveErrors = receiveErrors;
            SendErrors = sendErrors;
            ReceiveDiscards = receiveDiscards;
            SendDiscards = sendDiscards;
        }

        internal Row Copy()
        {
            return new Row(
                Id, Type, Status, Received, Sent,
                ReceiveErrors, SendErrors, ReceiveDiscards, SendDiscards);
        }
    }

    public sealed class Sample
    {
        private readonly Row[] rows;

        public long StartedMs { get; }
        public long FinishedMs { get; }
        public Row[] Rows { get { return CopyRows(rows); } }

        public Sample(long startedMs, long finishedMs, Row[] rows)
        {
            StartedMs = startedMs;
            FinishedMs = finishedMs;
            this.rows = CopyRows(rows);
        }

        private static Row[] CopyRows(Row[] source)
        {
            if (source == null)
                return null;

            var copy = new Row[source.Length];
            for (int i = 0; i < source.Length; i++)
                copy[i] = source[i] == null ? null : source[i].Copy();
            return copy;
        }
    }

    public sealed class Accumulator
    {
        private readonly ulong triggerBytes;
        private Dictionary<string, Row> previous;
        private long previousStartedMs;
        private long previousFinishedMs;

        public ulong ReceivedBytes { get; private set; }
        public ulong SentBytes { get; private set; }
        public ulong TotalBytes { get; private set; }
        public string StopReason { get; private set; }
        public long FirstStopMs { get; private set; }
        public bool AccountingValid { get; private set; }
        public long LastSampleMs { get; private set; }
        public long MaxGapMs { get; }
        public long MaxGapMsObserved { get; private set; }

        public Accumulator(Sample baseline, ulong triggerBytes, long maxGapMs = 1000)
        {
            if (maxGapMs <= 0)
                throw new ArgumentOutOfRangeException(nameof(maxGapMs));

            string error;
            Dictionary<string, Row> rows;
            if (!TrySnapshot(baseline, out rows, out error))
                throw new ArgumentException("Invalid baseline: " + error, nameof(baseline));

            long duration = baseline.FinishedMs - baseline.StartedMs;
            if (duration > maxGapMs)
                throw new ArgumentException("Baseline sampling duration exceeds maximum gap", nameof(baseline));

            this.triggerBytes = triggerBytes;
            previous = rows;
            previousStartedMs = baseline.StartedMs;
            previousFinishedMs = baseline.FinishedMs;
            AccountingValid = true;
            FirstStopMs = -1;
            LastSampleMs = baseline.FinishedMs;
            MaxGapMs = maxGapMs;
            MaxGapMsObserved = duration;

            if (triggerBytes == 0)
                Stop("traffic-threshold", baseline.FinishedMs);
        }

        public bool Observe(Sample sample)
        {
            if (!AccountingValid)
                return true;

            string error;
            Dictionary<string, Row> current;
            if (!TrySnapshot(sample, out current, out error))
            {
                Invalidate("invalid-sample", StopTime(sample));
                return true;
            }

            if (sample.StartedMs < previousFinishedMs)
            {
                Invalidate("invalid-timestamps", sample.FinishedMs);
                return true;
            }

            long observedGap = sample.FinishedMs - previousStartedMs;
            if (observedGap > MaxGapMsObserved)
                MaxGapMsObserved = observedGap;
            if (observedGap > MaxGapMs)
            {
                Invalidate("sample-gap", sample.FinishedMs);
                return true;
            }

            if (current.Count != previous.Count)
            {
                Invalidate("interface-change", sample.FinishedMs);
                return true;
            }

            ulong receivedDelta = 0;
            ulong sentDelta = 0;
            try
            {
                foreach (KeyValuePair<string, Row> pair in current)
                {
                    Row prior;
                    if (!previous.TryGetValue(pair.Key, out prior))
                    {
                        Invalidate("interface-change", sample.FinishedMs);
                        return true;
                    }

                    Row next = pair.Value;
                    if (next.Type != prior.Type || next.Status != prior.Status)
                    {
                        Invalidate("interface-change", sample.FinishedMs);
                        return true;
                    }
                    if (next.Received < prior.Received || next.Sent < prior.Sent ||
                        next.ReceiveErrors < prior.ReceiveErrors || next.SendErrors < prior.SendErrors ||
                        next.ReceiveDiscards < prior.ReceiveDiscards || next.SendDiscards < prior.SendDiscards)
                    {
                        Invalidate("counter-reset", sample.FinishedMs);
                        return true;
                    }
                    if (next.ReceiveErrors != prior.ReceiveErrors || next.SendErrors != prior.SendErrors ||
                        next.ReceiveDiscards != prior.ReceiveDiscards || next.SendDiscards != prior.SendDiscards)
                    {
                        Invalidate("interface-errors", sample.FinishedMs);
                        return true;
                    }

                    checked
                    {
                        receivedDelta += next.Received - prior.Received;
                        sentDelta += next.Sent - prior.Sent;
                    }
                }

                ulong received;
                ulong sent;
                ulong total;
                checked
                {
                    received = ReceivedBytes + receivedDelta;
                    sent = SentBytes + sentDelta;
                    total = received + sent;
                }

                // Commit the complete sample only after every row and sum is valid.
                ReceivedBytes = received;
                SentBytes = sent;
                TotalBytes = total;
            }
            catch (OverflowException)
            {
                Invalidate("counter-overflow", sample.FinishedMs);
                return true;
            }

            previous = current;
            previousStartedMs = sample.StartedMs;
            previousFinishedMs = sample.FinishedMs;
            LastSampleMs = sample.FinishedMs;

            if (TotalBytes >= triggerBytes)
                Stop("traffic-threshold", sample.FinishedMs);
            return StopReason != null;
        }

        private void Invalidate(string reason, long atMs)
        {
            AccountingValid = false;
            Stop(reason, atMs);
        }

        private void Stop(string reason, long atMs)
        {
            if (StopReason != null)
                return;
            StopReason = reason;
            FirstStopMs = atMs < LastSampleMs ? LastSampleMs : atMs;
        }

        private long StopTime(Sample sample)
        {
            if (sample == null || sample.FinishedMs < 0)
                return LastSampleMs;
            return sample.FinishedMs;
        }
    }

    public static Sample Read(Stopwatch clock)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows host-interface counters are required");
        if (clock == null || !clock.IsRunning)
            throw new ArgumentException("A running monotonic clock is required", nameof(clock));
        ValidateNativeLayout();

        long startedMs = clock.ElapsedMilliseconds;
        IntPtr table = IntPtr.Zero;
        Row[] rows;
        try
        {
            uint result = GetIfTable2(out table);
            if (result != 0)
                throw new Win32Exception(unchecked((int)result), "GetIfTable2 failed");
            if (table == IntPtr.Zero)
                throw new InvalidOperationException("GetIfTable2 returned no table");

            uint count = unchecked((uint)Marshal.ReadInt32(table));
            if (count == 0 || count > 256)
                throw new InvalidOperationException("Host-interface inventory is empty or exceeds 256 rows");

            rows = new Row[count];
            var ids = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < rows.Length; i++)
            {
                int offset = checked(TableRowOffset + i * NativeRowSize);
                MibIfRow2 item = Marshal.PtrToStructure<MibIfRow2>(IntPtr.Add(table, offset));
                if (item.InterfaceLuid == 0 || item.InterfaceIndex == 0)
                    throw new InvalidOperationException("Host interface has a zero LUID or index");
                if (item.Type > Int32.MaxValue || item.OperStatus > Int32.MaxValue)
                    throw new InvalidOperationException("Host-interface type or status exceeds the public range");

                string id = "luid:" + item.InterfaceLuid.ToString("X16", CultureInfo.InvariantCulture) +
                    "|guid:" + item.InterfaceGuid.ToString("D") +
                    "|index:" + item.InterfaceIndex.ToString(CultureInfo.InvariantCulture);
                if (!ids.Add(id))
                    throw new InvalidOperationException("Host-interface identifier is not unique");

                rows[i] = new Row(
                    id,
                    (int)item.Type,
                    (int)item.OperStatus,
                    item.InOctets,
                    item.OutOctets,
                    item.InErrors,
                    item.OutErrors,
                    item.InDiscards,
                    item.OutDiscards);
            }
        }
        finally
        {
            if (table != IntPtr.Zero)
                FreeMibTable(table);
        }
        long finishedMs = clock.ElapsedMilliseconds;
        if (startedMs < 0 || finishedMs < startedMs)
            throw new InvalidOperationException("Monotonic clock produced invalid timestamps");
        return new Sample(startedMs, finishedMs, rows);
    }

    private const int TableRowOffset = 8;
    private const int NativeRowSize = 1352;

    [DllImport("iphlpapi.dll")]
    private static extern uint GetIfTable2(out IntPtr table);

    [DllImport("iphlpapi.dll")]
    private static extern void FreeMibTable(IntPtr memory);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MibIfRow2
    {
        public ulong InterfaceLuid;
        public uint InterfaceIndex;
        public Guid InterfaceGuid;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] public string Alias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] public string Description;
        public uint PhysicalAddressLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32, ArraySubType = UnmanagedType.U1)] public byte[] PhysicalAddress;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32, ArraySubType = UnmanagedType.U1)] public byte[] PermanentPhysicalAddress;
        public uint Mtu;
        public uint Type;
        public uint TunnelType;
        public uint MediaType;
        public uint PhysicalMediumType;
        public uint AccessType;
        public uint DirectionType;
        public byte InterfaceAndOperStatusFlags;
        public uint OperStatus;
        public uint AdminStatus;
        public uint MediaConnectState;
        public Guid NetworkGuid;
        public uint ConnectionType;
        public ulong TransmitLinkSpeed;
        public ulong ReceiveLinkSpeed;
        public ulong InOctets;
        public ulong InUcastPkts;
        public ulong InNUcastPkts;
        public ulong InDiscards;
        public ulong InErrors;
        public ulong InUnknownProtos;
        public ulong InUcastOctets;
        public ulong InMulticastOctets;
        public ulong InBroadcastOctets;
        public ulong OutOctets;
        public ulong OutUcastPkts;
        public ulong OutNUcastPkts;
        public ulong OutDiscards;
        public ulong OutErrors;
        public ulong OutUcastOctets;
        public ulong OutMulticastOctets;
        public ulong OutBroadcastOctets;
        public ulong OutQLen;
    }

    private static void ValidateNativeLayout()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<MibIfRow2>() != NativeRowSize ||
            OffsetOf(nameof(MibIfRow2.InterfaceIndex)) != 8 ||
            OffsetOf(nameof(MibIfRow2.InterfaceGuid)) != 12 ||
            OffsetOf(nameof(MibIfRow2.Alias)) != 28 ||
            OffsetOf(nameof(MibIfRow2.Description)) != 542 ||
            OffsetOf(nameof(MibIfRow2.PhysicalAddressLength)) != 1056 ||
            OffsetOf(nameof(MibIfRow2.PhysicalAddress)) != 1060 ||
            OffsetOf(nameof(MibIfRow2.PermanentPhysicalAddress)) != 1092 ||
            OffsetOf(nameof(MibIfRow2.Mtu)) != 1124 ||
            OffsetOf(nameof(MibIfRow2.InterfaceAndOperStatusFlags)) != 1152 ||
            OffsetOf(nameof(MibIfRow2.OperStatus)) != 1156 ||
            OffsetOf(nameof(MibIfRow2.NetworkGuid)) != 1168 ||
            OffsetOf(nameof(MibIfRow2.ConnectionType)) != 1184 ||
            OffsetOf(nameof(MibIfRow2.TransmitLinkSpeed)) != 1192 ||
            OffsetOf(nameof(MibIfRow2.InOctets)) != 1208 ||
            OffsetOf(nameof(MibIfRow2.OutOctets)) != 1280 ||
            OffsetOf(nameof(MibIfRow2.OutQLen)) != 1344)
            throw new InvalidOperationException("MIB_IF_ROW2 ABI does not match the required x64 Windows layout");
    }

    private static int OffsetOf(string field)
    {
        return checked((int)Marshal.OffsetOf<MibIfRow2>(field));
    }

    private static bool TrySnapshot(
        Sample sample,
        out Dictionary<string, Row> rows,
        out string error)
    {
        rows = null;
        error = null;
        if (sample == null)
        {
            error = "sample is null";
            return false;
        }
        if (sample.StartedMs < 0 || sample.FinishedMs < sample.StartedMs)
        {
            error = "timestamps are not nonnegative and ordered";
            return false;
        }

        Row[] source = sample.Rows;
        if (source == null || source.Length == 0 || source.Length > 256)
        {
            error = "row count is outside 1..256";
            return false;
        }

        var copy = new Dictionary<string, Row>(source.Length, StringComparer.Ordinal);
        for (int i = 0; i < source.Length; i++)
        {
            Row row = source[i];
            if (row == null || String.IsNullOrWhiteSpace(row.Id))
            {
                error = "row or row identifier is empty";
                return false;
            }
            Row immutable = row.Copy();
            if (!copy.TryAdd(immutable.Id, immutable))
            {
                error = "row identifier is duplicated";
                return false;
            }
        }
        rows = copy;
        return true;
    }
}
