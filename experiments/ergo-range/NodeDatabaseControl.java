// Offline RocksDB control, never an Ergo node. The trusted supervisor owns the
// fresh fixed volume, mapping checks, JVM roots, job limits and final accounting.
// API references are pinned to facebook/rocksdb v10.2.1: RocksDB.java (explicit
// directory loadLibrary and closeE), Status.java and port/win/io_win.h (NoSpace).
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import org.rocksdb.CompressionType;
import org.rocksdb.FlushOptions;
import org.rocksdb.Options;
import org.rocksdb.RocksDB;
import org.rocksdb.RocksDBException;
import org.rocksdb.Status;
import org.rocksdb.WriteOptions;

public final class NodeDatabaseControl {
    // v10.2.1 loadLibrary(List) passes "rocksdbjni" to a helper which appends
    // "jni" again. The supervisor extracts the original archive member under
    // this explicit-loader filename, retaining exactly the pinned DLL bytes.
    static final String JNI_FILE_NAME = "librocksdbjnijni-win64.dll";
    private static final int MIB = 1024 * 1024;
    private static final int MAX_WRITES = 64;
    private static final long MAX_RUNTIME_NS = 25_000_000_000L;
    private static final byte[] BASE_KEY = {0, 0, 0, 0};
    private static final byte[] PROCEED = "PROCEED\n".getBytes(StandardCharsets.US_ASCII);
    private static final LinkOption[] NOFOLLOW = {LinkOption.NOFOLLOW_LINKS};
    private static long started;
    private static int outputBytes;
    private static String mode = "invalid", phase = "arguments";
    private static int completedWrites, completedFlushes, verifiedReads;
    private static long attemptedPayloadBytes, completedPayloadBytes;
    private static boolean baselineClosed, finalClosed, diskFull;
    private static String capacityStatus = "none", closeStatus = "not-opened";
    private static RocksDB.Version observedVersion;

    private static String quote(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        // No unbounded exception or environment text in the output stream.
        for (int i = 0; i < value.length() && i < 1024; i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') result.append('\\').append(c);
            else if (c < 32 || c > 126) result.append('?');
            else result.append(c);
        }
        return result.append('"').toString();
    }

    private static void emit(String fields) {
        String line = "{" + fields + "}\n";
        int length = line.getBytes(StandardCharsets.UTF_8).length;
        if (outputBytes + length > 60 * 1024) throw new IllegalStateException("Output bound");
        outputBytes += length;
        System.out.print(line);
        System.out.flush();
    }

    private static void checkTime() {
        if (System.nanoTime() - started >= MAX_RUNTIME_NS)
            throw new IllegalStateException("Worker deadline");
    }

    private static void directory(Path path) throws Exception {
        if (!Files.isDirectory(path, NOFOLLOW) || Files.isSymbolicLink(path))
            throw new IllegalArgumentException("Expected ordinary existing directory");
    }

    private static void absent(Path path) throws Exception {
        if (!Files.notExists(path, NOFOLLOW))
            throw new IllegalArgumentException("Expected absent worker path");
    }

    static void expectedRoot(String label, String actual, Path expected) {
        if (actual == null || actual.length() > 240)
            throw new IllegalArgumentException("Missing or oversized " + label);
        Path observed = Paths.get(actual);
        if (!observed.isAbsolute() || !observed.normalize().equals(expected.normalize()))
            throw new IllegalArgumentException("Unexpected " + label);
    }

