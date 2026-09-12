// Local v2 payment operation. No protocol layout or proof identity changes.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { isValue, limbsOf } from "./field.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "./notes.js";
import { NoteTree } from "./note-tree.js";
import { ScopeTree } from "./scope.js";
import { SPEND } from "./statement.js";
import { decodeWalletPairing } from "./wallet-pairing.js";
import { PoolWalletError, type PoolWalletStore, type WalletHolding } from "./wallet-store.js";
import type { readPoolCheckpoint, PoolCheckpointFailure } from "./checkpoint.js";
export { walletChangeRequestId } from "./wallet.js";

type Pending = ReturnType<PoolWalletStore["pending"]>;
function requireThat(ok: boolean, message: string): asserts ok {
  if (!ok) throw new PoolWalletError("CONFLICT", message);
}
/** This alias's immutable invoice is the command intent; transport rotation
 * may change the binding, but cannot change any of these terms. */
export function walletPayment(wallet: PoolWalletStore, alias: string): Pending {
  const pair = decodeWalletPairing(wallet.pairing(alias)), pending = wallet.pending(alias), output = pending.opening;
  requireThat(pending.statement.kind === SPEND && output !== undefined && pending.change !== undefined &&
    bytesToHex(output.backing) === pair.request.backing && output.value.toString() === pair.request.value &&
    output.owner.toString() === pair.request.owner, "saved payment differs from paired invoice");
  return pending;
}
function existing(wallet: PoolWalletStore, alias: string): Pending | undefined {
  try { wallet.pending(alias); }
  catch (error) { if (error instanceof PoolWalletError && error.code === "UNKNOWN") return undefined; throw error; }
  return walletPayment(wallet, alias);
}

/** Prefer one note, then the least-total usable pair. Input order for
 * derivation is independent of inventory order and selection tie breaking. */
function select(notes: readonly WalletHolding[], backing: string, value: bigint): WalletHolding[] {
  const candidates = notes.filter(n => n.state === "unspent" && n.reservation === undefined && bytesToHex(n.opening.backing) === backing)
    .sort((a, b) => a.opening.value < b.opening.value ? -1 : a.opening.value > b.opening.value ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const single = candidates.find(n => n.opening.value >= value);
  if (single) return [single];
  let pair: WalletHolding[] | undefined, total: bigint | undefined, ids: string | undefined;
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i]!, b = candidates[j]!, sum = a.opening.value + b.opening.value;
    const key = [a.id, b.id].sort().join("\0"); // Comparison only; never hashed or signed.
    if (sum >= value && isValue(sum - value) && (total === undefined || sum < total || sum === total && key < ids!)) {
      pair = [a, b]; total = sum; ids = key;
    }
  }
  requireThat(pair !== undefined, "no available one- or two-note payment at the selected checkpoint");
  return pair;
}
const note = (n: NoteOpening) => ({ backing: limbsOf(n.backing).map(String), value: String(n.value), owner: String(n.owner), rho: String(n.rho) });

/** Trusted local prover callback only: witness contains wallet secrets. Never
 * send it to the operator. All network submission uses the saved statement.
 * A fresh command needs verified history; exact retry needs only saved intent. */
export async function prepareWalletPayment(wallet: PoolWalletStore, alias: string,
  args: Parameters<typeof readPoolCheckpoint>[0],
  prove: (publicInputs: readonly bigint[], witness: Record<string, unknown>) => Promise<Uint8Array>,
): Promise<PoolCheckpointFailure | { readonly kind: "prepared"; readonly pending: Pending }> {
  const saved = existing(wallet, alias);
  if (saved) return { kind: "prepared", pending: saved };
  wallet.assertNewPayment(alias);
  const pair = decodeWalletPairing(wallet.pairing(alias)), authority = wallet.context();
  const inventory = await wallet.inspectNotes(args);
  if (inventory.kind !== "final") return inventory;
  const prefix = inventory.verified.prefix;
  requireThat(prefix.header.entries.every(e => e.opening === undefined) && prefix.length === BigInt(prefix.events.length),
    "payment operation requires one segment without imports");
  const value = BigInt(pair.request.value), backing = hexToBytes(pair.request.backing);
  const selected = select(inventory.notes, pair.request.backing, value).sort((a, b) => a.nullifier < b.nullifier ? -1 : 1);
  const realNullifiers = selected.map(n => n.nullifier);
  const tree = new NoteTree(); tree.appendAll(prefix.events.flatMap(e => [...e.outputs]));
  requireThat(prefix.roots.includes(tree.root()), "wallet tree is not a verified anchor");
  const positions = new Map(tree.leaves().map((cm, i) => [cm, BigInt(i)]));
  const inputs = selected.map(n => ({ opening: n.opening, secret: wallet.secret(n.id), nf: n.nullifier,
    path: tree.path(positions.get(commitmentOf(authority.domain, n.opening))!) }));
  const paddingSecret = wallet.derive("padding-secret", realNullifiers);
  const padding = { backing, value: 0n, owner: ownerOf(paddingSecret), rho: wallet.derive("padding-rho", realNullifiers) };
  if (inputs.length === 1) inputs.push({ opening: padding, secret: paddingSecret,
    nf: nullifierOf(authority.domain, commitmentOf(authority.domain, padding), paddingSecret),
    path: { siblings: Array<bigint>(32).fill(0n), right: Array<boolean>(32).fill(false) } });
  const quantity = selected.reduce((n, input) => n + input.opening.value, 0n) - value;
  const changeOwner = quantity === 0n ? padding.owner : wallet.changeRequest(alias, backing, quantity).owner;
  const output = { backing, value, owner: BigInt(pair.request.owner), rho: wallet.derive("output-rho", realNullifiers) };
  const change = { backing, value: quantity, owner: changeOwner, rho: wallet.derive("output-rho", realNullifiers, 1) };
  const scope = new ScopeTree(prefix.header.entries), path = scope.pathFor(backing), entry = scope.entry(backing);
  requireThat(path !== undefined && entry !== undefined, "payment backing is outside scope");
  requireThat(scope.root() === authority.scopeRoot, "payment scope differs from wallet");
  const anchors = [tree.root(), tree.root()], nullifiers = inputs.map(i => i.nf);
  const outputs = [commitmentOf(authority.domain, output), commitmentOf(authority.domain, change)];
  const publicInputs = [...limbsOf(authority.domain), ...limbsOf(authority.segment), authority.scopeRoot, ...anchors, ...nullifiers, ...outputs];
  const witness = { domain: limbsOf(authority.domain).map(String), segment: limbsOf(authority.segment).map(String), scope: String(authority.scopeRoot),
    anchors: anchors.map(String), nullifiers: nullifiers.map(String), inputs: inputs.map(i => note(i.opening)), secrets: inputs.map(i => String(i.secret)),
    siblings: inputs.map(i => i.path.siblings.map(String)), right: inputs.map(i => [...i.path.right]),
    outputs: outputs.map(String), output_notes: [note(output), note(change)],
    links: inputs.map(() => limbsOf(entry.link).map(String)), scope_siblings: inputs.map(() => path.siblings.map(String)), scope_right: inputs.map(() => [...path.right]) };
  const proof = await prove([...publicInputs], witness);
  // A concurrent exact command may have won while the prover was working.
  // Adopt its durable bytes; never replace them with this proof's randomness.
  const concurrent = existing(wallet, alias);
  if (concurrent) return { kind: "prepared", pending: concurrent };
  wallet.preparePayment(alias, { kind: SPEND, publicInputs, proof }, output, change);
  return { kind: "prepared", pending: walletPayment(wallet, alias) };
}
