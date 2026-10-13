import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { encodeReceipt, receiptBytes, type Receipt, type ReceiptFields } from "../src/pool/v3/commitments.js";
import { adoptedConfigurationBytes, adoptedDomain } from "../src/pool/v3/configuration.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { encodeEvidenceDirectory, encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord, evidenceHashes, type Record as StatementRecord } from "../src/pool/v3/records.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import { MAX_V3_SERVICE_REPLY_BYTES, replyFromReceipt, replyFromCommitment, servedFrames } from "../src/pool/v3/service-wire.js";
import type { ServedEvidence } from "../src/pool/v3/store.js";
import { encodeCommitment, signCommitment } from "../src/venue-records.js";

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const domain = adoptedDomain(), segment = b(2), secret = b(3), operator = ed25519.getPublicKey(secret), backing = b(4);
const reference = { context: LOCAL_REFERENCE, label: b(5), lag: 2n } as const;
const expected = () => ({ operator: operator.slice(), reference: { ...reference, label: reference.label.slice() } });
// A bounded burn-lock record gives changed-proof retries without capsule fixtures.
const record = (): StatementRecord => ({ domain, kind: 4, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 7n,
  ...limbsOf(backing), 10n, 11n, 12n, 13n, 14n, ...limbsOf(b(6)), 20n, 30n],
  proof: b(7), authorization: new Uint8Array(), capsules: [] });
const receipt = (fields: Partial<ReceiptFields> = {}, signingKey = secret) => {
  const r = { domain, segment, scopeRoot: 7n, position: 1n, ...evidenceHashes(record()), historyHash: b(8), after: 1n, ...fields };
  return encodeReceipt({ ...r, operator: ed25519.getPublicKey(signingKey), signature: ed25519.sign(receiptBytes(r), signingKey) });
};
/** A directory naming no snapshot, so a store that holds it holds all the selection needs; its hash is the root. */
const directory = encodeEvidenceDirectory([]), root = sha256(directory);
/** A selection whose own package carries the configuration and the commitment it names (sequence 1 unless `selected`), and no
 * further parts. */
const served = (signer = secret, sequence = 1n, selected = 1n, named = root): ServedEvidence => ({ selection: { domain, operator,
  venue: localVenueIdentity(reference.label, reference.lag), backing, sequence: selected, root: named },
  package: encodeEvidencePackage([{ kind: 1, payload: adoptedConfigurationBytes() }, { kind: 2, payload: encodeCommitment(signCommitment(signer, sequence, named)) }]),
  parts: [] });