    private static String sha256(Path file) throws Exception {
        if (!Files.isRegularFile(file, NOFOLLOW) || Files.size(file) > 32L * MIB)
            throw new IllegalArgumentException("Native DLL file bound");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        byte[] buffer = new byte[16384];
        try (InputStream input = Files.newInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                bytes += count;
                if (bytes > 32L * MIB) throw new IllegalArgumentException("Native DLL read bound");
                checkTime();
                digest.update(buffer, 0, count);
            }
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255));
        return hex.toString();
    }

    // Status text or a plain IOError is deliberately insufficient evidence.
    static boolean isNoSpace(Status status) {
        return status != null && status.getCode() == Status.Code.IOError
            && status.getSubCode() == Status.SubCode.NoSpace;
    }

    static boolean isPinnedVersion(RocksDB.Version version) {
        return version != null && version.getMajor() == 10
            && version.getMinor() == 2 && version.getPatch() == 1;
    }

    private static String versionFields() {
        return "\"rocksdbMajor\":" + (observedVersion == null ? "null" : observedVersion.getMajor())
            + ",\"rocksdbMinor\":" + (observedVersion == null ? "null" : observedVersion.getMinor())
            + ",\"rocksdbPatch\":" + (observedVersion == null ? "null" : observedVersion.getPatch());
    }

    private static String status(RocksDBException error) {
        Status status = error.getStatus();
        return status == null ? "missing-status" : status.getCode() + "/" + status.getSubCode();
    }

    private static void handshake(Path caseRoot) throws Exception {
        Path ready = caseRoot.resolve("jni-ready"), proceed = caseRoot.resolve("jni-proceed");
        absent(ready);
        absent(proceed);
        Files.write(ready, "READY\n".getBytes(StandardCharsets.US_ASCII), StandardOpenOption.CREATE_NEW);
        long deadline = System.nanoTime() + 8_000_000_000L;
        while (!Files.exists(proceed, NOFOLLOW)) {
            checkTime();
            if (System.nanoTime() >= deadline) throw new IllegalStateException("JNI observation timeout");
            Thread.sleep(25);
        }
        checkTime();
        if (System.nanoTime() >= deadline) throw new IllegalStateException("Late JNI observation");
        if (!Files.isRegularFile(proceed, NOFOLLOW)) throw new IllegalArgumentException("Invalid proceed file");
        // Read at most one byte beyond the exact token, even if replaced/expanded.
        ByteBuffer token = ByteBuffer.allocate(PROCEED.length + 1);
        try (FileChannel input = FileChannel.open(proceed, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            while (token.hasRemaining() && input.read(token) != -1) checkTime();
        }
        if (token.position() != PROCEED.length || !Arrays.equals(PROCEED, Arrays.copyOf(token.array(), token.position())))
            throw new IllegalArgumentException("Invalid proceed token");
    }

    private static Options options(Path dbPath, boolean fresh) {
        Options settings = new Options();
        try {
            settings.setCreateIfMissing(fresh).setErrorIfExists(fresh)
            .setCompressionType(CompressionType.NO_COMPRESSION)
            .setBottommostCompressionType(CompressionType.NO_COMPRESSION)
            .setDbLogDir(dbPath.toString()).setWalDir(dbPath.toString())
            .setWriteBufferSize(2L * MIB).setMaxWriteBufferNumber(2)
            .setDisableAutoCompactions(true).setLevel0SlowdownWritesTrigger(-1)
            .setLevel0StopWritesTrigger(-1).setMaxBackgroundJobs(1)
            .setMaxBgErrorResumeCount(0).setMaxOpenFiles(64)
            .setMaxLogFileSize(64 * 1024).setKeepLogFileNum(2)
            .setAvoidFlushDuringShutdown(true);
            return settings;
        } catch (RuntimeException | Error error) {
            settings.close();
            throw error;
        }
    }

    private static void verify(RocksDB db, byte[] key, byte[] expected) throws Exception {
        // Fixed-size get avoids allocating an untrusted value length.
        byte[] value = new byte[expected.length];
        if (db.get(key, value) != expected.length || !Arrays.equals(expected, value))
            throw new IllegalStateException("Database readback mismatch");
        verifiedReads++;
    }

    private static void database(Path caseRoot) throws Exception {
        Path dbPath = caseRoot.resolve("db");
        absent(dbPath);
        absent(caseRoot.resolve("db-active"));
        byte[] baseline = new byte[4096];
        Arrays.fill(baseline, (byte) 0x5a);
        try (WriteOptions writes = new WriteOptions(); FlushOptions flush = new FlushOptions()) {
            writes.setSync(true).setDisableWAL(false);
            flush.setWaitForFlush(true);
            phase = "baseline";
            try (Options settings = options(dbPath, true)) {
                RocksDB db = RocksDB.open(settings, dbPath.toString());
                try {
                    attemptedPayloadBytes += baseline.length;
                    db.put(writes, BASE_KEY, baseline);
                    completedPayloadBytes += baseline.length;
                    verify(db, BASE_KEY, baseline);
                    db.flush(flush);
                    completedFlushes++;
                    verify(db, BASE_KEY, baseline);
                } finally {
                    db.closeE();
                    baselineClosed = true;
                }
            }
            phase = "reopen";
            try (Options settings = options(dbPath, false)) {
                RocksDB db = RocksDB.open(settings, dbPath.toString());
                try {
                    verify(db, BASE_KEY, baseline);
                    emit("\"event\":\"db-active\",\"mode\":" + quote(mode) + ",\"verifiedReads\":" + verifiedReads);
                    Files.write(caseRoot.resolve("db-active"), "ACTIVE\n".getBytes(StandardCharsets.US_ASCII), StandardOpenOption.CREATE_NEW);
                    boolean fill = mode.equals("disk-full");
                    byte[] value = new byte[fill ? MIB : 4096];
                    Arrays.fill(value, (byte) 0xa5);
                    for (int i = 1; i <= MAX_WRITES; i++) {
                        checkTime();
                        byte[] key = {1, 0, 0, (byte) i};
                        value[0] = (byte) i;
                        phase = "capacity-put";
                        attemptedPayloadBytes += value.length;
                        try {
                            db.put(writes, key, value);
                            completedWrites++;
                            completedPayloadBytes += value.length;
                            if (fill) {
                                phase = "capacity-flush";
                                db.flush(flush);
                                completedFlushes++;
                            }
                        } catch (RocksDBException error) {
                            capacityStatus = status(error);
                            if (!fill || !isNoSpace(error.getStatus())) throw error;
                            diskFull = true;
                            break;
                        }
                        phase = "capacity-read";
                        verify(db, key, value);
                        if (!fill) Thread.sleep(50);
                    }
                    if (fill && !diskFull) throw new IllegalStateException("No NoSpace before payload bound");
                } finally {
                    try {
                        db.closeE();
                        closeStatus = "ok";
                    } catch (RocksDBException error) {
                        closeStatus = status(error);
                        // Preserve expected NoSpace on close separately; every other
                        // close failure remains fatal. closeE disposes in finally.
                        if (!diskFull || !isNoSpace(error.getStatus())) throw error;
                    } finally {
                        finalClosed = db.isClosed();
                    }
                }
            }
        }
    }

    private static void run(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("Expected run, JNI SHA-256, mode");
        mode = args[2];
        if (!Arrays.asList("disk-full", "observer-control", "threshold", "missing", "late", "failing").contains(mode))
            throw new IllegalArgumentException("Unknown fixed mode");
        if (!args[0].matches("[A-Za-z]:\\\\[^:*?\"<>|]+") || args[0].length() > 200)
            throw new IllegalArgumentException("Ordinary drive-letter run directory required");
        Path run = Paths.get(args[0]);
        if (!run.isAbsolute() || !run.equals(run.normalize()) || run.getNameCount() < 1)
            throw new IllegalArgumentException("Normalized absolute run directory required");
        directory(run);
        Path nativeDir = run.resolve("native"), caseRoot = run.resolve(mode);
        directory(nativeDir);
        directory(caseRoot);
        phase = "write-roots";
        expectedRoot("java.io.tmpdir", System.getProperty("java.io.tmpdir"), run.resolve("tmp"));
        expectedRoot("user.home", System.getProperty("user.home"), run.resolve("home"));
        expectedRoot("user.dir", System.getProperty("user.dir"), run);
        expectedRoot("java.library.path", System.getProperty("java.library.path"), nativeDir);
        expectedRoot("TEMP", System.getenv("TEMP"), run);
        expectedRoot("TMP", System.getenv("TMP"), run);
        expectedRoot("USERPROFILE", System.getenv("USERPROFILE"), run);
        Path dll = nativeDir.resolve(JNI_FILE_NAME);
        // loadLibrary(List) also tries optional compression DLL names. A single
        // verified file in its only search directory prevents those candidates.
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(nativeDir)) {
            int count = 0;
            for (Path entry : entries) {
                if (++count > 1 || !entry.equals(dll)) throw new IllegalArgumentException("Native directory must contain only pinned JNI");
            }
            if (count != 1) throw new IllegalArgumentException("Missing JNI");
        }
        if (!args[1].matches("[0-9a-f]{64}") || !sha256(dll).equals(args[1]))
            throw new IllegalArgumentException("JNI SHA-256 mismatch");
        if (!"21.0.1".equals(System.getProperty("java.version")))
            throw new IllegalArgumentException("Pinned JRE 21.0.1 required");
        phase = "load-jni";
        RocksDB.loadLibrary(Collections.singletonList(nativeDir.toString()));
        observedVersion = RocksDB.rocksdbVersion();
        emit("\"event\":\"jni-loaded\",\"mode\":" + quote(mode)
            + ",\"jniPath\":" + quote(dll.toString()) + ",\"jniSha256\":" + quote(args[1])
            + "," + versionFields() + ",\"javaVersion\":" + quote(System.getProperty("java.version"))
            + ",\"tmp\":" + quote(System.getProperty("java.io.tmpdir"))
            + ",\"home\":" + quote(System.getProperty("user.home"))
            + ",\"cwd\":" + quote(System.getProperty("user.dir"))
            + ",\"libraryPath\":" + quote(System.getProperty("java.library.path"))
            + ",\"tempEnv\":" + quote(System.getenv("TEMP"))
            + ",\"tmpEnv\":" + quote(System.getenv("TMP"))
            + ",\"userProfile\":" + quote(System.getenv("USERPROFILE")));
        phase = "jni-handshake";
        handshake(caseRoot);
        // Preserve loaded-module provenance even when the reported native
        // version differs. No database access precedes this exact tuple gate.
        phase = "version-check";
        if (!isPinnedVersion(observedVersion))
            throw new IllegalStateException("Pinned RocksDB version mismatch");
        database(caseRoot);
    }

    public static void main(String[] args) {
        started = System.nanoTime();
        int exit = 0;
        String outcome = "complete", errorClass = null, errorMessage = null;
        try { run(args); }
        catch (Exception | LinkageError error) {
            exit = 2;
            outcome = "failed";
            errorClass = error.getClass().getName();
            errorMessage = error.getMessage();
        }
        emit("\"event\":\"result\",\"outcome\":" + quote(outcome) + ",\"mode\":" + quote(mode)
            + ",\"phase\":" + quote(phase) + ",\"diskFull\":" + diskFull
            + "," + versionFields()
            + ",\"capacityStatus\":" + quote(capacityStatus) + ",\"closeStatus\":" + quote(closeStatus)
            + ",\"baselineClosed\":" + baselineClosed + ",\"finalClosed\":" + finalClosed
            + ",\"completedWrites\":" + completedWrites + ",\"completedFlushes\":" + completedFlushes
            + ",\"verifiedReads\":" + verifiedReads + ",\"attemptedPayloadBytes\":" + attemptedPayloadBytes
            + ",\"completedPayloadBytes\":" + completedPayloadBytes + ",\"maxPayloadBytes\":" + (64L * MIB + 4096)
            + ",\"elapsedMs\":" + ((System.nanoTime() - started) / 1_000_000)
            + ",\"errorClass\":" + quote(errorClass) + ",\"error\":" + quote(errorMessage));
        if (exit != 0) System.exit(exit);
    }
}
