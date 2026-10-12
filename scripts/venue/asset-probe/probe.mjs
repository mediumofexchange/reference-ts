// Payment-asset probe (read-only, GET only): mining concentration, attack cost,
// liquidity, fees, holders and nodes from public sources, one snapshot.
// Usage: node probe.mjs <outDir>. Writes raw responses and result.json, which hashes each response.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "out";
mkdirSync(join(out, "raw"), { recursive: true });
const sources = {};

async function get(name, url, { json = true, tries = 3 } = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "moe-asset-probe" }, signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      writeFileSync(join(out, "raw", name), text);
      sources[name] = { url, fetched: new Date().toISOString(), sha256: createHash("sha256").update(text).digest("hex") };
      return json ? JSON.parse(text) : text;
    } catch (e) {
      if (i >= tries) { sources[name] = { url, error: String(e) }; return undefined; }
      await new Promise((s) => setTimeout(s, 3000 * i));
    }
  }
}

// Assets, with each source's identifier where it has one.
const ASSETS = [
  { sym: "BTC", cg: "bitcoin", mps: "bitcoin", c51: "BTC", bc: "bitcoin" },
  { sym: "XMR", cg: "monero", mps: "monero" },
  { sym: "LTC", cg: "litecoin", mps: "litecoin", c51: "LTC", bc: "litecoin" },
  { sym: "ZEC", cg: "zcash", mps: "zcash", c51: "ZEC", bc: "zcash" },
  { sym: "BCH", cg: "bitcoin-cash", mps: "bitcoincash", c51: "BCH", bc: "bitcoin-cash" },
  { sym: "DOGE", cg: "dogecoin", mps: "dogecoin", bc: "dogecoin" },
  { sym: "GRIN", cg: "grin", mps: "grin" },
  { sym: "FIRO", cg: "zcoin", mps: "firo" },
  { sym: "DASH", cg: "dash", mps: "dash", c51: "DASH", bc: "dash" },
  { sym: "ERG", cg: "ergo", mps: "ergo", c51: "ERG" },
  { sym: "KAS", cg: "kaspa", mps: "kaspa", c51: "KAS" },
  { sym: "DCR", cg: "decred", mps: "decred" },
  { sym: "XEC", cg: "ecash", mps: "ecash", c51: "XEC", bc: "ecash" },
  { sym: "ZANO", cg: "zano", mps: "zano" },
  { sym: "BEAM", cg: "beam", mps: "beam" },
  { sym: "DGB", cg: "digibyte", mps: "digibyte-sha" },
  { sym: "BSV", cg: "bitcoin-cash-sv", mps: "bitcoinsv" },
  { sym: "ETC", cg: "ethereum-classic", mps: "ethereumclassic", c51: "ETC" },
  { sym: "CKB", cg: "nervos-network", mps: "nervos", c51: "CKB" },
  { sym: "ALPH", cg: "alephium", mps: "alephium" },
];

const result = { generated: new Date().toISOString(), assets: {} };
for (const a of ASSETS) result.assets[a.sym] = {};

// 1. Liquidity and supply (CoinGecko).
const markets = await get("coingecko-markets.json",
  `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ASSETS.map((a) => a.cg).join(",")}&per_page=50`);
for (const a of ASSETS) {
  const m = markets?.find((x) => x.id === a.cg);
  if (m) Object.assign(result.assets[a.sym], { priceUsd: m.current_price, marketCapUsd: m.market_cap, volume24hUsd: m.total_volume,
    circulating: m.circulating_supply, maxSupply: m.max_supply, rank: m.market_cap_rank });
}

// 2. Rental attack cost (crypto51, 1-hour NiceHash model).
const c51 = await get("crypto51.html", "https://www.crypto51.app/", { json: false });
if (c51) for (const row of c51.split(/<tr[^>]*>/).slice(1)) {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  const a = ASSETS.find((x) => x.c51 && cells[2] === x.c51);
  if (a) Object.assign(result.assets[a.sym], { attackCostPerHourUsd: Number(cells[6].replace(/[$,]/g, "")), nicehashRentable: cells[7] });
}

// 3. Pool concentration (miningpoolstats: pool-reported hashrate and blocks among the last 1,000).
for (const a of ASSETS) {
  const page = await get(`mps-${a.mps}.html`, `https://miningpoolstats.stream/${a.mps}`, { json: false });
  const t = page?.match(/last_time = "(\d+)"/)?.[1];
  if (!t) continue;
  const d = await get(`mps-${a.mps}.json`, `https://data.miningpoolstats.stream/data/${a.mps}.js?t=${t}`);
  if (!d) continue;
  const net = Number(d.hashrate);
  // One operator can list several endpoints (PPLNS, solo): merge by pool id, else by the URL's host.
  const merged = new Map();
  for (const p of d.data.filter((x) => x.active !== false)) {
    const id = p.pool_id ?? new URL(p.url).host.replace(/^www\./, "");
    const m = merged.get(id) ?? { id, h: 0, b: 0 };
    m.h += Number(p.hashrate) || 0; m.b += Number(p.blocks_1000) || 0;
    merged.set(id, m);
  }
  const pools = [...merged.values()];
  const byH = [...pools].sort((x, y) => y.h - x.h);
  const byB = [...pools].sort((x, y) => y.b - x.b);
  const totalB = pools.reduce((s, p) => s + p.b, 0);
  // Fewest pools whose blocks among the last 1,000 exceed 500 (pools report their own blocks).
  let acc = 0, nak = 0;
  for (const p of byB) { if (acc > 500) break; acc += p.b; nak++; }
  Object.assign(result.assets[a.sym], { mps: {
    snapshot: new Date(Number(t) * 1000).toISOString(), algo: d.algo, networkHashrate: net, unit: d.unit,
    poolsReportedHashrateOverNetwork: pools.reduce((s, p) => s + p.h, 0) / net,
    topByReportedHashrate: byH.slice(0, 3).map((p) => ({ pool: p.id, shareOfNetwork: p.h / net })),
    blocks1000Attributed: totalB,
    topByBlocks1000: byB.slice(0, 3).map((p) => ({ pool: p.id, blocks: p.b })),
    poolsForMajorityOfLast1000: acc > 500 ? nak : null,
    blockTimeTarget: d.block_time_target, blockTimeAverage: d.block_time_average, supply: d.supply } });
}

