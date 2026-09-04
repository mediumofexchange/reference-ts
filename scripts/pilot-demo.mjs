// End-to-end acceptance scenario over built package exports and separate processes.
// Temporary wallets stay under this checkout's ignored scratch directory.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const cli = join(root, 'scripts', 'pilot.mjs');
const worker = join(root, 'scripts', 'pilot-crash-worker.mjs');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });

async function run(script, args, expectedCode = 0) {
  let stdout, stderr, code = 0;
  try {
    ({ stdout, stderr } = await runFile(process.execPath, [script, ...args], {
      cwd: root, windowsHide: true, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    ({ stdout = '', stderr = '', code } = error);
  }
  if (code !== expectedCode) {
    // CLI diagnostics contain error text only, never wallet or credential files.
    throw new Error(`${script === cli ? args[0] : 'crash worker'} exited ${code}: ${stderr.trim()}`);
  }
  const lines = stdout.trim().split('\n').filter(Boolean);
  return lines.length === 0 ? undefined : JSON.parse(lines.at(-1));
}

async function freePort() {
  const listener = createServer();
  await new Promise((done, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', done);
  });
  const port = listener.address().port;
  await new Promise((done, reject) => listener.close(error => error ? reject(error) : done()));
  return port;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    console.log('SKIP pilot demo: the optional durable pilot requires Node.js 24 or newer.');
    return;
  }
  // Dynamic imports keep the Node 20 core check independent of this Node 24 profile.
  const { decodeBacking } = await import('@mediumofexchange/reference/backing');
  const { decodePublishedOp, opHashOfEntry } = await import('@mediumofexchange/reference/oplog');
  const { replayServedState } = await import('@mediumofexchange/reference/recovery');
  const { hex, localViewFromWire, stateFromWire } = await import('@mediumofexchange/reference/pilot-wire');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const scratch = join(root, 'scratch');
  mkdirSync(scratch, { recursive: true });
  if (realpathSync(scratch) !== scratch) throw new Error('scratch must be a local directory, not a redirected path');
  const directory = realpathSync(mkdtempSync(join(scratch, 'pilot-demo-')));
  let server;
  async function stop() {
    if (server === undefined) return;
    const child = server; server = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not terminate')), 10_000);
      child.once('close', () => { clearTimeout(timer); done(); });
      child.kill('SIGKILL');
    });
  }
  async function start() {
    assert.equal(server, undefined);
    server = spawn(process.execPath, [cli, 'serve', directory], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = server;
    await new Promise((done, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => reject(new Error('server readiness timed out')), 15_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('close', code => fail(new Error(`server exited ${code}: ${errors.trim()}`)));
      child.stderr.on('data', bytes => { errors += bytes.toString(); });
      child.stdout.on('data', bytes => {
        output += bytes.toString();
        if (output.split('\n').some(line => line.startsWith('{') && line.includes('"ready":true'))) {
          clearTimeout(timer); done();
        }
      });
    });
  }
  try {
    await run(cli, ['init', directory, String(await freePort())]);
    const admin = join(directory, 'admin-client.json'), client = join(directory, 'wallet-client.json');
    const issuer = join(directory, 'issuer.json'), alice = join(directory, 'alice.json'), bob = join(directory, 'bob.json');
    const [issuerPublic, alicePublic, bobPublic] = await Promise.all(
      [issuer, alice, bob].map(file => run(cli, ['wallet', file]).then(value => value.publicKey)),
    );
    const terms = join(directory, 'terms.json');
    await run(cli, ['terms', client, issuer, terms]);
    await start();
    await run(cli, ['register', admin, terms]);

    async function signed(name, key, intent) {
      const input = join(directory, `${name}.intent.json`), request = join(directory, `${name}.request.json`);
      save(input, intent);
      await run(cli, ['sign', client, key, terms, input, request]);
      return request;
    }
    const issue = await signed('issue', issuer, { kind: 'issue', recipient: alicePublic, quantity: '100' });
    assert.equal((await run(cli, ['send', client, issue])).kind, 'accepted');
    await run(cli, ['witness', admin, 'demo:issue']);
    const transfer = await signed('transfer', alice, { kind: 'transfer', to: bobPublic, quantity: '40' });
    const receipt = join(directory, 'transfer.reply.json');
    const accepted = await run(cli, ['send', client, transfer, receipt]);
    assert.equal(accepted.kind, 'accepted');
    const verify = () => run(cli, ['verify', client, terms, transfer, receipt, bobPublic, '40']);
    assert.equal((await verify()).status, 'pending');

    await stop(); // Abrupt operator termination, without SQLite/store shutdown hooks.
    await start();
    assert.deepEqual(await run(cli, ['send', client, transfer]), accepted);
    assert.equal((await verify()).status, 'pending');
    await run(cli, ['witness', admin, 'demo:payment']);
    assert.equal((await verify()).status, 'final');
    console.log('PASS: two wallet clients, signed payment, abrupt restart, identical retry, witnessed finality.');

    const config = read(client);
    const forbidden = await fetch(new URL('/commands', config.url), {
      method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'demo:wallet-witness', kind: 'witness' }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, 'ADMIN_REQUIRED');
    console.log('PASS: wallet credentials cannot advance the witness.');

    for (const phase of ['applied', 'stored', 'committed']) {
      const before = await run(cli, ['view', client]);
      const commandFile = join(directory, `crash-${phase}.json`);
      const command = { id: `demo:crash:${phase}`, kind: 'witness' };
      save(commandFile, command);
      await run(worker, [join(directory, 'journal.sqlite'), join(directory, 'operator.key.json'),
        join(directory, 'server.json'), commandFile, phase], 71);
      // The already-running server must reload durable changes from the other writer.
      const after = await run(cli, ['view', client]);
      assert.equal(BigInt(after.index), BigInt(before.index) + (phase === 'committed' ? 1n : 0n));
      assert.equal(after.commitments.length, before.commitments.length + (phase === 'committed' ? 1 : 0));
      const recovered = await run(cli, ['send', admin, commandFile]);
      assert.equal(recovered.index, (BigInt(before.index) + 1n).toString());
      assert.deepEqual(await run(cli, ['send', admin, commandFile]), recovered);
      assert.equal((await verify()).status, 'final');
    }
    console.log('PASS: process.exit(71) at applied, stored and committed; rollback/reload and stable witness retries.');

    const beforeRedemption = await run(cli, ['view', client]);
    const instant = beforeRedemption.index, deadline = (BigInt(instant) + 10n).toString();
    const demand = await signed('demand', bob, { kind: 'demand', quantity: '40', instant, deadline });
    assert.equal((await run(cli, ['send', client, demand])).kind, 'accepted');
    const backing = decodeBacking(hex(read(terms).terms, 4096));
    const decodedDemand = decodePublishedOp(hex(read(demand).operation, 8192));
    const demandHash = bytesToHex(opHashOfEntry(backing.name, decodedDemand.op));
    const acceptance = await signed('acceptance', issuer, { kind: 'acceptance', demandHash, instant, deadline });
    assert.equal((await run(cli, ['send', client, acceptance])).kind, 'accepted');
    const release = await signed('release', bob, { kind: 'release', demandHash });
    assert.equal((await run(cli, ['send', client, release])).kind, 'accepted');
    await run(cli, ['witness', admin, 'demo:redemption']);
    await stop(); await start();
    const finalView = await run(cli, ['view', client]);
    const venue = localViewFromWire(finalView, hex(config.operator, 32, 32), hex(config.venue, 32, 32));
    const state = replayServedState(backing, venue, stateFromWire(finalView.state));
    assert.ok(state, 'final history must independently replay under the law');
    assert.equal(state.balances.get(alicePublic) ?? 0n, 60n);
    assert.equal(state.balances.get(bobPublic) ?? 0n, 0n);
    assert.equal(state.balances.get(issuerPublic) ?? 0n, 40n);
    assert.equal(state.issued - state.burned, 100n);
    assert.equal(state.demands.size, 0);
    assert.equal((await verify()).status, 'final');
    console.log('PASS: demand, issuer acceptance and holder release; replayed balances Alice=60, Bob=0, issuer=40.');
    console.log('Pilot demo passed. External EUR payment is simulated; its performance is not proved.');
  } finally {
    await stop();
    const target = realpathSync(directory);
    if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pilot-demo-'))) {
      throw new Error('refusing cleanup outside this demo directory');
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => { console.error(`Pilot demo failed: ${error.message}`); process.exitCode = 1; });
