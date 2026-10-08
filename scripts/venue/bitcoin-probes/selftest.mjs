// Self-test of block.mjs on one real block and hostile variants of it: each variant must be refused
// by its named check. Usage: node selftest.mjs <raw block file> <height>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BlockError, verifyBlock, bitsToTarget, targetToBits, merkleRoot } from './block.mjs';

const [file, heightArg] = process.argv.slice(2);
const raw = readFileSync(file);
const height = Number(heightArg);
const ok = verifyBlock(raw, height);
console.log(JSON.stringify({ hash: ok.header.hash, txCount: ok.txCount, size: ok.size, stripped: ok.stripped, weight: ok.weight, opReturnOutputs: ok.opReturnOutputs, opReturnOver83: ok.opReturnOver83, envelopeInputs: ok.envelopeInputs }));

let failures = 0;
function refuses(name, buf, check, h = height) {
  try {
    verifyBlock(buf, h);
    console.log(`FAIL ${name}: accepted`);
    failures++;
  } catch (e) {
    if (!(e instanceof BlockError) || e.check !== check) {
      console.log(`FAIL ${name}: ${e.message} (wanted ${check})`);
      failures++;
    } else console.log(`ok   ${name}: ${e.message}`);
  }
}

const flip = (at) => { const b = Buffer.from(raw); b[at] ^= 1; return b; };
refuses('nonce flipped', flip(76), 'POW');
refuses('wrong height', raw, 'BIP34', height + 1);
refuses('trailing byte', Buffer.concat([raw, Buffer.from([0])]), 'TX');
refuses('truncated', raw.subarray(0, raw.length - 1), 'TX');

for (const bits of [0x1702c4e4, 0x1d00ffff]) if (targetToBits(bitsToTarget(bits)) !== bits) { console.log(`FAIL bits round-trip ${bits}`); failures++; }

// A last transaction's locktime byte flipped changes its txid, so the Merkle root differs while
// the header (and its proof of work) is untouched.
const lastLock = raw.length - 1;
refuses('last locktime flipped', flip(lastLock), 'MERKLE');

// Witness commitment: flip one byte inside a witness. Find a segwit transaction's last witness byte
// by re-parsing is costly; flipping the coinbase reserved value suffices (it is hashed into the commitment).
const cbStart = 80 + 3; // varint of a block with 253..65535 transactions is 3 bytes
const i = raw.indexOf(Buffer.from('01200000000000000000000000000000000000000000000000000000000000000000', 'hex'), cbStart);
if (i > 0) refuses('coinbase reserved value flipped', flip(i + 2), 'WITNESS_COMMITMENT');
else console.log('skip reserved value: coinbase reserved value is not all zero');

// CVE-2012-2459: [a, b, c] and [a, b, c, c] share a root under odd-level duplication; the
// duplicated list must be refused.
const leaf = (n) => createHash('sha256').update(String(n)).digest();
const three = [leaf(1), leaf(2), leaf(3)];
merkleRoot(three, 'MERKLE');
try { merkleRoot([...three, leaf(3)], 'MERKLE'); console.log('FAIL duplicated pair accepted'); failures++; }
catch (e) { if (e instanceof BlockError && /mutated/.test(e.message)) console.log('ok   duplicated pair: ' + e.message); else { console.log('FAIL ' + e.message); failures++; } }

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all refusals named');
