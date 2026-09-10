// Fixed-purpose Windows host-interface sampler for the bounded node experiment.
// It measures successful host-interface octets, not a process or physical-wire quota.
// Sampling cannot detect a counter reset or interface change that regrows to the
// same identity and counter values between two observations.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;

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

        long startedMs = clock.ElapsedMilliseconds;
        NetworkInterface[] interfaces = NetworkInterface.GetAllNetworkInterfaces();
        if (interfaces.Length == 0 || interfaces.Length > 256)
            throw new InvalidOperationException("Host-interface inventory is empty or exceeds 256 rows");

        var rows = new Row[interfaces.Length];
        var ids = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < interfaces.Length; i++)
        {
            NetworkInterface item = interfaces[i];
            string rawId = item.Id;
            if (String.IsNullOrWhiteSpace(rawId))
                throw new InvalidOperationException("Host interface has no stable identifier");

            IPInterfaceProperties properties = item.GetIPProperties();
            int ipv4Index = 0;
            int ipv6Index = 0;
            if (!item.Supports(NetworkInterfaceComponent.IPv4))
                throw new InvalidOperationException("Host interface has no IPv4 index for GetIPStatistics");
            IPv4InterfaceProperties ipv4 = properties.GetIPv4Properties();
            if (ipv4 == null || ipv4.Index <= 0)
                throw new InvalidOperationException("Host interface has an invalid IPv4 index for GetIPStatistics");
            ipv4Index = ipv4.Index;
            if (item.Supports(NetworkInterfaceComponent.IPv6))
            {
                IPv6InterfaceProperties ipv6 = properties.GetIPv6Properties();
                if (ipv6 == null || ipv6.Index <= 0)
                    throw new InvalidOperationException("Host interface has an invalid IPv6 index");
                ipv6Index = ipv6.Index;
            }
            string id = rawId.Length.ToString(CultureInfo.InvariantCulture) + ":" + rawId +
                "|v4:" + ipv4Index.ToString(CultureInfo.InvariantCulture) +
                "|v6:" + (ipv6Index == 0 ? "-" : ipv6Index.ToString(CultureInfo.InvariantCulture));
            if (!ids.Add(id))
                throw new InvalidOperationException("Host-interface identifier is not unique");

            IPInterfaceStatistics stats = item.GetIPStatistics();
            rows[i] = new Row(
                id,
                (int)item.NetworkInterfaceType,
                (int)item.OperationalStatus,
                Unsigned(stats.BytesReceived, "BytesReceived"),
                Unsigned(stats.BytesSent, "BytesSent"),
                Unsigned(stats.IncomingPacketsWithErrors, "IncomingPacketsWithErrors"),
                Unsigned(stats.OutgoingPacketsWithErrors, "OutgoingPacketsWithErrors"),
                Unsigned(stats.IncomingPacketsDiscarded, "IncomingPacketsDiscarded"),
                Unsigned(stats.OutgoingPacketsDiscarded, "OutgoingPacketsDiscarded"));
        }
        long finishedMs = clock.ElapsedMilliseconds;
        if (startedMs < 0 || finishedMs < startedMs)
            throw new InvalidOperationException("Monotonic clock produced invalid timestamps");
        return new Sample(startedMs, finishedMs, rows);
    }

    private static ulong Unsigned(long value, string name)
    {
        if (value < 0)
            throw new InvalidOperationException(name + " exceeded the signed public API range");
        return checked((ulong)value);
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