const servers: Server[] = [];
async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
const responding = (body: unknown) => endpoint((request, response) => {
  request.resume(); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
});
/** Answers every request with `value` as a served stream. */
const serving = (value: ServedEvidence, seen: (url: string | undefined) => void = () => {}) => endpoint(async (request, response) => {
  seen(request.url); request.resume(); response.setHeader("content-type", "application/octet-stream");
  for await (const chunk of servedFrames(value)) response.write(chunk);
  response.end();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("bounded v3 local service client", () => {
  it("owns expected routing and submitted bytes, verifies acceptance, and allows changed-proof retry", async () => {
    const encoded = encodeRecord(record()), original = encoded.slice(), authority = expected();
    const url = await endpoint((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { record: string };
        expect(command.record).toBe(bytesToHex(original));
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify(replyFromReceipt(receipt())));
      });
    });
    const client = new V3ServiceClient(url, TOKEN, authority, ADMIN);
    authority.operator.fill(0); authority.reference.label.fill(0);
    const submitted = client.submit(encoded); encoded.fill(0);
    expect((await submitted).position).toBe(1n);
    expect(JSON.stringify(client)).not.toContain(TOKEN); expect(JSON.stringify(client)).not.toContain(ADMIN);
    const replayUrl = await responding(replyFromReceipt(receipt()));
    const changed = record(); changed.proof.fill(10);
    const retried = await new V3ServiceClient(replayUrl, TOKEN, expected()).submit(encodeRecord(changed));
    expect((retried as Receipt).proofHash).not.toEqual(evidenceHashes(changed).proofHash);
  });

  it("rejects signed receipts for another statement, segment, scope, domain or operator and invalid signatures", async () => {
    const invalidSignature = receipt(); invalidSignature[invalidSignature.length - 1]! ^= 1;
    for (const bytes of [receipt({ statementHash: b(20) }), receipt({ segment: b(21) }), receipt({ scopeRoot: 8n }),
      receipt({ domain: b(22) }), receipt({}, b(23)), invalidSignature]) {
      const url = await responding(replyFromReceipt(bytes));
      await expect(new V3ServiceClient(url, TOKEN, expected()).submit(encodeRecord(record()))).rejects.toThrow("receipt does not authenticate the submitted statement");
    }
  });

  it("sends nothing for a statement under a domain other than the adopted configuration's", async () => {
    let asked = false;
    const url = await endpoint((request, response) => { asked = true; request.resume(); response.end(); });
    const foreign = { ...record(), domain: b(9), publicInputs: [...limbsOf(b(9)), ...record().publicInputs.slice(2)] };
    await expect(new V3ServiceClient(url, TOKEN, expected()).submit(encodeRecord(foreign))).rejects.toThrow("wrong submission domain or kind");
    expect(asked).toBe(false);
  });

  it("requires admin credentials and binds signed commit and publish replies to the expected operator", async () => {
    const commitment = signCommitment(secret, 2n, b(24));
    const url = await endpoint((request, response) => {
      request.resume(); expect(request.headers.authorization).toBe(`Bearer ${ADMIN}`);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(replyFromCommitment("committed", commitment)));
    });
    await expect(new V3ServiceClient(url, TOKEN, expected()).commit("test")).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    expect(await new V3ServiceClient(url, TOKEN, expected(), ADMIN).commit("test")).toEqual(commitment);
    for (const kind of ["committed", "published"] as const) {
      const wrong = await responding(replyFromCommitment(kind, signCommitment(b(25), 2n, b(24))));
      const client = new V3ServiceClient(wrong, TOKEN, expected(), ADMIN);
      await expect(kind === "committed" ? client.commit("test") : client.publish()).rejects.toThrow("wrong commitment authority");
    }
  });

  it("pins evidence routing and context without treating served metadata as a finality verdict", async () => {
    const good = served(), paths: (string | undefined)[] = [];
    const url = await serving(good, path => paths.push(path));
    expect(await new V3ServiceClient(url, TOKEN, expected()).package(backing)).toEqual({ selection: good.selection, package: good.package });
    // The holder names its own backing; a multi-backing service selects it. A whole package is served from nothing.
    expect(paths).toEqual([`/evidence?backing=${Buffer.from(backing).toString("hex")}&after=0`]);
    for (const field of ["domain", "venue", "operator", "backing"] as const) {
      const wrong = await serving({ ...good, selection: { ...good.selection, [field]: b(26) } });
      await expect(new V3ServiceClient(wrong, TOKEN, expected()).package(backing)).rejects.toThrow("wrong service package context");
    }
    // The read's own package must carry the named commitment, signed by the expected operator: a sequence
    // recorded as served is one that operator signed.
    for (const wrong of [served(b(25)), served(secret, 2n), { ...good, selection: { ...good.selection, root: b(27) } },
      { ...good, package: encodeEvidencePackage([{ kind: 1, payload: adoptedConfigurationBytes() }]) }]) {
      await expect(new V3ServiceClient(await serving(wrong), TOKEN, expected()).package(backing)).rejects.toThrow("wrong commitment authority");
    }
    // Its one configuration is the construction's: another, none or two is the source's malformed answer, which a read
    // passes over, rather than a refusal of the read itself that no other source could repair (audit 32).
    const commitment = { kind: 2, payload: encodeCommitment(signCommitment(secret, 1n, root)) }, flipped = adoptedConfigurationBytes();
    flipped[flipped.length - 1]! ^= 1;
    for (const items of [[{ kind: 1, payload: flipped }, commitment], [commitment], [{ kind: 1, payload: adoptedConfigurationBytes() }, { kind: 1, payload: flipped }, commitment]]) {
      const own = encodeEvidencePackage(items.sort((x, y) => x.kind - y.kind || Buffer.compare(sha256(x.payload), sha256(y.payload))));
      await expect(new V3ServiceClient(await serving({ ...good, package: own }), TOKEN, expected()).package(backing))
        .rejects.toThrow("the read's own package names another configuration");
    }
    // It may carry the §9 faults one read takes (32 items, 1 MiB; §9.1, Next 4 (bk)), kept with the selection and served
    // on; another kind, or faults past that budget, is the source's malformed answer.
    const configured = { kind: 1, payload: adoptedConfigurationBytes() }, ordered = (items: { kind: number; payload: Uint8Array }[]) =>
      encodeEvidencePackage(items.sort((x, y) => x.kind - y.kind || Buffer.compare(sha256(x.payload), sha256(y.payload))));
    const faults = (count: number, size = 1) => Array.from({ length: count }, (_, i) => ({ kind: 7, payload: new Uint8Array(size).fill(i) }));
    const carrying = ordered([configured, commitment, ...faults(32)]);
    expect(await new V3ServiceClient(await serving({ ...good, package: carrying }), TOKEN, expected()).package(backing))
      .toEqual({ selection: good.selection, package: carrying });
    const largest = ordered([configured, commitment, ...faults(1, 1_048_576)]);
    expect((await new V3ServiceClient(await serving({ ...good, package: largest }), TOKEN, expected()).package(backing)).package).toEqual(largest);
    for (const [items, refusal] of [[[configured, commitment, { kind: 4, payload: b(31) }], "carries more than its configuration, commitment and faults"],
      [[configured, commitment, { kind: 10, payload: b(31) }], "carries more than its configuration, commitment and faults"],
      [[configured, commitment, ...faults(33)], "carries more faults than a read takes"],
      [[configured, commitment, ...faults(2, 524_289)], "carries more faults than a read takes"]] as const) {
      await expect(new V3ServiceClient(await serving({ ...good, package: ordered([...items]) }), TOKEN, expected()).package(backing))
        .rejects.toThrow(`the read's own package ${refusal}`);
    }
    // A response past the caller's budget is refused as it arrives.
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing, 100n)).rejects.toThrow("served evidence exceeds the reader's budget");
    // A JSON body where a stream is expected is no served evidence.
    const json = await responding({ code: "OK" });
    await expect(new V3ServiceClient(json, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
  });

  it("keeps served parts in the caller's store, records the signed sequence, and refuses a part it does not read", async () => {
    // The operator's service has one mark at whatever URL; a replica (no credential) has its own per URL (M12b).
    const operatorSource = Buffer.concat([domain, localVenueIdentity(reference.label, reference.lag), operator]), object = b(30);
    const source = (url?: string) => url === undefined ? operatorSource : Buffer.concat([operatorSource, Buffer.from(url)]);
    const store = new EvidenceStore(), good = { ...served(), parts: [{ package: encodeEvidencePackage([{ kind: 3, payload: directory }, { kind: 4, payload: object }]) }] };
    const goodUrl = await serving(good);
    expect(await new V3ServiceClient(goodUrl, TOKEN, expected()).sync(backing, store)).toEqual({ selection: good.selection, package: good.package });
    expect([store.suppliedThrough(source()), store.retained().snapshot(sha256(object))]).toEqual([1n, object]);
    // A later selection with no parts over a store that holds its directory is a complete answer: nothing is new.
    const asked: (string | undefined)[] = [], quiet = await serving(served(secret, 2n, 2n), url => asked.push(url));
    await new V3ServiceClient(quiet, TOKEN, expected()).sync(backing, store);
    expect([store.suppliedThrough(source()), asked.map(url => url?.split("&")[1])]).toEqual([2n, ["after=1"]]);
    // One that states a sequence and leaves its directory out, an empty answer included, is refused from the mark and
    // from nothing alike, and moves no mark: so no later sync of the operator, at any URL, skips what it left out.
    const withheld = await serving(served(secret, 5n, 5n, b(31)), url => asked.push(url));
    await expect(new V3ServiceClient(withheld, TOKEN, expected()).sync(backing, store)).rejects.toThrow("served evidence does not assemble");
    expect([store.suppliedThrough(source()), asked.slice(1).map(url => url?.split("&")[1])]).toEqual([2n, ["after=2", "after=0"]]);
    const empty = new EvidenceStore();
    await expect(new V3ServiceClient(quiet, TOKEN, expected()).sync(backing, empty)).rejects.toThrow("served evidence does not assemble");
    expect(empty.suppliedThrough(source())).toBe(0n);
    // A replica's mark is its own: the operator's is not asked of it, nor its of the operator.
    const replicaStore = new EvidenceStore();
    await new V3ServiceClient(goodUrl, undefined, expected()).sync(backing, replicaStore);
    expect([replicaStore.suppliedThrough(source()), replicaStore.suppliedThrough(source(goodUrl))]).toEqual([0n, 1n]);
    replicaStore.close();
    // A kind no v3 reader reads refuses the sync, and another context is refused before any part is kept: no sequence is recorded.
    const other = new EvidenceStore(), unread = { ...served(), parts: [{ package: encodeEvidencePackage([{ kind: 9, payload: object }]) }] };
    const unreadUrl = await serving(unread), wrongUrl = await serving({ ...good, selection: { ...good.selection, venue: b(26) } });
    await expect(new V3ServiceClient(unreadUrl, TOKEN, expected()).sync(backing, other)).rejects.toMatchObject({ status: "unsupported-scope" });
    await expect(new V3ServiceClient(wrongUrl, TOKEN, expected()).sync(backing, other)).rejects.toThrow("wrong service package context");
    expect([other.suppliedThrough(source()), other.retained().snapshot(sha256(object))]).toEqual([0n, undefined]);
    for (const opened of [store, empty, other]) opened.close();
  });

  it("rejects remote or ambiguous URLs and malformed credentials before a request", () => {
    for (const url of ["https://127.0.0.1/", "http://example.com/", "http://127.0.0.1/path", "http://127.0.0.1/?token=x",
      "http://user:pass@127.0.0.1/", "http://localhost/", "http://example.onion/", `https://${"a".repeat(55)}d.onion/`]) {
      expect(() => new V3ServiceClient(url, TOKEN, expected())).toThrow("a local or onion URL and distinct 32-byte credentials required");
    }
    expect(() => new V3ServiceClient("http://127.0.0.1/", TOKEN, expected(), TOKEN)).toThrow("distinct 32-byte credentials required");
    expect(() => new V3ServiceClient("http://127.0.0.1/", "bad", expected())).toThrow("distinct 32-byte credentials required");
  });

  it("refuses redirects without forwarding bearer credentials to the destination", async () => {
    let contacted = false;
    const target = await endpoint((_, response) => { contacted = true; response.end(); });
    const url = await endpoint((_, response) => { response.writeHead(302, { location: target }); response.end(); });
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
    expect(contacted).toBe(false);
  });

  it("bounds declared and chunked reply bodies before parsing", async () => {
    for (const declared of [false, true]) {
      const url = await endpoint((_, response) => {
        response.setHeader("content-type", "application/json");
        if (declared) response.setHeader("content-length", String(MAX_V3_SERVICE_REPLY_BYTES + 1));
        else response.flushHeaders();
        response.end(" ".repeat(MAX_V3_SERVICE_REPLY_BYTES + 1));
      });
      await expect(new V3ServiceClient(url, TOKEN, expected(), ADMIN).commit("test")).rejects.toThrow("response too large");
    }
  });

  it("rejects malformed UTF-8, response compression and untrusted error text", async () => {
    const utf8 = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.end(Buffer.from([0xff])); });
    await expect(new V3ServiceClient(utf8, TOKEN, expected(), ADMIN).commit("test")).rejects.toThrow(/JSON|UTF-8/);
    const compressed = await endpoint((_, response) => {
      response.setHeader("content-type", "application/octet-stream"); response.setHeader("content-encoding", "br"); response.end();
    });
    await expect(new V3ServiceClient(compressed, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
    const error = await endpoint((_, response) => {
      response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: `secret ${TOKEN}` }));
    });
    await expect(new V3ServiceClient(error, TOKEN, expected()).package(backing)).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
    const refused = await endpoint((_, response) => { response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "FENCED" })); });
    await expect(new V3ServiceClient(refused, TOKEN, expected()).package(backing)).rejects.toMatchObject({ code: "FENCED", status: 409 });
  });

  it("stops waiting on a source that drips evidence below the minimum rate, as a source that did not answer", async () => {
    // A valid selection, then a trail of a terabyte, one byte at a time: each byte comes within the stall bound, and
    // the clock moves three seconds per byte, so the waits pass fifteen seconds.
    const head: Uint8Array[] = [];
    for await (const chunk of servedFrames({ ...served(), parts: [{ trail: { size: 1n << 40n, chunks: [] } }] })) {
      head.push(chunk);
      if (head.length === 2) break;
    }
    // The clock moves only while it is faked: a tick after the test ends never installs a frozen clock for the next.
    let faking = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const url = await endpoint((request, response) => {
        request.resume(); response.setHeader("content-type", "application/octet-stream"); response.writeHead(200);
        for (const chunk of head) response.write(chunk);
        const tick = setInterval(() => { if (faking) vi.setSystemTime(Date.now() + 3_000); response.write(Uint8Array.of(0x70)); }, 5);
        response.once("close", () => clearInterval(tick));
      });
      await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toMatchObject({ name: "TimeoutError" });
    } finally { faking = false; vi.useRealTimers(); }
  });

  it("aborts a real server that stalls after response headers", async () => {
    const url = await endpoint((_, response) => { response.setHeader("content-type", "application/octet-stream"); response.flushHeaders(); });
    const started = Date.now();
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 15_000);
});