// 4. On-chain pool attribution where an explorer publishes it (one week).
for (const [sym, url] of [["BTC", "https://mempool.space/api/v1/mining/pools/1w"], ["LTC", "https://litecoinspace.org/api/v1/mining/pools/1w"]]) {
  const p = await get(`pools-${sym}.json`, url);
  if (!p) continue;
  const total = p.pools.reduce((s, x) => s + x.blockCount, 0);
  const sorted = [...p.pools].sort((x, y) => y.blockCount - x.blockCount);
  let acc = 0, nak = 0;
  for (const x of sorted) { if (acc > total / 2) break; acc += x.blockCount; nak++; }
  result.assets[sym].onchainPools1w = { blocks: total, top: sorted.slice(0, 4).map((x) => ({ pool: x.name, share: x.blockCount / total })), nakamoto: nak };
}
// Ergo: miner key of the last 720 blocks (about one day).
{
  const items = [];
  for (let off = 0; off < 720; off += 100) {
    const r = await get(`ergo-blocks-${off}.json`, `https://api.ergoplatform.com/api/v1/blocks?offset=${off}&limit=100&sortBy=height&sortDirection=desc`);
    if (r) items.push(...r.items);
  }
  const counts = {};
  for (const b of items.slice(0, 720)) counts[b.miner.address] = (counts[b.miner.address] ?? 0) + 1;
  const sorted = Object.entries(counts).sort((x, y) => y[1] - x[1]);
  const n = Math.min(items.length, 720);
  let acc = 0, nak = 0;
  for (const [, c] of sorted) { if (acc > n / 2) break; acc += c; nak++; }
  result.assets.ERG.onchainMiners = { blocks: n, heights: [items.at(Math.min(items.length, 720) - 1)?.height, items[0]?.height],
    top: sorted.slice(0, 3).map(([k, c]) => ({ miner: k.slice(-8), share: c / n })), nakamoto: nak };
}

// 5. Fees: BTC and LTC fee-rate history (median per block bucket) and recommendations.
for (const [sym, base] of [["BTC", "https://mempool.space"], ["LTC", "https://litecoinspace.org"]]) {
  const rec = await get(`fees-${sym}.json`, `${base}/api/v1/fees/recommended`);
  const hist = await get(`feerates-${sym}-3y.json`, `${base}/api/v1/mining/blocks/fee-rates/3y`, { tries: 5 });
  if (!hist) continue;
  const since = (y) => hist.filter((h) => h.timestamp >= Date.parse(y) / 1000);
  const maxMedian = (rows) => rows.reduce((m, h) => (h.avgFee_50 > m.avgFee_50 ? h : m), rows[0]);
  const med = (rows) => { const v = rows.map((h) => h.avgFee_50).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  const m24 = maxMedian(since("2024-01-01")), m25 = maxMedian(since("2025-01-01")), m26 = maxMedian(since("2026-01-01"));
  result.assets[sym].feeRates = { recommended: rec, medianOfBucketMedians2026: med(since("2026-01-01")),
    busiestBucketMedianSince2024: { satPerVB: m24.avgFee_50, at: new Date(m24.timestamp * 1000).toISOString() },
    busiestBucketMedianSince2025: { satPerVB: m25.avgFee_50, at: new Date(m25.timestamp * 1000).toISOString() },
    busiestBucketMedianSince2026: { satPerVB: m26.avgFee_50, at: new Date(m26.timestamp * 1000).toISOString() } };
}
// Monero's fee per byte from a public explorer's daemon.
{
  const r = await get("xmr-networkinfo.json", "https://xmrchain.net/api/networkinfo");
  if (r) result.assets.XMR.feePerByteAtomic = r.data.fee_per_kb;
}

// 6. Holders and nodes: Blockchair's all-chain snapshot (one request) and Bitnodes.
const bc = await get("blockchair-stats.json", "https://api.blockchair.com/stats");
for (const a of ASSETS) {
  const d = a.bc && bc?.data?.[a.bc]?.data;
  if (d) Object.assign(result.assets[a.sym], { blockchair: { addressesWithBalance: d.hodling_addresses, nodes: d.nodes,
    transactions24h: d.transactions_24h, blocks24h: d.blocks_24h, medianFeeNative24h: d.median_transaction_fee_24h,
    averageFeeNative24h: d.average_transaction_fee_24h, mempoolTransactions: d.mempool_transactions } });
}
const bn = await get("bitnodes.json", "https://bitnodes.io/api/v1/snapshots/latest/?field=total");
if (bn) result.assets.BTC.bitnodesReachable = bn.total_nodes ?? bn.metadata?.reachable_nodes;

result.sources = sources;
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(sources).filter(([, s]) => s.error))));
