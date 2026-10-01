// One store-check drill: actual holder/backer proving, one of three venues and a
// fresh holder-only reader process. local: the fixture venue at lag 2. ergo: the
// actual ErgoPublisher, mined by a synthetic supplier under the synthetic reference
// (depth 1). testnet: the own live node, only on explicit --testnet
// --authorized-testnet, every broadcast first passing the check's publication budget.
// The reader holds its keys, pin and (live) reader selection outside the package.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { serialize, deserialize } from "node:v8";
import { UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { ErgoVenue } from "../../../dist/ergo.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../../../dist/ergo-profile.js";
import { DEFAULT_ERGO_FEE, ErgoPublisher, readPlainBox, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { BranchSupplier, MiningSupplier, plainBox } from "../../../dist/ergo-synthetic.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { PROOF_OPTIONS, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { field } from "../fixtures.mjs";
import { RELATION_KINDS, loadManifest, checkSources, adoptedDomain, readKeys } from "./manifest.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { ERGO_CHAIN, ERGO_PROFILE } from "./ergo-check.mjs";
import { publicArtifactFiles } from "./public-artifacts.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex");
const LABEL = b(12), LAG = 2n, FUNDING = 200_000_000n;
const FLAGS = { local: [], ergo: ["--ergo"], testnet: ["--testnet"] };
const EVIDENCE = { local: "local-runtime-real-proofs", ergo: "synthetic-ergo-runtime-real-proofs", testnet: "live-testnet-runtime-real-proofs" };
const SUFFIX = { local: "", ergo: "-ergo", testnet: "-testnet" };
const referenceFor = mode => mode === "ergo" ? { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE } : { context: LOCAL_REFERENCE, label: LABEL, lag: LAG };

/** The acceptance mode from a check's arguments; live only when the check offers it and both flags are given. */
export function drillMode(argv, name, { testnet = false } = {}) {
  if (argv.length === 0) return "local";
  if (argv.length === 1 && argv[0] === "--ergo") return "ergo";
  if (testnet && argv.length === 2 && argv[0] === "--testnet" && argv[1] === "--authorized-testnet") return "testnet";
  throw new Error(`${name} takes --ergo${testnet ? " or explicit --testnet --authorized-testnet" : ""}`);
}

/** A fresh holder-only reader: `<check> --worker <directory> [--ergo|--testnet]`, the input on stdin; --testnet only for a check with a live mode. */
export async function drillWorker(argv, answer, { testnet = false } = {}) {
  assert(argv.length === 1 || (argv.length === 2 && ["--ergo", ...(testnet ? ["--testnet"] : [])].includes(argv[1])), "worker takes a directory and a mode flag");
  const directory = argv[0], mode = argv[1] === "--ergo" ? "ergo" : argv[1] === "--testnet" ? "testnet" : "local";
  const manifest = loadManifest(); checkSources(manifest);
  const keys = readKeys(directory, manifest);
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; assert(length <= 4_194_304, "worker input budget"); chunks.push(chunk); }
  const input = deserialize(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(input).sort(), mode === "testnet" ? ["package", "selection"] : ["package", "selection", "venue"]);
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  try {
    const backend = new UltraHonkVerifierBackend(api), verifier = { verify: (kind, publicInputs, proof) =>
      backend.verifyProof({ proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind) }, PROOF_OPTIONS) };
    const pin = () => new Uint8Array(readFileSync(join(directory, "ergo-pin.bin")));
    let venue, reference = referenceFor(mode);
    if (mode === "testnet") {
      const testnet = await import("./testnet.mjs"), selected = testnet.readTestnetSelection(join(directory, "testnet-reader.json"));
      assert.equal(input.selection.judgingIndex, selected.judgingIndex);
      venue = await testnet.testnetVenue(selected, pin());
      assert(venue !== undefined, "independent testnet pin unavailable");
      reference = { context: selected.profile.reference, profile: selected.profile };
    } else if (mode === "ergo") {
      venue = new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context);
      const synced = await venue.sync([new BranchSupplier("holder-only", input.venue.tip, ERGO_CHAIN)]);
      assert.equal(hex(synced.witnessedHeaderId), hex(pin()));
    } else venue = FixtureVenue.from(input.venue);
    process.stdout.write(JSON.stringify(await answer(input, { verifier, venue, reference })));
  } finally { await api.destroy(); }
}

/**
 * Compile the pinned circuits into a scratch build, derive their keys under the
 * manifest, open the prover and the mode's venue. `budget` (testnet only) is the
 * check's pre-broadcast publication budget from testnet-budget.mjs.
 */
