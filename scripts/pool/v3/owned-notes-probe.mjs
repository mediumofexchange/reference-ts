// Probe for slice 11 M11b7 (WORK.md Next 4(x)): the time a wallet read's
// `ownedNotes` takes over one seed's witnessed outputs, half of them spent,
// and the time to read two notes' spend secrets as a spend does. It writes the
// outputs straight into an in-memory replay store with the seed's witness
// predicate, as a replay's apply does, so no proof or record is involved.
// Retires with M11b7's decision once recorded.
//
// Usage: node scripts/pool/v3/owned-notes-probe.mjs [dist directory] [outputs...]
// (after `npm run build`; the dist directory defaults to ./dist).
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [distArg = "dist", ...counts] = process.argv.slice(2);
const dist = pathToFileURL(resolve(distArg) + "/").href;
const { prepareExactOutput } = await import(dist + "pool/v3/capsules.js");
const { ownedNotes, seedWitness } = await import(dist + "pool/v3/holdings.js");
const { ReplayStore } = await import(dist + "pool/v3/replay-store.js");
const { StateHandle } = await import(dist + "pool/v3/state.js");
const { fieldToBytes } = await import(dist + "pool/field.js");

function probe(n) {
  const seed = randomBytes(32), domain = new Uint8Array(32).fill(9), backing = new Uint8Array(32).fill(1);
  const store = new ReplayStore(), genesis = { history: new Uint8Array(32), evidence: new Uint8Array(32) };
  const ns = store.open(new Uint8Array(32), new Uint8Array(32), undefined, genesis), witness = seedWitness(seed, domain);
  let identity = 1n;
  const append = (outputs, nfs) => store.append(ns, { identity: fieldToBytes(identity++), kind: 2, index: 5n, record: new Uint8Array([1]),
    proofHash: new Uint8Array(32), signatureHash: new Uint8Array(32), evidence: new Uint8Array(32), supply: undefined,
    nullifiers: nfs.map(nf => ({ nf, tag: 1n })),
    outputs: outputs.map(o => ({ cm: o.cm, capsule: o.capsule, settlement: false, witness: witness({ cm: o.cm, capsule: o.capsule }) })),
    demand: undefined, ended: undefined, keys: [], history: () => new Uint8Array(32) });
  const received = [];
  for (let i = 0; i < n; i += 4) {
    const outputs = Array.from({ length: 4 }, () => prepareExactOutput(seed, domain, randomBytes(32), backing, 3n));
    received.push(...outputs);
    append(outputs, []);
  }
  for (let i = 0; i < n; i += 4) append([], [received[i].nf, received[i + 2].nf]);
  const state = new StateHandle(store, ns);
  let start = performance.now();
  const notes = ownedNotes(seed, domain, backing, state);
  const read = performance.now() - start;
  start = performance.now();
  for (const note of notes.slice(0, 2)) void note.secret, void note.path;
  const spend = performance.now() - start;
  store.close();
  return { outputs: n, held: notes.length, readMs: Math.round(read), perOutputMs: Number((read / n).toFixed(3)), twoInputsMs: Number(spend.toFixed(1)) };
}

for (const n of (counts.length > 0 ? counts : ["2000", "20000"]).map(Number)) console.log(JSON.stringify(probe(n)));
