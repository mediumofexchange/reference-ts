// Fresh caller-held test keys. Real proofs only; local venue and independent
// digest authentication remain modeled. Each holder/listener/operator is a process.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeBacking, signBacking } from '@mediumofexchange/reference/backing';
import { encodeCommitment } from '@mediumofexchange/reference/commitment';
import { configurationHash, ISSUE, statementBytes } from '@mediumofexchange/reference/pool/statement';
import { commitmentOf } from '@mediumofexchange/reference/pool/notes';
import { deriveWalletField } from '@mediumofexchange/reference/pool/wallet';
import { limbsOf } from '@mediumofexchange/reference/pool/field';
import { ScopeTree } from '@mediumofexchange/reference/pool/scope';
import { PoolServiceClient } from '@mediumofexchange/reference/pool/service-client';
import { WalletDeliveryClient } from '@mediumofexchange/reference/pool/wallet-delivery-http';
import { decodeWalletPairing, walletPairingDigest } from '@mediumofexchange/reference/pool/wallet-pairing';
import { encodeLocalProfile, readLocalProfile } from './profile.mjs';
import { pinnedConfiguration } from '../wallet/pins.mjs';
import { checkWalletOperation } from '../wallet/operation-check.mjs';

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const scratchPath = join(root, 'scratch'); mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath); assert.equal(scratch, scratchPath);
const directory = realpathSync(mkdtempSync(join(scratch, 'pool-local-')));
const publicDirectory = join(directory, 'public'); mkdirSync(publicDirectory);
const profileFile = join(publicDirectory, 'profile.json'), evidenceFile = join(publicDirectory, 'evidence.bin'), ledgerFile = join(publicDirectory, 'ledger.json');
const database = join(directory, 'operator.db');
const compiled = process.argv[2] ? resolve(process.argv[2]) : join(directory, 'circuits');
const operatorSecret = randomBytes(32), issuerSecret = randomBytes(32), walletToken = randomBytes(32).toString('hex'), adminToken = randomBytes(32).toString('hex');
const domain = configurationHash(pinnedConfiguration()), venue = randomBytes(32), operator = ed25519.getPublicKey(operatorSecret);
const backing = makeBacking({ obligor: ed25519.getPublicKey(issuerSecret), payout: { thing: 'LOCAL-TEST', quantumExponent: 0, perUnit: 1n }, reliance: [],
  evidence: { setting: 'pool', construction: 'moe/pool/v2', configuration: domain, operator, witnessing: { venue, interval: 1n } } });