export async function openDrill(mode, { name, script, budget }) {
  assert(mode in FLAGS && (mode === "testnet") === (budget !== undefined), "a live drill, and only it, takes a publication budget");
  mkdirSync(join(root, "scratch"), { recursive: true });
  const scratch = realpathSync(join(root, "scratch")), build = realpathSync(mkdtempSync(join(scratch, `v3-${name}-`)));
  const started = performance.now(), checks = [], proofs = [], packages = [], transactions = [];
  const sources = sourceClosure([script, "scripts/pool/v3/compile.mjs",
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(circuit => `scripts/pool/v3/circuits/${circuit}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const hashes = sourceHashes(sources);
  let api, prover, live;
  const close = async () => { await prover?.close(); await api?.destroy(); };
  try {
    const manifest = loadManifest(); checkSources(manifest);
    execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
    api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const programs = Object.fromEntries(RELATION_KINDS.map(([, circuit]) => [circuit, JSON.parse(readFileSync(join(build, `${circuit}.json`), "utf8"))]));
    for (const [kind, circuit] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[circuit].bytecode, api).getVerificationKey(PROOF_OPTIONS));
    readKeys(build, manifest);
    prover = await openV3Prover(api, programs);

    const testnet = mode === "testnet" ? await import("./testnet.mjs") : undefined;
    live = testnet === undefined ? undefined : await testnet.openTestnet({ authorizeSubmission: budget.authorizeSubmission });
    const supplier = mode === "ergo" ? new MiningSupplier(`${name}-synthetic`, ERGO_CHAIN, verifyErgoProof) : undefined;
    const publisher = supplier === undefined ? undefined : new ErgoPublisher({ secretKey: b(17), suppliers: [supplier.mempool] });
    const venue = live?.venue ?? (supplier !== undefined ? new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context, {}, publisher) : FixtureVenue.reference(LABEL, LAG));
    const reference = live?.reference ?? referenceFor(mode);
    let pin;
    // Witness `count` more indices: the fixture moves, the synthetic chain mines, the live node is waited on.
    const advance = async count => {
      assert(count >= 0n && count <= 1024n);
      if (live !== undefined) {
        // At most eight indices per wait, so each step keeps its own wait budget on slow blocks.
        const target = venue.witnessedIndex() + count;
        while (venue.witnessedIndex() < target) {
          const next = venue.witnessedIndex() + 8n; await live.waitUntil(next < target ? next : target); pin = live.pin;
        }
      }
      else if (supplier !== undefined) {
        for (const tx of supplier.mempool.pool) transactions.push({ unsignedBytes: tx.unsigned.length });
        supplier.mine(Number(count)); const synced = await venue.sync([supplier]);
        assert.equal(synced.unresolvedIndex, undefined); pin = synced.witnessedHeaderId;
      } else venue.advance(venue.witnessedIndex() + count);
    };
    if (supplier !== undefined) { supplier.mempool.fund(plainBox(publisher.tree, FUNDING, ERGO_CHAIN.anchor.height)); await advance(LAG); }
    if (live !== undefined) pin = live.pin;

    const drill = {
      mode, build, venue, reference, checks, proofs, packages, transactions, live,
      domain: adoptedDomain(), manifest, prover, verifier: prover.verifier,
      /** The fixture and synthetic lag; the live venue's own (its depth + 1). */
      lag: live?.venue.lag() ?? LAG,
      /** Indices a live record may take to be included after the index it was signed at; none off the live node. */
      inclusionSlack: live === undefined ? 0n : 8n,
      advance,
      /** Bring the live view up to date; a fixed venue has nothing to fetch. */
      sync: async () => { if (live !== undefined) { await live.sync(); pin = live.pin; } },
      async test(label, fn) { await fn(); checks.push(label); process.stderr.write(`passed: ${label}\n`); },
      async prove(task, label) {
        const began = performance.now(), record = await prover.prove(task);
        proofs.push({ name: label, kind: task.kind, bytes: record.proof.length, elapsedMs: Math.round(performance.now() - began) }); return record;
      },
      /** Publish a venue record and wait until it is witnessed; live, return the index that included it. */
      async publishRecord(kind, subject, bytes) {
        await venue.publishRecord(kind, subject, bytes);
        if (live !== undefined) { const at = await live.waitForRecord(kind, subject, bytes); pin = live.pin; return at; }
        if (supplier !== undefined) await advance(LAG);
        return undefined;
      },
      /** Publish a journal's pending commitment and wait until it is witnessed. */
      async publish(journal) {
        const commitment = await journal.publish();
        if (live !== undefined) { await live.waitFor(commitment); pin = live.pin; }
        else if (supplier !== undefined) await advance(LAG);
        return commitment;
      },
      async checkpoint(journal, id) { await journal.commit(id); return drill.publish(journal); },
      /** A served package at the current witnessed index, with what a reader of this mode receives beside it. */
      served(value) {
        packages.push(value.package.length);
        return { package: value.package, selection: { ...value.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
          ...drill.venueInput() };
      },
      venueInput: () => live !== undefined ? {} : supplier !== undefined ? { venue: { tip: supplier.tip } } : { venue: venue.export() },
      /** The reader's own trust inputs beside its keys: the witnessed pin and, live, its selection. */
      writeReaderInputs(directory, config = live?.readerConfig()) {
        if (pin !== undefined) writeFileSync(join(directory, "ergo-pin.bin"), pin);
        if (live !== undefined) writeFileSync(join(directory, "testnet-reader.json"), JSON.stringify(config, null, 2) + "\n");
      },
      /** Read `input` in a fresh process holding only public artifacts, keys and its own trust inputs. */
      fresh(input) {
        drill.writeReaderInputs(build);
        const child = spawnSync(process.execPath, [script, "--worker", build, ...FLAGS[mode]],
          { input: serialize(input), cwd: root, timeout: 300_000, windowsHide: true, maxBuffer: 1_048_576 });
        assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString()); return JSON.parse(child.stdout.toString());
      },
      /** Live only: a public reader bundle under scratch, re-readable with `<check> --worker <directory> --testnet < <name>.bin`. */
      keepReader(directory, inputs, readback) {
        assert(live !== undefined);
        const target = join(scratch, directory); mkdirSync(target, { recursive: true });
        for (const [file, bytes] of publicArtifactFiles(build, manifest)) writeFileSync(join(target, file), bytes);
        for (const [label, input] of Object.entries(inputs)) writeFileSync(join(target, `${label}.bin`), serialize(input));
        drill.writeReaderInputs(target);
        writeFileSync(join(target, "readback.json"), JSON.stringify(readback, null, 2) + "\n");
        return { directory: `scratch/${directory}`, inputs: Object.keys(inputs).map(label => `${label}.bin`) };
      },
      /** What the drill's publications cost: the live budget's ledger or the synthetic funding box's change. */
      async funding() {
        if (live !== undefined) return budget.report();
        if (supplier === undefined) return undefined;
        const change = (await supplier.mempool.unspentBoxes(publisher.tree)).map(bytes => readPlainBox(bytes, publisher.tree));
        assert(change.every(box => box !== undefined));
        const spent = FUNDING - change.reduce((sum, box) => sum + box.value, 0n), fees = DEFAULT_ERGO_FEE * BigInt(transactions.length);
        return { initialNanoErg: String(FUNDING), spentNanoErg: String(spent), feeNanoErg: String(fees), recordMinimumNanoErg: String(spent - fees) };
      },
      /** Write `docs/pool-v3-<name>[-ergo|-testnet]-verification.json` after the sources are seen unchanged. */
      report(fields) {
        checkSources(manifest); assert.deepEqual(sourceHashes(sources), hashes, "sources changed during acceptance");
        const elapsedMs = Math.round(performance.now() - started);
        const report = { status: "passed", specification: V3_SPECIFICATION, evidence: EVIDENCE[mode], ...fields,
          ...(live === undefined ? {} : { live: { ...live.readerConfig(), witnessedBlock: hex(pin), tipHeight: live.tipHeight.toString(),
            submittedTransactions: live.submitted } }),
          elapsedMs, sourceSha256Lf: hashes };
        writeFileSync(join(root, "docs", `pool-v3-${name}${SUFFIX[mode]}-verification.json`), JSON.stringify(report, null, 2) + "\n");
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return report;
      },
      /** Close the prover; delete the build after success, keep it for diagnosis after a failure. */
      async close(completed) {
        await close();
        if (completed) { assert(build.startsWith(scratch + sep)); rmSync(build, { recursive: true, force: true }); }
        else process.stderr.write(`${name} acceptance scratch retained after failure: ${build}\n`);
      },
    };
    return drill;
  } catch (error) {
    await close(); process.stderr.write(`${name} acceptance scratch retained after failure: ${build}\n`); throw error;
  }
}
