// Pure Java status and path checks. Never calls worker main or loads JNI.
import java.nio.file.Paths;
import org.rocksdb.Status;

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
        System.out.println("{\"status\":\"passed\",\"cases\":16,\"test\":\"status-and-write-roots\"}");
    }
}