const terms = { backing, signature: signBacking(issuerSecret, backing) };
const header = { domain, venue, operator, sequence: 1n, entries: [{ backing: backing.name, link: backing.name }] };
const profileText = encodeLocalProfile(terms, header), digest = createHash('sha256').update(profileText).digest('hex');
writeFileSync(profileFile, profileText); writeFileSync(ledgerFile, '[]');
const profile = readLocalProfile(profileFile, digest), run = promisify(execFile);
const children = new Set();
let proofs, operatorChild, receiverChild, receiverPort = 0, baseUrl, client, acceptanceFailure;
function framed(stdout, prefix) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix)); assert.equal(lines.length, 1);
  return JSON.parse(lines[0].slice(prefix.length));
}
async function start(script, args, input) {
  const child = spawn(process.execPath, [join(root, 'scripts/pool/local', script), ...args],
    { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  children.add(child); let output = '', errors = '';
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => { children.delete(child); resolveClose({ code, signal }); }));
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 1024 * 1024) child.kill(); });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('local worker startup timed out')); }, 180_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error(errors || 'local worker exited before readiness')); });
    child.stdout.on('data', () => {
      if (!output.includes('\n')) return;
      try { const result = framed(output, 'MOE_LOCAL_READY='); clearTimeout(timer); resolveReady(result); } catch { /* incomplete line */ }
    });
  });
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  return { child, ready: await ready };
}
async function stop(child) {
  if (!child) return;
  if (children.has(child)) child.send('stop', () => {});
  let timer;
  const result = await Promise.race([child.closed, new Promise(resolveTimeout => { timer = setTimeout(() => { child.kill(); resolveTimeout(undefined); }, 30_000); })]);
  clearTimeout(timer);
  if (!result) { await child.closed; throw new Error('local worker required forced termination'); }
  assert.equal(result.code, 0, 'local worker shutdown failed');
}
async function startOperator() {
  const started = await start('operator.mjs', [database, profileFile, digest, ledgerFile, evidenceFile, compiled],
    { operatorSecret: operatorSecret.toString('hex'), walletToken, adminToken });
  operatorChild = started.child; baseUrl = started.ready.baseUrl; client = new PoolServiceClient(baseUrl, walletToken, adminToken);
}
async function listen(databasePath, id, port = 0) {
  return start('receiver.mjs', [databasePath, profileFile, digest, id, String(port)]);
}
function args(mode, wallet, evidence = evidenceFile, artifacts = compiled) {
  return [join(root, 'scripts/pool/local/holder.mjs'), mode, wallet, profileFile, digest, baseUrl, evidence, ledgerFile, artifacts];
}
async function holder(mode, wallet, body, evidence, artifacts) {
  const child = spawn(process.execPath, args(mode, wallet, evidence, artifacts), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  return new Promise((resolveResult, reject) => {
    let output = '', error = ''; const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout.on('data', c => { output += c; if (output.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', c => { error += c; if (error.length > 1024 * 1024) child.kill(); });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.once('close', code => { clearTimeout(timer); children.delete(child); if (code !== 0) reject(new Error(error || 'holder failed')); else {
      try { resolveResult(framed(output, 'MOE_WALLET_RESULT=')); } catch (e) { reject(e); }
    } });
    child.stdin.end(JSON.stringify({ walletToken, command: body }));
  });
}
async function checkpoint(id) { await client.commit(id); await client.publish(); }
try {
  const refusedOperator = join(directory, 'wrong-key.db');
  await assert.rejects(start('operator.mjs', [refusedOperator, profileFile, digest, ledgerFile, evidenceFile, compiled],
    { operatorSecret: randomBytes(32).toString('hex'), walletToken, adminToken }), /operator key differs from profile/);
  assert.equal(existsSync(refusedOperator), false);
  await assert.rejects(start('operator.mjs', [refusedOperator, profileFile, digest, ledgerFile, profileFile, compiled],
    { operatorSecret: operatorSecret.toString('hex'), walletToken, adminToken }), /path|collid/i);
  assert.equal(existsSync(refusedOperator), false); assert.equal(readFileSync(profileFile, 'utf8'), profileText);
  if (!process.argv[2]) await run(process.execPath, [join(root, 'scripts/pool/compile.mjs'), compiled],
    { cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000 });
  proofs = await (await import('../wallet/proofs.mjs')).openWalletProofs(compiled);
  await startOperator();
  const untouched = join(directory, 'refused.db');
  await assert.rejects(holder('issue', untouched, { id: 'no', value: '1' }), /unknown holder command/);
  assert.equal(existsSync(untouched), false);
  const original = readFileSync(profileFile); writeFileSync(profileFile, Buffer.concat([original, Buffer.from(' ')]));
  try { await assert.rejects(holder('request', untouched, { id: 'no', value: '1' }), /profile digest mismatch/); }
  finally { writeFileSync(profileFile, original); }
  assert.equal(existsSync(untouched), false);
  const operation = await checkWalletOperation({ root, directory, baseUrl, evidenceFile, ledgerFile, compiled, profile, checkpoint,
    commandArgs: (mode, wallet, evidence) => args(mode, wallet, evidence), commandBody: command => ({ walletToken, command }),
    retryPrepared: async (wallet, alias, expected) => {
      const saved = await holder('prepare', wallet, { alias }, join(directory, 'absent'), ''); assert.equal(saved.statement, expected);
      await stop(operatorChild); operatorChild = undefined; await startOperator();
    },
    startReceiver: async (wallet, id) => { const started = await listen(wallet, id, receiverPort); receiverChild = started.child; receiverPort = started.ready.port; return started.ready; },
    stopReceiver: async () => { await stop(receiverChild); receiverChild = undefined; },
    fund: async (wallet, command) => {
      for (const value of [4n, 6n]) {
        const id = 'fund' + value, request = JSON.parse((await command('request', wallet, { id, value: String(value) })).request);
        const opening = { backing: backing.name, value, owner: BigInt(request.owner), rho: deriveWalletField(issuerSecret, domain, 'issue-rho', [BigInt(request.owner)]) };
        const scope = new ScopeTree(header.entries), path = scope.pathFor(backing.name), a = profile.AUTHORITY;
        const publicInputs = [...limbsOf(domain), ...limbsOf(a.segment), a.scopeRoot, ...limbsOf(backing.name), value, commitmentOf(domain, opening)];
        const witness = { domain: limbsOf(domain).map(String), segment: limbsOf(a.segment).map(String), scope: String(a.scopeRoot),
          link: limbsOf(backing.name).map(String), scope_siblings: path.siblings.map(String), scope_right: [...path.right],
          backing: limbsOf(backing.name).map(String), quantity: String(value), cm: String(commitmentOf(domain, opening)), owner: String(opening.owner), rho: String(opening.rho) };
        const statement = { kind: ISSUE, publicInputs, proof: await proofs.prove(ISSUE, witness, publicInputs), obligorSignature: ed25519.sign(statementBytes(domain, ISSUE, publicInputs), issuerSecret) };
        const receipt = await client.submit({ domain, statement });
        const listener = await listen(wallet, id);
        try {
          const pair = decodeWalletPairing(listener.ready.invitation);
          assert.equal(walletPairingDigest(listener.ready.invitation), listener.ready.digest);
          await new WalletDeliveryClient(pair.endpoint, pair.token, pair.cert, { pair, current: () => true }).deliver(domain, { statement, opening, receipt });
        } finally { await stop(listener.child); }
      }
      await checkpoint('configured-funding');
      for (const id of ['fund4', 'fund6']) assert.equal((await command('receive', wallet, { id })).kind, 'final');
      console.log('PASS configured funding delivered and independently verified');
    } });
  const view = deserialize(readFileSync(evidenceFile)), expected = bytesToHex(encodeCommitment(view.latest));
  const { stdout } = await run(process.execPath, [join(root, 'scripts/pool/wallet/audit.mjs'), publicDirectory, compiled, expected, profileFile, digest],
    { cwd: publicDirectory, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
  const audit = framed(stdout, 'MOE_WALLET_RESULT='); assert.equal(audit.kind, 'final');
  assert.deepEqual(audit.supply[backing.nameHex], { issued: '10', burned: '0', outstanding: '10' });
  console.log('PASS configured real v2 holder/operator, restart, private receipt/change, second payment and public audit: ' + JSON.stringify(operation));
} catch (error) { acceptanceFailure = error; }
finally {
  const errors = acceptanceFailure ? [acceptanceFailure] : [];
  for (const child of [...children]) { try { await stop(child); } catch (e) { errors.push(e); } }
  try { await proofs?.close(); } catch (e) { errors.push(e); }
  operatorSecret.fill(0); issuerSecret.fill(0);
  if (children.size === 0) {
    const target = realpathSync(directory); assert.equal(dirname(target), scratch); assert.ok(target.startsWith(join(scratch, 'pool-local-')) && target.startsWith(scratch + sep));
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else errors.push(new Error('worker ownership unresolved; preserve scratch'));
  if (errors.length) throw new AggregateError(errors, 'configured flow cleanup failed');
}
