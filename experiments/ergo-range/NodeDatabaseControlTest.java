// Pure Java status, path, filename and version checks. No worker main/JNI.
import java.nio.file.Paths;
import org.rocksdb.Status;
import org.rocksdb.RocksDB;
import org.rocksdb.util.Environment;

public final class NodeDatabaseControlTest {
    private static void check(boolean expected, Status status) {
        if (NodeDatabaseControl.isNoSpace(status) != expected)
            throw new AssertionError("Unexpected disk-full classification");
    }

    private static void checkRoot(boolean expected, String actual) {
        boolean accepted = true;
        try { NodeDatabaseControl.expectedRoot("test-root", actual, Paths.get("R:\\run\\tmp")); }
        catch (IllegalArgumentException error) { accepted = false; }
        if (accepted != expected) throw new AssertionError("Unexpected write-root acceptance");
    }

    private static void checkJniName(String expected, String library) {
        // Executes the pinned JAR's actual filename computation without loading
        // JNI. RocksDB v10.2.1 loadLibrary(List) supplies "rocksdbjni", whereas
        // the archive's normal resource naming supplies "rocksdb".
        if (!expected.equals(Environment.getJniLibraryFileName(library)))
            throw new AssertionError("Pinned JNI filename mismatch");
    }

    private static void checkVersion(boolean expected, RocksDB.Version version) {
        if (NodeDatabaseControl.isPinnedVersion(version) != expected)
            throw new AssertionError("Unexpected pinned RocksDB version acceptance");
    }

    public static void main(String[] args) {
        if (args.length != 0) throw new IllegalArgumentException("No arguments");
        check(true, new Status(Status.Code.IOError, Status.SubCode.NoSpace, null));
        check(true, new Status(Status.Code.IOError, Status.SubCode.NoSpace, "localized text"));
        check(false, null);
        check(false, new Status(Status.Code.IOError, null, "No space left on device"));
        check(false, new Status(Status.Code.IOError, Status.SubCode.None, "NoSpace"));
        check(false, new Status(Status.Code.IOError, Status.SubCode.MemoryLimit, "disk full"));
        check(false, new Status(Status.Code.Corruption, Status.SubCode.NoSpace, "disk full"));
        check(false, new Status(Status.Code.Ok, Status.SubCode.NoSpace, "disk full"));
        checkRoot(true, "R:\\run\\tmp");
        checkRoot(true, "R:/run\\tmp");
        checkRoot(true, "R:\\run\\.\\tmp");
        checkRoot(false, null);
        checkRoot(false, "run/tmp");
        checkRoot(false, "S:\\run\\tmp");
        checkRoot(false, "R:\\run\\home");
        checkRoot(false, "R:\\run\\tmp;C:\\system");
        checkJniName("librocksdbjni-win64.dll", "rocksdb");
        checkJniName(NodeDatabaseControl.JNI_FILE_NAME, "rocksdbjni");
        RocksDB.Version pinned = new RocksDB.Version((byte) 10, (byte) 2, (byte) 1);
        checkVersion(true, pinned);
        checkVersion(false, null);
        checkVersion(false, new RocksDB.Version((byte) 9, (byte) 2, (byte) 1));
        checkVersion(false, new RocksDB.Version((byte) 10, (byte) 1, (byte) 1));
        checkVersion(false, new RocksDB.Version((byte) 10, (byte) 2, (byte) 0));
        // Pure pinned-JAR evidence: its formatting is already dotted numeric.
        // A native mismatch must not be explained away as a formatting issue.
        if (!"10.2.1".equals(pinned.toString()))
            throw new AssertionError("Pinned RocksDB Version formatting changed");
        System.out.println("{\"status\":\"passed\",\"cases\":24,\"test\":\"status-write-roots-jni-names-and-version\"}");
    }
}
