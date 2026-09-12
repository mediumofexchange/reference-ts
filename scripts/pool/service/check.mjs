// Node 24 persistent-store acceptance with distinct server and client processes.
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log('SKIP pool service acceptance: optional SQLite server requires Node.js 24 or newer.');
  process.exit(0);
}
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const scratchPath = join(root, 'scratch');
mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath);
assert.equal(scratch, scratchPath, 'scratch must not be redirected');
const directory = realpathSync(mkdtempSync(join(scratch, 'pool-service-')));
const children = [];
const runFile = promisify(execFile);
async function start(fault = 'none') {
  const child = fork(join(root, 'scripts/pool/service/server.mjs'), [join(directory, 'state.sqlite'), join(directory, 'venue.json'), fault],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const record = { child, stderr: '', stdout: '', dropped: undefined };
  children.push(record);
  child.stderr.on('data', data => { record.stderr += data; });
  child.stdout.on('data', data => { record.stdout += data; });
  child.on('message', message => { if (message?.kind === 'dropped') record.dropped = message.body; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timeout: ${record.stderr}`)), 20_000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed); };
    const message = value => { if (value?.kind === 'ready') { cleanup(); resolve(value); } };
    const exited = code => { cleanup(); reject(new Error(`server exited ${code}: ${record.stderr}`)); };
    const failed = error => { cleanup(); reject(error); };
    child.on('message', message); child.once('exit', exited); child.once('error', failed);
  });
  assert.equal(ready.pid, child.pid);
  return Object.assign(record, ready);
}
async function client(mode, server) {
  const { stdout } = await runFile(process.execPath, [join(root, 'scripts/pool/service/client.mjs'), mode, server.baseUrl],
    { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.notEqual(result.pid, server.pid);
  assert.notEqual(result.pid, process.pid);
  return result;
}
async function stop(record) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  const exited = once(record.child, 'exit');
  record.child.send({ kind: 'stop' });
  const timer = setTimeout(() => record.child.kill(), 5000);
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, `server shutdown ${signal}: ${record.stderr}`);
}
try {
  const original = await start('drop-commit');
  const first = await client('initial', original);
  assert.ok(original.dropped, 'fault must actually discard a completed commit response');
  const dropped = JSON.parse(original.dropped);
  assert.equal(dropped.kind, 'committed');
  assert.equal(dropped.commitment, first.commit, 'retry must return the exact dropped signed bytes');
  const replacement = await start();
  assert.equal(replacement.restoredPublications, 2);
  await client('fenced', original);
  const resumed = await client('resumed', replacement);
  assert.equal(resumed.receipt, first.receipt);
  assert.equal(resumed.commit, first.commit);
  await stop(original);
  await stop(replacement);
  const restarted = await start();
  assert.equal(restarted.restoredPublications, 3);
  const final = await client('restarted', restarted);
  assert.equal(final.receipt, first.receipt);
  assert.equal(final.commit, first.commit);
  assert.equal(final.next, resumed.next);
  await stop(restarted);
  console.log('PASS separate-process pool service: caller-bound receipts, changed-proof retry, seven rejected requests, lost commit response, persisted exact replies, old-process fencing, monotonic sequence 3 and restored local venue publication.');
  console.log('Scope: public fixture keys, ideal proof verifier and known local venue ledger; no real proof, live venue, private delivery or deployment claim.');
} finally {
  const results = await Promise.allSettled(children.map(stop));
  const target = realpathSync(directory);
  if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pool-service-'))) throw new Error('unsafe acceptance cleanup path');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
