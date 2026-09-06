// Multi-process crash/restart check for the Node 24 durable pool store.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.log('SKIP pool store crash check: the optional durable pool store requires Node.js 24 or newer.');
  process.exit(0);
}

const runFile = promisify(execFile);
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const worker = join(root, 'scripts', 'pool', 'store-crash-worker.mjs');
const scratchPath = join(root, 'scratch');
mkdirSync(scratchPath, { recursive: true });
if (realpathSync(scratchPath) !== scratchPath) throw new Error('scratch must be a local directory, not a redirected path');
const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'pool-store-crash-')));

async function workerRun(mode, file, phase, expectedCode = 0) {
  try {
    const result = await runFile(process.execPath, [worker, mode, file, phase], {
      cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (expectedCode !== 0) throw new Error(`worker unexpectedly exited normally: ${mode}/${phase}`);
    return result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout.trim().split('\n').at(-1));
  } catch (error) {
    const code = error.code;
    if (code !== expectedCode) throw new Error(`worker ${mode}/${phase} exited ${code}: ${(error.stderr ?? '').trim()}`);
    return undefined;
  }
}

function fileFor(mode, phase) {
  return join(directory, `${mode}-${phase}.sqlite`);
}

async function checkOpening() {
  for (const phase of ['applied', 'stored', 'committed']) {
    const file = fileFor('opening', phase);
    await workerRun('opening', file, phase, 71);
    const result = await workerRun('opening', file, 'none');
    assert.equal(result.before, phase === 'committed' ? '1' : '0');
    assert.equal(result.first, result.second, `opening retry at ${phase}`);
    assert.equal(result.published, result.first, `opening outbox publication at ${phase}`);
    assert.equal(result.highest, '1');
  }
  console.log('PASS pool opening crash phases: rollback before commit, exact persisted retry after commit.');
}

async function checkReceipts() {
  let expected;
  for (const phase of ['applied', 'stored', 'committed']) {
    const file = fileFor('receipt', phase);
    await workerRun('receipt', file, phase, 71);
    const result = await workerRun('receipt', file, 'none');
    assert.equal(result.before, phase === 'committed' ? 1 : 0);
    assert.equal(result.first, result.second, `receipt retry at ${phase}`);
    assert.equal(result.after, 1);
    if (expected === undefined) expected = result.first;
    else assert.equal(result.first, expected, `original receipt bytes at ${phase}`);
  }
  console.log('PASS pool receipt crash phases: rollback/persistence and identical durable receipt retries.');
}

async function checkCommits() {
  let expected;
  for (const phase of ['applied', 'stored', 'committed']) {
    const file = fileFor('commit', phase);
    await workerRun('commit', file, phase, 71);
    const result = await workerRun('commit', file, 'none');
    assert.equal(result.before, phase === 'committed' ? '2' : '1');
    assert.equal(result.first, result.second, `checkpoint retry at ${phase}`);
    if (expected === undefined) expected = result.first;
    else assert.equal(result.first, expected, `checkpoint bytes at ${phase}`);
    // The subsequent checkpoint is sequence 3, proving a committed crash did
    // not allow sequence 2 to be reused by the next durable command.
    const next = result.next;
    assert.equal(result.published, result.first, `checkpoint outbox publication at ${phase}`);
    assert.notEqual(next, result.first);
    assert.equal(result.nextSequence, '3');
  }
  console.log('PASS pool checkpoint crash phases: rollback/persistence and monotonic signed counters.');
}

try {
  await checkOpening();
  await checkReceipts();
  await checkCommits();
  console.log('Pool store crash check passed.');
} finally {
  const target = realpathSync(directory);
  if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pool-store-crash-'))) {
    throw new Error('refusing cleanup outside this crash-check directory');
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
