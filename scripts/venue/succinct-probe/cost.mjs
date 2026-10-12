// Slice 21's cost model: what a prover of §13.2 exhaustion's hashing over a day of Ergo mainnet pays under the
// declared proof system (UltraHonk over BN254, Barretenberg 5.2.0, Noir 1.0.0-beta.26), from the measurements below.
// Proving time follows the gates a circuit fills, not its padded rows, so time is gates × seconds a gate.
// Usage: node cost.mjs > results.json   (the measured inputs are the other scripts' outputs, copied here)
const cpu = 'Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15 GB (cloud container)';
const measured = {
  // probe.mjs: circuit size (gates) of Blake2b-256 over L bytes, and of the Blake2s black box over L bytes.
  blake2b: { 100: 35469, 1280: 333105, 2560: 662515, 5120: 1321335, 10240: 2638975 },
  blake2s: { 100: 17408, 640: 32328, 1280: 64418, 2560: 128598 },
  // leaf.mjs 103: Blake2b over 103 compressions and one recursive verification, one circuit of 2^22 rows.
  leaf: { compressions: 103, gates: 4097581, rows: 2 ** 22 },
  // time-prove.sh (timings.txt): prove alone with a precomputed vk, 4 threads, on an otherwise idle host.
  prove: [
    { circuit: 'leaf_103', gates: 4097581, seconds: [68.90, 68.89], peakMiB: 5830 },
    { circuit: 'b2b_10240', gates: 2638975, seconds: [46.61, 42.98], peakMiB: 3819 },
    { circuit: 'b2b_5120', gates: 1321335, seconds: [24.27, 20.78], peakMiB: 1932 },
    { circuit: 'b2b_2560', gates: 662515, seconds: [13.18, 11.13], peakMiB: 996 },
  ],
  proofBytes: 14656,
  nativeVerifyMs: 16,
  // recurse.mjs: one and two noir-recursive UltraHonk verifications in one circuit; a tampered proof fails.
  recursion: { one: 704636, two: 1471658, twoSeconds: 28.36 },
  // sections.mjs over blocks 1891466–1892905 (1,440 blocks, 1.997 days), node.ergo.watch, 2026-10-12.
  day: { blocks: 721.2, transactions: 4832, unsignedBytes: 3813300, signedBytes: 4344044, idCompressions: 32659, merkleCompressions: 19290 },
  autolykosPerHeader: 2152,
  // native-headers.mjs: autolykosPowValid over 300 mainnet headers, @noble/hashes in Node 24, one core of the host.
  nativeHeaderMs: 11.22,
  // node.ergo.watch /info parameters at height 1892352.
  maxBlockSize: 1271009,
};
const perCompression = (measured.blake2b[2560] - measured.blake2b[1280]) / 10;
const blake2sPerByte = (measured.blake2s[2560] - measured.blake2s[1280]) / 1280;
const leaf = measured.leaf, leafSeconds = Math.max(...measured.prove[0].seconds);
const secondsPerGate = leafSeconds / leaf.gates;
const leafOverhead = leaf.gates - leaf.compressions * perCompression; // the recursive verification and the frame
const day = measured.day;
const witnessIdBytes = 31 * day.transactions;
const sections = day.idCompressions + day.merkleCompressions + Math.round(day.blocks * 2);
const autolykos = Math.round(day.blocks * measured.autolykosPerHeader);
const chainHours = (compressions, gates = perCompression) => {
  const perLeaf = Math.floor((leaf.rows - leafOverhead) / gates);
  return { leaves: Math.ceil(compressions / perLeaf), hours: +(Math.ceil(compressions / perLeaf) * (leafOverhead + perLeaf * gates) * secondsPerGate / 3600).toFixed(1) };
};
const hashing = chainHours(sections);
const dayGates = hashing.leaves * leaf.gates;
// The gates a day's attribution scan may add per unsigned byte before one prover no longer keeps up (24 h),
// each added leaf carrying its recursive verification.
const scanBudget = Math.floor((24 * 3600 / secondsPerGate - dayGates) * (1 - leafOverhead / leaf.rows) / day.unsignedBytes);
// Spam: each extra MB of unsigned bytes adds its id compressions (1 MB / 128) to the chain.
const perMegabyte = chainHours(Math.ceil(1e6 / 128));
const fullBlocks = measured.maxBlockSize * day.blocks;
// A tree instead of a chain: leaves without recursion, and one node verifying two proofs per leaf beyond the first.
const treeLeafCompressions = Math.floor((leaf.rows - measured.blake2b[100] + perCompression) / perCompression);
const treeLeaves = Math.ceil(sections / treeLeafCompressions);
const treeHours = +((treeLeaves * (treeLeafCompressions * perCompression) + (treeLeaves - 1) * measured.recursion.two) * secondsPerGate / 3600).toFixed(1);
console.log(JSON.stringify({
  cpu, measured,
  derived: {
    gatesPerCompression: perCompression,
    gatesPerByte: { blake2b: +(perCompression / 128).toFixed(1), blake2sBlackBox: +blake2sPerByte.toFixed(1) },
    microsecondsPerGate: +(secondsPerGate * 1e6).toFixed(2),
    recursionGates: measured.recursion.two - measured.recursion.one,
    leafOverheadGates: leafOverhead,
    perDay: {
      sectionCompressions: sections,
      sectionLeaves: hashing.leaves,
      sectionProverHours: hashing.hours,
      keepsUpTimes: +(24 / hashing.hours).toFixed(1),
      treeProverHours: treeHours,
      autolykosCompressions: autolykos,
      autolykosProverHours: chainHours(autolykos).hours,
      blake2sEfficientGadgetHours: chainHours(sections, Math.round(blake2sPerByte * 128)).hours,
      nativeHeaderSeconds: +(measured.nativeHeaderMs * day.blocks / 1000).toFixed(1),
      readerMinimumBytes: day.unsignedBytes + witnessIdBytes,
    },
    scanBudgetGatesPerUnsignedByte: scanBudget,
    spam: {
      proverHoursPerExtraMegabyte: perMegabyte.hours,
      extraMegabytesToExceedADay: +((24 - hashing.hours) / perMegabyte.hours).toFixed(1),
      fullBlocksMegabytesPerDay: Math.round(fullBlocks / 1e6),
      fullBlocksProverHours: +(fullBlocks / 1e6 * perMegabyte.hours).toFixed(0),
    },
  },
}, null, 1));
