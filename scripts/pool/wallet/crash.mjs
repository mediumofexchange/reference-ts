// Actual abrupt process exits around each wallet transaction's COMMIT.
// Ideal proofs/public fixture keys: this checks local durability, not custody
// against rollback, power loss, external goods or a real proof system.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log('SKIP pool wallet crash check: the optional durable wallet requires Node.js 24 or newer.');
  process.exit(0);
}

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const worker = join(root, 'scripts', 'pool', 'wallet', 'crash-worker.mjs'), runFile = promisify(execFile);
const scratchPath = join(root, 'scratch');
mkdirSync(scratchPath, { recursive: true });
if (realpathSync(scratchPath) !== scratchPath) throw new Error('scratch must be a local directory, not a redirected path');
const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'pool-wallet-crash-')));

async function run(operation, phase, file, action, expectedCode) {
  let result;
  try {
    result = await runFile(process.execPath, [worker, operation, phase, file, action], {
      cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    assert.equal(error.code, expectedCode, `wallet ${operation}/${phase}/${action}: ${error.stderr ?? error.message}`);
    assert.equal(error.killed, false, 'worker must reach its deliberate exit, not a timeout');
    return;
  }
  assert.equal(expectedCode, 0, `wallet ${operation}/${phase} did not reach its crash boundary`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { restored: operation, phase });
}

try {
  for (const operation of ['request', 'pending', 'receipt', 'fulfillment', 'capability', 'inbox', 'export', 'import']) {
    for (const phase of ['before', 'after']) {
      const file = join(directory, `${operation}-${phase}.sqlite`);
      await run(operation, phase, file, 'crash', 71);
      await run(operation, phase, file, 'restore', 0);
    }
    console.log(`PASS wallet ${operation}: abrupt exit before/after COMMIT, restored state and replay checks.`);
  }
  console.log('Pool wallet crash check passed: sixteen abrupt exits and sixteen fresh-process recoveries.');
} finally {
  const target = realpathSync(directory);
  if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pool-wallet-crash-'))) {
    throw new Error('refusing cleanup outside this wallet crash-check directory');
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
