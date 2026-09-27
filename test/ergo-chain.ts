// Synthetic reference chain and independently parsed publishing mempool.
// Their shared implementation also serves the journal acceptance harness.
export {
  BranchSupplier, Chain, MiningSupplier, MempoolNode, plainBox, plainOutput, rawOutput, recordOutput,
  SYNTHETIC_ANCHOR_HEIGHT as ANCHOR_HEIGHT, SYNTHETIC_SCRIPTS as SCRIPTS,
  transaction, type Block, type Output,
} from "../src/ergo-synthetic.js";

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
