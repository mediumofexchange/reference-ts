// Source-checkout CLI; npm run build first. All keys stay in local files.
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeBacking, decodeBacking, encodeBacking, signBacking } from '@mediumofexchange/reference/backing';
import { encodePublishedOp, opMessageOfEntry } from '@mediumofexchange/reference/oplog';
import { PilotStore } from '@mediumofexchange/reference/pilot-store';
import { createPilotServer } from '@mediumofexchange/reference/pilot-http';
import { hex, index, localViewFromWire, receiptFromWire, stateFromWire, verifyPilotPayment } from '@mediumofexchange/reference/pilot-wire';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
function save(file, value) {
  // Exclusive creation protects a saved request/key from accidental replacement.
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function wallet(file) {
  const w = read(file), secret = hex(w.secret, 32, 32);
  if (bytesToHex(ed25519.getPublicKey(secret)) !== w.publicKey) throw new Error('wallet key mismatch');
  return { secret, publicKey: hex(w.publicKey, 32, 32) };
}
async function call(config, path, command) {
  const url = new URL(config.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('this pilot CLI only connects to loopback HTTP');
  }
  const response = await fetch(new URL(path, url), {
    method: command === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(command === undefined ? {} : { body: JSON.stringify(command) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.code ?? 'request failed'}`);
  return result;
}
const output = value => console.log(JSON.stringify(value));

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'init') {
    const directory = resolve(args[0]), port = Number(args[1] ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const secret = randomBytes(32), operator = bytesToHex(ed25519.getPublicKey(secret));
    const venue = bytesToHex(randomBytes(32)), walletToken = bytesToHex(randomBytes(32)), adminToken = bytesToHex(randomBytes(32));
    const url = `http://127.0.0.1:${port}`;
    save(join(directory, 'operator.key.json'), { secret: bytesToHex(secret), publicKey: operator });
    save(join(directory, 'server.json'), { operator, venue, walletToken, adminToken, port });
    save(join(directory, 'wallet-client.json'), { operator, venue, url, token: walletToken });
    save(join(directory, 'admin-client.json'), { operator, venue, url, token: adminToken });
    output({ directory, operator, venue, url }); return;
  }
  if (action === 'serve') {
    const directory = resolve(args[0]), config = read(join(directory, 'server.json'));
    const key = wallet(join(directory, 'operator.key.json'));
    if (bytesToHex(key.publicKey) !== config.operator) throw new Error('server key mismatch');
    const store = new PilotStore(join(directory, 'journal.sqlite'), key.secret, hex(config.venue, 32, 32));
    const server = createPilotServer(store, config);
    server.listen(config.port, '127.0.0.1', () => output({ ready: true, url: `http://127.0.0.1:${config.port}` }));
    const stop = () => server.close(() => { store.close(); process.exit(0); });
    process.on('SIGINT', stop); process.on('SIGTERM', stop); return;
  }
  if (action === 'wallet') {
    const secret = randomBytes(32), publicKey = bytesToHex(ed25519.getPublicKey(secret));
    save(args[0], { secret: bytesToHex(secret), publicKey }); output({ publicKey }); return;
  }
  if (action === 'terms') {
    const [clientFile, issuerFile, termsFile] = args, config = read(clientFile), key = wallet(issuerFile);
    const backing = makeBacking({ obligor: key.publicKey,
      payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n }, reliance: [],
      evidence: { setting: 'transparent', operator: hex(config.operator, 32, 32),
        witnessing: { venue: hex(config.venue, 32, 32), interval: 1n } } });
    save(termsFile, { terms: bytesToHex(encodeBacking(backing)), signature: bytesToHex(signBacking(key.secret, backing)) });
    output({ backing: backing.nameHex, payout: 'Issuer promises EUR 1.00 per unit; external performance is not proved.' }); return;
  }
  if (action === 'register') {
    const config = read(args[0]), bundle = read(args[1]);
    const name = decodeBacking(hex(bundle.terms, 4096)).nameHex;
    output(await call(config, '/commands', { id: `register:${name}`, kind: 'register', backing: bundle.terms, signature: bundle.signature })); return;
  }
  if (action === 'sign') {
    const [clientFile, walletFile, termsFile, intentFile, requestFile] = args;
    const config = read(clientFile), key = wallet(walletFile), bundle = read(termsFile), intent = read(intentFile);
    const backing = decodeBacking(hex(bundle.terms, 4096));
    const nonceResponse = await call(config, `/nonce?backing=${backing.nameHex}&signer=${bytesToHex(key.publicKey)}`);
    const nonce = index(nonceResponse.nonce), signature = new Uint8Array(64);
    let op;
    switch (intent.kind) {
      case 'issue': op = { kind: 'issue', recipient: hex(intent.recipient, 32, 32), quantity: BigInt(intent.quantity), nonce, signature }; break;
      case 'transfer': op = { kind: 'transfer', from: key.publicKey, to: hex(intent.to, 32, 32), quantity: BigInt(intent.quantity), nonce, signature }; break;
      case 'burn': op = { kind: 'burn', holder: key.publicKey, quantity: BigInt(intent.quantity), nonce, signature }; break;
      case 'demand': op = { kind: 'demand', holder: key.publicKey, quantity: BigInt(intent.quantity), instant: index(intent.instant), deadline: index(intent.deadline), nonce, signature }; break;
      case 'acceptance': op = { kind: 'acceptance', demandHash: hex(intent.demandHash, 32, 32), instant: index(intent.instant), deadline: index(intent.deadline), nonce, signature }; break;
      case 'release': case 'withdrawal': op = { kind: intent.kind, holder: key.publicKey, demandHash: hex(intent.demandHash, 32, 32), nonce, signature }; break;
      default: throw new Error('unsupported intent');
    }
    op.signature = ed25519.sign(opMessageOfEntry(backing.name, op), key.secret);
    const bytes = encodePublishedOp(backing.name, op);
    const command = { id: bytesToHex(sha256(bytes)), kind: 'submit', operation: bytesToHex(bytes) };
    // The request is saved and synced before any submission. Retry this file;
    // never rebuild a lost response with a new nonce.
    save(requestFile, command); output({ saved: resolve(requestFile), id: command.id }); return;
  }
  if (action === 'send') {
    const reply = await call(read(args[0]), '/commands', read(args[1]));
    if (args[2] !== undefined) save(args[2], reply);
    output(reply); return;
  }
  if (action === 'witness') {
    if (args[1] === undefined) throw new Error('a stable witness command ID is required');
    output(await call(read(args[0]), '/commands', { id: args[1], kind: 'witness' })); return;
  }
  if (action === 'view') { output(await call(read(args[0]), '/view')); return; }
  if (action === 'verify') {
    const [clientFile, pinnedTermsFile, requestFile, replyFile, recipient, quantity] = args;
    const config = read(clientFile), bundle = read(pinnedTermsFile), request = read(requestFile), reply = read(replyFile);
    if (request.kind !== 'submit' || reply.kind !== 'accepted') throw new Error('expected saved request and receipt');
    const backing = decodeBacking(hex(bundle.terms, 4096));
    const view = await call(config, `/view?backing=${backing.nameHex}`);
    const result = verifyPilotPayment({ terms: hex(bundle.terms, 4096), termsSignature: hex(bundle.signature, 64, 64),
      operation: hex(request.operation, 8192), receipt: receiptFromWire(reply.receipt),
      ...(view.state === undefined ? {} : { state: stateFromWire(view.state) }),
      venue: localViewFromWire(view, hex(config.operator, 32, 32), hex(config.venue, 32, 32)),
      operator: hex(config.operator, 32, 32), recipient: hex(recipient, 32, 32), quantity: BigInt(quantity) });
    output(result); if (['invalid', 'unavailable'].includes(result.status)) process.exitCode = 1; return;
  }
  throw new Error('Usage: pilot.mjs init DIR [PORT] | serve DIR | wallet FILE | terms CLIENT ISSUER TERMS | register ADMIN TERMS | sign CLIENT WALLET TERMS INTENT REQUEST | send CLIENT REQUEST [REPLY] | witness ADMIN ID | view CLIENT | verify CLIENT PINNED_TERMS REQUEST REPLY RECIPIENT QUANTITY');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
