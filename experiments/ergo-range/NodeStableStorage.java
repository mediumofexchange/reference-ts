// Offline operational probe of the unmodified Ergo v6.0.5 versioned store.
// No actors, node startup, wallet, peers, database repair or custom native library.
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import scala.Tuple2;
import scala.collection.JavaConverters;
import scala.collection.Seq;
import scorex.db.LDBFactory$;
import scorex.db.LDBVersionedStore;

public final class NodeStableStorage {
    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.US_ASCII);
    }
    private static <T> Seq<T> seq(List<T> values) {
        return JavaConverters.asScalaBufferConverter(values).asScala();
    }
    @SafeVarargs
    private static Seq<Tuple2<byte[], byte[]>> entries(Tuple2<byte[], byte[]>... values) {
        return seq(Arrays.asList(values));
    }
    private static Tuple2<byte[], byte[]> pair(String key, String value) {
        return new Tuple2<byte[], byte[]>(bytes(key), bytes(value));
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
    private static void value(LDBVersionedStore store, String key, String expected) {
        scala.Option<byte[]> actual = store.get(bytes(key));
        require(expected == null ? actual.isEmpty()
            : actual.isDefined() && Arrays.equals(actual.get(), bytes(expected)),
            "Unexpected value for " + key);
    }
    private static void version(LDBVersionedStore store, String expected) {
        require(store.lastVersionID().isDefined()
            && Arrays.equals(store.lastVersionID().get(), bytes(expected)), "Unexpected version");
    }
    public static void main(String[] args) throws Exception {
        require(args.length == 3, "Mode, dedicated database directory and pinned Java version required");
        require(args[2].equals("21.0.1") || args[2].equals("21.0.12.1"), "Unknown Java selection");
        require(args[2].equals(System.getProperty("java.version")), "Unexpected Java runtime");
        String mode = args[0];
        require(mode.equals("write") || mode.equals("rollback") || mode.equals("verify"), "Unknown mode");
        File root = new File(args[1]).getCanonicalFile();
        require(root.isAbsolute() && root.isDirectory(), "Existing directory required");
        if (mode.equals("write")) require(root.list().length == 0, "Fresh store required");
        // Use the node's real factory selection and refuse experimental Java fallback.
        Object registry = LDBFactory$.MODULE$.factory();
        Object engine = registry.getClass().getMethod("factory").invoke(registry);
        require(engine.getClass().getName().equals("org.fusesource.leveldbjni.JniDBFactory"),
            "Stock native LevelDB factory required");
        LDBVersionedStore store = new LDBVersionedStore(root, 2);
        try {
            if (mode.equals("write")) {
                require(store.lastVersionID().isEmpty(), "Unexpected initial version");
                store.insert(bytes("v1"), entries(pair("a", "first"), pair("b", "kept"))).get();
                value(store, "a", "first"); value(store, "b", "kept"); version(store, "v1");
                store.update(bytes("v2"), seq(Arrays.asList(bytes("b"))),
                    entries(pair("a", "second"), pair("c", "added"))).get();
                value(store, "a", "second"); value(store, "b", null); value(store, "c", "added");
                version(store, "v2");
            } else if (mode.equals("rollback")) {
                version(store, "v2");
                value(store, "a", "second"); value(store, "b", null); value(store, "c", "added");
                require(store.rollbackTo(bytes("unknown")).isFailure(), "Unknown version accepted");
                version(store, "v2");
                value(store, "a", "second"); value(store, "b", null); value(store, "c", "added");
                store.rollbackTo(bytes("v1")).get();
                version(store, "v1");
                value(store, "a", "first"); value(store, "b", "kept"); value(store, "c", null);
            } else {
                version(store, "v1");
                value(store, "a", "first"); value(store, "b", "kept"); value(store, "c", null);
            }
        } finally {
            store.close();
        }
        System.out.println("MOE_STABLE_STORAGE=" + mode + ":passed;engine=" + engine.getClass().getName());
    }
}
