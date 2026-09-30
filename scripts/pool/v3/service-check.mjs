// Distinct service and receiver processes; synthetic proof oracle and a known
// local venue ledger. No real-proof, live-venue or physical-storage claim.
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const scratchPath = join(root, 'scratch'); mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath); assert.equal(scratch, scratchPath, 'scratch must not be redirected');
const directory = realpathSync(mkdtempSync(join(scratch, 'v3-service-'))), children = [], runFile = promisify(execFile);
async function start(fault = 'none') {
  const child = fork(join(root, 'scripts/pool/v3/service-server.mjs'), [directory, fault],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const record = { child, stderr: '', dropped: undefined }; children.push(record);
  child.stderr.on('data', data => { record.stderr += data; }); child.stdout.resume();
  child.on('message', message => { if (message?.kind === 'dropped') record.dropped = message.body; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`server startup timeout: ${record.stderr}`)); }, 20_000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed); };
    const message = value => { if (value?.kind === 'ready') { cleanup(); resolve(value); } };
    const exited = code => { cleanup(); reject(new Error(`server exited ${code}: ${record.stderr}`)); };
    const failed = error => { cleanup(); reject(error); };
    child.on('message', message); child.once('exit', exited); child.once('error', failed);
  });
  assert.equal(ready.pid, child.pid); return Object.assign(record, ready);
}
async function client(mode, server) {
  const { stdout } = await runFile(process.execPath, [join(root, 'scripts/pool/v3/service-client.mjs'), mode, directory, server?.baseUrl ?? ''],
    { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim()); assert.notEqual(result.pid, process.pid);
  if (server) assert.notEqual(result.pid, server.pid); return result;
}
async function stop(record) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  const exited = once(record.child, 'exit');
  if (record.child.connected) record.child.send({ kind: 'stop' });
  const timer = setTimeout(() => record.child.kill(), 5000);
  const [code, signal] = await exited; clearTimeout(timer);
  assert.equal(code, 0, `server shutdown ${signal}: ${record.stderr}`);
}
try {
  await client('prepare');
  const original = await start('drop-commit'), first = await client('initial', original);
  assert.ok(original.dropped, 'fault must discard a completed commit response');
  const dropped = JSON.parse(original.dropped); assert.equal(dropped.kind, 'committed');
  assert.equal(dropped.commitment, first.commit, 'retry returns the exact dropped signed bytes');
  const replacement = await start(); assert.equal(replacement.restoredPublications, 2);
  await client('fenced', original);
  const resumed = await client('resumed', replacement);
  for (const key of ['receipt', 'commit', 'tail']) assert.equal(resumed[key], first[key]);
  await stop(original); await stop(replacement);
  const restarted = await start(); assert.equal(restarted.restoredPublications, 3);
  const final = await client('restarted', restarted);
  for (const key of ['receipt', 'commit', 'tail']) assert.equal(final[key], first[key]);
  await stop(restarted);
  console.log('PASS v3 service processes: changed-proof retry, lost completed commit response, exact restart, old-process fencing, unpublished tail exclusion, independent receiver fulfillment of an HTTP package and reads over an evidence file synced across receiver processes.');
  console.log('Withheld and tampered package evidence refused. Scope: synthetic proof oracle and separately restored fixture venue; no live service or custody claim.');
} finally {
  const results = await Promise.allSettled(children.map(stop));
  const target = realpathSync(directory);
  assert.ok(dirname(target) === scratch && target.startsWith(scratch + sep) && target.startsWith(join(scratch, 'v3-service-')),
    'refusing cleanup outside this acceptance directory');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
}
