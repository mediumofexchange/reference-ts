// The node's own reading of transaction bytes, offline: each case is framed as a one-transaction version-4 block
// section (32-byte header id, 10,000,000 + 4, a count of 1, the case's bytes) and read by the official v6.0.6 node JAR's
// BlockTransactionsSerializer.parse over a VLQByteBufferReader, the function the node reads a block section with, which
// sets the transaction's version context (Header.scriptAndTreeFromBlockVersions(4)). What the node committed to is then
// stated inside that same context: the transaction id and witness id the node computes, and per output the ErgoTree
// and each register's constant as the node's serializers write them into its box bytes. No network, no state: this is
// how the node reads one transaction of a block section, not whether it would accept that transaction.
//
// Usage (compiled against the node JAR, run in the node's bundled runtime):
//   java -cp <ergo-6.0.6.jar>;<classes> NodeRead <cases.txt>
// Each input line is a case's bytes in hex; the first output line states the version context, then one JSON object
// per input line, in order:
//   {"read":<bytes of the case consumed>,["rewritten":"<hex>",]"stateless":"ok"|"<failure>","tx":{"id","witnessId",
//     "outputs":[{"ergoTree","registers":{"R4":...}}]}}
//       the node read a transaction from the case's first <read> bytes; "rewritten" is present when the node's own
//       serializer writes that transaction as other bytes than those it read (the node's ids are of those bytes)
//   {"refused":"<exception class>","message":"<first line, at most 200 chars>"}     the node's parse threw
//   {"encodeFailed":"<exception class>","read":<bytes consumed>}                     read, but stating it threw
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.HexFormat;
import org.ergoplatform.ErgoBox;
import org.ergoplatform.ErgoBoxCandidate;
import org.ergoplatform.modifiers.history.BlockTransactions;
import org.ergoplatform.modifiers.history.BlockTransactionsSerializer$;
import org.ergoplatform.modifiers.history.header.Header$;
import org.ergoplatform.modifiers.mempool.ErgoTransaction;
import org.ergoplatform.modifiers.mempool.ErgoTransactionSerializer$;
import scorex.util.serialization.VLQByteBufferReader;
import sigma.VersionContext;
import sigma.VersionContext$;
import sigma.serialization.ErgoTreeSerializer$;
import sigma.serialization.ValueSerializer$;

public class NodeRead {
  static final HexFormat HEX = HexFormat.of();

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

  // The section prefix of a version-4 block with one transaction: header id, 10,000,004 and 1 as VLQ integers.
  static final byte[] PREFIX;
  static {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    b.writeBytes(new byte[32]);
    for (long v : new long[] { 10_000_004L, 1L }) {
      while (v >= 0x80) { b.write((int) (v & 0x7f) | 0x80); v >>>= 7; }
      b.write((int) v);
    }
    PREFIX = b.toByteArray();
  }

  // Every field the comparison reads, as the node holds it, stated inside the transaction's version context.
  static String fields(ErgoTransaction tx) {
    StringBuilder b = new StringBuilder("{\"id\":\"").append(tx.id()).append("\",\"witnessId\":\"")
      .append(HEX.formatHex(tx.witnessSerializedId())).append("\",\"outputs\":[");
    for (int i = 0; i < tx.outputCandidates().length(); i++) {
      ErgoBoxCandidate out = tx.outputCandidates().apply(i);
      if (i > 0) b.append(',');
      // As the box serializer writes it (and so the ids and box ids commit to it), not the parsed slice ErgoTree.bytes()
      // keeps: for a transaction the node rewrites, the two differ.
      byte[] tree = ErgoTreeSerializer$.MODULE$.DefaultSerializer().serializeErgoTree(out.ergoTree());
      b.append("{\"ergoTree\":\"").append(HEX.formatHex(tree)).append("\",\"registers\":{");
      scala.collection.Iterator<? extends scala.Tuple2<ErgoBox.NonMandatoryRegisterId, ?>> it = out.additionalRegisters().iterator();
      boolean first = true;
      while (it.hasNext()) {
        scala.Tuple2<ErgoBox.NonMandatoryRegisterId, ?> entry = it.next();
        @SuppressWarnings("unchecked")
        byte[] value = ValueSerializer$.MODULE$.serialize((sigma.ast.Value<sigma.ast.SType>) entry._2());
        b.append(first ? "" : ",").append("\"R").append(entry._1().number()).append("\":\"").append(HEX.formatHex(value)).append('"');
        first = false;
      }
      b.append("}}");
    }
    return b.append("]}").toString();
  }

  public static void main(String[] args) throws Exception {
    VersionContext block4 = Header$.MODULE$.scriptAndTreeFromBlockVersions((byte) 4);
    byte activated = block4.activatedVersion(), tree = block4.ergoTreeVersion();
    PrintStream out = new PrintStream(new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 16), false, StandardCharsets.UTF_8);
    out.println("{\"versionContext\":{\"activated\":" + activated + ",\"ergoTree\":" + tree + "}}");
    try (BufferedReader in = Files.newBufferedReader(Path.of(args[0]), StandardCharsets.US_ASCII)) {
      for (String line; (line = in.readLine()) != null; ) {
        byte[] bytes = HEX.parseHex(line.trim());
        byte[] section = new byte[PREFIX.length + bytes.length];
        System.arraycopy(PREFIX, 0, section, 0, PREFIX.length);
        System.arraycopy(bytes, 0, section, PREFIX.length, bytes.length);
        VLQByteBufferReader reader = new VLQByteBufferReader(ByteBuffer.wrap(section));
        ErgoTransaction tx;
        try {
          BlockTransactions block = BlockTransactionsSerializer$.MODULE$.parse(reader);
          if (block.blockVersion() != 4 || block.txs().length() != 1) throw new IllegalStateException("not one transaction of a version-4 section");
          tx = block.txs().apply(0);
        } catch (Throwable e) {
          out.println("{\"refused\":" + quote(e.getClass().getName()) + ",\"message\":" + quote(firstLine(e)) + "}");
          continue;
        }
        int read = reader.position() - PREFIX.length;
        String stated, stateless, rewritten;
        try {
          Object[] result = (Object[]) VersionContext$.MODULE$.withVersions(activated, tree, () -> {
            byte[] again = ErgoTransactionSerializer$.MODULE$.toBytes(tx);
            scala.util.Try<?> validity = tx.statelessValidity();
            return new Object[] { again, fields(tx), validity.isSuccess() ? "ok" : firstLine(validity.failed().get()) };
          });
          byte[] again = (byte[]) result[0];
          rewritten = java.util.Arrays.equals(again, java.util.Arrays.copyOf(bytes, read)) ? null : HEX.formatHex(again);
          stated = (String) result[1];
          stateless = (String) result[2];
        } catch (Throwable e) {
          out.println("{\"encodeFailed\":" + quote(e.getClass().getName()) + ",\"read\":" + read + "}");
          continue;
        }
        out.println("{\"read\":" + read + (rewritten == null ? "" : ",\"rewritten\":\"" + rewritten + "\"") + ",\"stateless\":" + quote(stateless) + ",\"tx\":" + stated + "}");
      }
    }
    out.flush();
  }
}
