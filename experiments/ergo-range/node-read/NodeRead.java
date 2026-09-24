// The node's own reading of transaction bytes, offline: the official v6.0.6 node JAR's ErgoTransactionSerializer.parse
// over a VLQByteBufferReader, inside the version context BlockTransactionsSerializer.parse gives a transaction of a
// version-4 block (Header.scriptAndTreeFromBlockVersions), then the node's API encoder (ErgoTransaction's
// transactionEncoder) for its fields. No network, no state: this is how the node reads one transaction of a block
// section, not whether it would accept that transaction.
//
// Usage (compiled against the node JAR, run in the node's bundled runtime):
//   java -cp <ergo-6.0.6.jar>;<classes> NodeRead <cases.txt>
// Each input line is a case's bytes in hex; each output line is one JSON object for that line, in order:
//   {"read":<bytes consumed>,["rewritten":"<hex>",]"stateless":"ok"|"<failure>","tx":<the node's JSON>}
//       the node read a transaction from the first <read> bytes; "rewritten" is present when its own serializer writes
//       that transaction as other bytes than those it read (the node's id and JSON are of these bytes)
//   {"refused":"<exception class>","message":"<first line, at most 200 chars>"}     the node's parse threw
//   {"encodeFailed":"<exception class>","read":<bytes consumed>}                     read, but reserializing or encoding threw
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import org.ergoplatform.modifiers.history.header.Header$;
import org.ergoplatform.modifiers.mempool.ErgoTransaction;
import org.ergoplatform.modifiers.mempool.ErgoTransaction$;
import org.ergoplatform.modifiers.mempool.ErgoTransactionSerializer$;
import scorex.util.serialization.VLQByteBufferReader;
import sigma.VersionContext;
import sigma.VersionContext$;

public class NodeRead {
  static String quote(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  static String firstLine(Throwable e) {
    String m = String.valueOf(e.getMessage());
    int nl = m.indexOf('\n');
    if (nl >= 0) m = m.substring(0, nl);
    return m.length() > 200 ? m.substring(0, 200) : m;
  }

  public static void main(String[] args) throws Exception {
    VersionContext block4 = Header$.MODULE$.scriptAndTreeFromBlockVersions((byte) 4);
    byte activated = block4.activatedVersion(), tree = block4.ergoTreeVersion();
    PrintStream out = new PrintStream(new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 16), false, StandardCharsets.UTF_8);
    out.println("{\"versionContext\":{\"activated\":" + activated + ",\"ergoTree\":" + tree + "}}");
    try (BufferedReader in = Files.newBufferedReader(Path.of(args[0]), StandardCharsets.US_ASCII)) {
      for (String line; (line = in.readLine()) != null; ) {
        byte[] bytes = java.util.HexFormat.of().parseHex(line.trim());
        VLQByteBufferReader reader = new VLQByteBufferReader(ByteBuffer.wrap(bytes));
        ErgoTransaction tx;
        try {
          tx = (ErgoTransaction) VersionContext$.MODULE$.withVersions(activated, tree, () -> ErgoTransactionSerializer$.MODULE$.parse(reader));
        } catch (Throwable e) {
          out.println("{\"refused\":" + quote(e.getClass().getName()) + ",\"message\":" + quote(firstLine(e)) + "}");
          continue;
        }
        int read = reader.position();
        String json, stateless, rewritten;
        try {
          byte[] again = (byte[]) VersionContext$.MODULE$.withVersions(activated, tree, () -> ErgoTransactionSerializer$.MODULE$.toBytes(tx));
          rewritten = java.util.Arrays.equals(again, java.util.Arrays.copyOf(bytes, read)) ? null : java.util.HexFormat.of().formatHex(again);
          json = ErgoTransaction$.MODULE$.transactionEncoder().apply(tx).noSpaces();
          scala.util.Try<?> validity = (scala.util.Try<?>) VersionContext$.MODULE$.withVersions(activated, tree, () -> tx.statelessValidity());
          stateless = validity.isSuccess() ? "ok" : firstLine(validity.failed().get());
        } catch (Throwable e) {
          out.println("{\"encodeFailed\":" + quote(e.getClass().getName()) + ",\"read\":" + read + "}");
          continue;
        }
        out.println("{\"read\":" + read + (rewritten == null ? "" : ",\"rewritten\":\"" + rewritten + "\"") + ",\"stateless\":" + quote(stateless) + ",\"tx\":" + json + "}");
      }
    }
    out.flush();
  }
}
