// The byte lengths each v3 signature and statement hash covers (records.ts), at canonical inputs.
import { statementBytes, acceptanceBytes, releaseBytes, withdrawalBytes } from '../../../dist/pool/v3/records.js';
const d = new Uint8Array(32).fill(7), limb = BigInt('0x' + '07'.repeat(16));
const pis = n => [limb, limb, ...Array.from({ length: n - 2 }, () => 1n)];
const len = (kind, n) => statementBytes({ domain: d, kind, publicInputs: pis(n) }).length;
console.log(JSON.stringify({ issue: len(1, 11), spend: len(2, 15), burn: len(3, 15), demand: len(4, 16), settle: len(6, 17), withdrawalStatement: len(5, 7),
  acceptance: acceptanceBytes({ domain: d, demand: d, owner: 5n, deadline: 9n }).length,
  release: releaseBytes(d, d, d, d).length,
  withdrawal: withdrawalBytes({ domain: d, kind: 5, publicInputs: pis(7) }).length }));
