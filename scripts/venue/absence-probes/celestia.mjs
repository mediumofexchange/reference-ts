// Slice 20 probe (read-only): what a Celestia reader would fetch per block to prove one namespace's absence,
// the chain's block rate, validator set, unbonding, retention on public suppliers, and blob fees.
// GET to public services only. Usage: node celestia.mjs > celestia.json
const rpc = 'https://rpc.celestia.pops.one';
const api = 'https://api.celestia.pops.one';
const pruned = 'https://celestia-rpc.publicnode.com';
const json = async (u) => {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await new Promise((s) => setTimeout(s, 1500 * 2 ** i));
  }
  throw new Error(`failed ${u}`);
};
const tip = Number((await json(`${rpc}/status`)).result.sync_info.latest_block_height);
const header = async (h) => (await json(`${rpc}/header?height=${h}`)).result.header;
const span = 14000;
const a = await header(tip - span), b = await header(tip);
const secs = (Date.parse(b.time) - Date.parse(a.time)) / 1000;
const blocksPerDay = span / secs * 86400;
// A raw header's protobuf size, estimated as its field bytes plus a tag and length byte each.
const hx = (s) => (s ? s.length / 2 : 0);
const rawHeader = 4 + 4 + hx(b.last_block_id.hash) + 2 + 4 + hx(b.last_block_id.parts.hash) + 2 + b.chain_id.length + 2
  + 8 + 12 + [b.last_commit_hash, b.data_hash, b.validators_hash, b.next_validators_hash, b.consensus_hash, b.app_hash,
    b.last_results_hash, b.evidence_hash, b.proposer_address].reduce((s, x) => s + hx(x) + 2, 0);
// 60 blocks spread over the last day: original square width k, block transaction bytes, commit signatures.
const sample = [];
for (let i = 0; i < 60; i++) {
  const blk = (await json(`${rpc}/block?height=${tip - 10 - i * 233}`)).result.block;
  sample.push({ k: Number(blk.data.square_size), txBytes: blk.data.txs.reduce((s, t) => s + Buffer.from(t, 'base64').length, 0),
    sigs: blk.last_commit.signatures.filter((s) => s.signature).length });
}
const sorted = (k) => sample.map((s) => s[k]).sort((x, y) => x - y);
const ks = sorted('k');
// One namespace's absence in one block (estimate): the NMT path in one row of the extended square (2k leaves,
// 90-byte nodes: two 29-byte namespaces and a 32-byte hash) with the neighbouring leaf, the row root, and its
// path to the data root over 4k row and column roots (32-byte nodes); a namespace between two rows needs both.
const nsProof = (k) => { const row = Math.log2(2 * k) * 90 + 90 + 90 + Math.log2(4 * k) * 32; return [row, 2 * row]; };
// A stock light node syncs every extended header: raw header, commit, validator set and the DAH (4k roots).
const extended = (k, n) => rawHeader + n * 110 + n * 80 + 4 * k * 90;
// Blob fees: the PayForBlobs transactions of three recent blocks.
const fees = [];
for (const h of [tip - 100, tip - 200, tip - 300]) {
  const j = await json(`${api}/cosmos/tx/v1beta1/txs/block/${h}`);
  for (const t of j.txs ?? []) {
    const pfb = t.body.messages.find((m) => m.blob_sizes);
    if (!pfb) continue;
    const fee = t.auth_info.fee;
    fees.push({ blobBytes: pfb.blob_sizes.reduce((s, x) => s + Number(x), 0), gas: Number(fee.gas_limit),
      utia: Number(fee.amount.find((x) => x.denom === 'utia')?.amount ?? 0) });
  }
}
const lowest = async (u) => {
  const r = await (await fetch(`${u}/header?height=1`)).json();
  return r.result ? 1 : Number(/lowest height is (\d+)/.exec(r.error?.data ?? '')?.[1] ?? NaN);
};
const staking = await json(`${api}/cosmos/staking/v1beta1/params`);
const validators = Number((await json(`${rpc}/validators?height=${tip}&per_page=200`)).result.total);
const n = sorted('sigs')[30];
console.log(JSON.stringify({
  measured: new Date().toISOString(), tip, chain: b.chain_id, version: b.version,
  blockSeconds: +(secs / span).toFixed(3), blocksPerDay: Math.round(blocksPerDay), validators, commitSignaturesMedian: n,
  unbondingSeconds: Number(staking.params.unbonding_time.replace('s', '')),
  rawHeaderBytes: rawHeader, squareWidth: { min: ks[0], median: ks[30], p90: ks[54], max: ks.at(-1) },
  txBytesPerDay: Math.round(sample.reduce((s, x) => s + x.txBytes, 0) / sample.length * blocksPerDay),
  perBlockAbsenceBytes: { median: nsProof(ks[30]).map((x) => Math.round(x + rawHeader)),
    p90: nsProof(ks[54]).map((x) => Math.round(x + rawHeader)) },
  perDayAbsenceBytes: nsProof(ks[30]).map((x) => Math.round((x + rawHeader) * blocksPerDay)),
  stockLightNodeHeaderBytesPerDay: Math.round(extended(ks[30], n) * blocksPerDay),
  retention: { [rpc]: await lowest(rpc), [pruned]: await lowest(pruned) },
  blobFees: fees,
}, null, 1));