// Next 4 (bj): through a proxy, as Tor's HTTPTunnelPort answers. A fresh client's first circuit took up to 25 s on the
// live network, so an onion's response may begin past the ten-second bound. A proxy's refusal to tunnel a URL that is
// no onion (Tor refuses an internal address 403) is the holder's own route, named with its status; any refusal for an
// onion leaves a service that did not answer, 403 included, which Tor also sends for the service's own END reasons
// (connection refused or reset). Each client runs in a child (onion-client.child.ts, under vite-node, which vitest 3
// installs; a later vitest without it needs another TypeScript runner here).
describe("the service client through a proxy (Next 4 (bj))", () => {
  const ONION = `${"m".repeat(55)}d.onion`, DOWN = `${"n".repeat(55)}d.onion`, REFUSED = `${"o".repeat(55)}d.onion`, CIRCUIT_MS = 11_000;
  const PROXY_VARIABLES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_OPTIONS"];
  /** A CONNECT-only proxy: `ONION` to `port` once the circuit's delay has passed, 503 for `DOWN`, 403 for `REFUSED` (as
   * Tor relays a service's refused connection) and for anything else (as Tor refuses an internal address). */
  async function proxy(port: () => number): Promise<number> {
    const server = createServer((_, response) => response.writeHead(405).end()).on("connect", (request, client, head) => {
      if (request.url === `${DOWN}:80`) { client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
      if (request.url === `${REFUSED}:80`) { client.end("HTTP/1.0 403 Forbidden (connection refused)\r\n\r\n"); return; }
      if (request.url !== `${ONION}:80`) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const circuit = setTimeout(() => {
        const upstream = connect(port(), "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy()); client.on("close", () => upstream.destroy());
      }, CIRCUIT_MS);
      client.on("error", () => clearTimeout(circuit)); client.on("close", () => clearTimeout(circuit));
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    return (server.address() as { port: number }).port;
  }
  const children: ReturnType<typeof spawn>[] = [];
  afterEach(() => { for (const child of children.splice(0)) child.kill(); });
  /** The client's answer for `url` from a process with Node's environment proxy at `proxied`. */
  async function client(url: string, proxied: number): Promise<Record<string, unknown>> {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_VARIABLES.includes(key))) as Record<string, string>;
    const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "vite-node", "vite-node.mjs");
    const child = join(dirname(fileURLToPath(import.meta.url)), "onion-client.child.ts");
    const out = await new Promise<string>((done, failed) => {
      const process_ = spawn(process.execPath, [runner, child, url, bytesToHex(operator), bytesToHex(reference.label), String(reference.lag), bytesToHex(backing)],
        { env: { ...base, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxied}` }, stdio: ["ignore", "pipe", "inherit"] });
      children.push(process_);
      let text = ""; process_.stdout.on("data", chunk => { text += chunk; }); process_.on("error", failed); process_.on("close", () => done(text));
    });
    expect(out.trim(), `the client for ${url} printed nothing`).not.toBe("");
    return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
  }

  it("waits past the bound for an onion's circuit, names a refused tunnel to a loopback URL PROXY and leaves a failed onion unanswered", async () => {
    const service = await serving(served()), port = Number(new URL(service).port), proxied = await proxy(() => port);
    const [onion, internal, down, refused] = await Promise.all([client(`http://${ONION}/`, proxied), client(service, proxied),
      client(`http://${DOWN}/`, proxied), client(`http://${REFUSED}/`, proxied)]);
    // Read through a circuit that took longer than the bound a loopback listener has.
    expect(onion).toMatchObject({ sequence: "1" });
    expect(onion["ms"]).toBeGreaterThan(CIRCUIT_MS);
    // A loopback URL that the environment proxy tunnels is refused by the proxy (as by Tor), and named so.
    expect(internal).toMatchObject({ name: "V3ServiceClientError", code: "PROXY", status: 0, message: "the proxy refused the tunnel (403)" });
    // The proxy's answer for an onion that failed, 403 included: the service did not answer (`unanswered`,
    // src/cli/reader.ts), so a holder passes to a replica, then its kept package.
    expect(down).toMatchObject({ name: "TypeError", message: "fetch failed" });
    expect(refused).toMatchObject({ name: "TypeError", message: "fetch failed" });
  }, 25_000);
});
