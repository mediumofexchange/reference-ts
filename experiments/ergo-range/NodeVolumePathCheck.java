// Fixed syntax-only specimens. No stat, canonicalization, directory creation,
// filesystem access through specimens, native library load, or node startup.
import java.io.File;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class NodeVolumePathCheck {
    private static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    public static void main(String[] args) {
        if (args.length != 0) throw new IllegalArgumentException("Fixed specimens only");
        String[][] specimens = {
            {"volume-guid-root", "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\"},
            {"volume-guid-child", "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\run\\tmp"},
            {"drive-child", "C:\\moe-syntax-only\\run\\tmp"},
            {"extended-drive-child", "\\\\?\\C:\\moe-syntax-only\\run\\tmp"},
            {"extended-unc-child", "\\\\?\\UNC\\moe-syntax-only.invalid\\share\\run\\tmp"}
        };
        System.out.println("{\"javaVersion\":" + quote(System.getProperty("java.version")) + ",\"cases\":[");
        for (int i = 0; i < specimens.length; i++) {
            String name = specimens[i][0], input = specimens[i][1];
            File file = new File(input);
            String nioPath = null, nioError = null, filePath = null, fileError = null;
            boolean nioAbsolute = false;
            try {
                Path path = Paths.get(input);
                nioPath = path.toString();
                nioAbsolute = path.isAbsolute();
            } catch (InvalidPathException error) { nioError = error.getReason(); }
            try { filePath = file.toPath().toString(); }
            catch (InvalidPathException error) { fileError = error.getReason(); }
            System.out.println((i == 0 ? "" : ",") + "{\"name\":" + quote(name) +
                ",\"input\":" + quote(input) + ",\"filePath\":" + quote(file.getPath()) +
                ",\"fileAbsolute\":" + file.isAbsolute() +
                ",\"nioPath\":" + (nioPath == null ? "null" : quote(nioPath)) +
                ",\"nioAbsolute\":" + nioAbsolute +
                ",\"nioError\":" + (nioError == null ? "null" : quote(nioError)) +
                ",\"fileToPath\":" + (filePath == null ? "null" : quote(filePath)) +
                ",\"fileToPathError\":" + (fileError == null ? "null" : quote(fileError)) + "}");
        }
        System.out.println("]}");
    }
}
