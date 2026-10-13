// The hinted Blake2b-256 (blake2b.nr) against @noble/hashes: gates and digests over L bytes (all 0xff, then random).
// node b2test.mjs <L>
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Noir } from '@noir-lang/noir_js';
import { blake2b } from '@noble/hashes/blake2b.js';
import { compile, BUILD } from './compile.mjs';
const L = Number(process.argv[2] ?? 1280);
const dir = path.join(BUILD, `b2_${L}`);
mkdirSync(path.join(dir, 'src'), { recursive: true });
writeFileSync(path.join(dir, 'Nargo.toml'), `[package]\nname = "b2_${L}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
copyFileSync(path.join(import.meta.dirname, 'blake2b.nr'), path.join(dir, 'src/blake2b.nr'));
writeFileSync(path.join(dir, 'src/main.nr'), `mod blake2b;\nfn main(msg: [u8; ${L}]) -> pub [u64; 4] { blake2b::blake2b256(msg) }\n`);
const { program, circuit_size } = await compile(dir);
let ok = 0;
for (let k = 0; k < 4; k++) {
  const msg = k === 0 ? new Uint8Array(L).fill(255) : randomBytes(L);
  const { returnValue } = await new Noir(program).execute({ msg: [...msg].map(String) });
  const got = Buffer.concat(returnValue.map(BigInt).map(w => { const b = Buffer.alloc(8); b.writeBigUInt64LE(w); return b; }));
  if (got.equals(Buffer.from(blake2b(msg, { dkLen: 32 })))) ok++;
}
console.log(JSON.stringify({ L, compressions: Math.ceil(L / 128), gates: circuit_size, digestsMatched: `${ok}/4` }));
