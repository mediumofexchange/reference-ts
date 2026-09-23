// Candidate decoder boundary shared by the profile probe and local replay.
// Exact existing sigma-rust round trip; neither node equivalence nor hard
// memory containment is established by it.
//
// The pinned build is a debug build: its parser uses about 12 KB of stack a
// nesting level, so a node-valid transaction at the node's nesting cap (110)
// overflows Node's default stack, and a real mainnet transaction needs about
// 1.2 MB. A stack overflow or trap inside the module leaves its one instance
// unusable, so it is fatal here, never a refusal: every later call throws and
// the process must start again. The process must run with --stack-size of at
// least STACK_KB (see the decoder stack probe in the deployment probes).
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";

export const STACK_KB = 4000;
// V8 trusts --stack-size; above the thread's real stack (8 MB for Node's main thread on Windows and Linux defaults) an
// overflow kills the process without an error. A worker's stack is its resourceLimits.stackSizeMb, not this flag.
const MAX_STACK_KB = 7800;
const stackKb = () => {
  const flags = process.execArgv;
  for (let i = flags.length - 1; i >= 0; i--) {
    const joined = /^--stack[-_]size=(\d+)$/.exec(flags[i]);
    if (joined !== null) return Number(joined[1]);
  }
  return undefined;
};
const stack = stackKb();
if (!(stack >= STACK_KB && stack <= MAX_STACK_KB)) throw new Error(`decoder.mjs needs node --stack-size between ${STACK_KB} and ${MAX_STACK_KB}: the pinned build overflows the default stack on node-valid transactions`);

// A stack overflow surfaces as RangeError and a trap as WebAssembly.RuntimeError; either leaves the instance's memory
// in an unknown state.
const fatal = error => error instanceof RangeError || error instanceof WebAssembly.RuntimeError;
let poisoned;
const hex = bytes => Buffer.from(bytes).toString("hex");
export const decodeTransaction = bytes => {
  if (poisoned !== undefined) throw new Error("the decoder trapped earlier; its instance cannot be used", { cause: poisoned });
  let tx;
  try { tx = Transaction.sigma_parse_bytes(bytes); } catch (error) { if (fatal(error)) { poisoned = error; throw error; } return undefined; }
  try {
    if (hex(tx.sigma_serialize_bytes()) !== hex(bytes)) return undefined;
    const js = tx.to_js_eip12();
    const proofs = js.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"));
    return { id: Buffer.from(js.id, "hex"), witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1),
      outputs: js.outputs.map(output => ({ ergoTree: Buffer.from(output.ergoTree, "hex"),
        registers: Object.fromEntries(Object.entries(output.additionalRegisters).map(([name, value]) => [name, Buffer.from(value, "hex")])) })) };
  } catch (error) { if (fatal(error)) poisoned = error; throw error; }
  finally { if (poisoned === undefined) tx.free(); }
};
