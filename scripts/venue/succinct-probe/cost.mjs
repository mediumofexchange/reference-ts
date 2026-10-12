// Slice 21's cost model: what a prover of §13.2 exhaustion over a day of Ergo mainnet pays under the declared
// proof system (UltraHonk over BN254, Barretenberg 5.2.0, Noir 1.0.0-beta.26), from the measurements below.
// Usage: node cost.mjs > results.json   (the measured inputs are the other scripts' outputs, copied here)
const cpu = 'Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15 GB (cloud container)';
const measured = {
  // probe.mjs: circuit size (gates) of Blake2b-256 over L bytes, and of the Blake2s black box over L bytes.
  blake2b: { 100: 35469, 1280: 333105, 2560: 662515, 5120: 1321335, 10240: 2638975 },
  blake2s: { 100: 17408, 640: 32328, 1280: 64418, 2560: 128598 },
  // time-prove.sh: prove alone with a precomputed vk, 4 threads (gates, padded size, seconds, peak MiB).
  prove: [
    { gates: 662515, padded: 2 ** 20, seconds: 13.18, peakMiB: 981 },
    { gates: 1321335, padded: 2 ** 21, seconds: 24.27, peakMiB: 1932 },
    { gates: 2638975, padded: 2 ** 22, seconds: 46.61, peakMiB: 3819 },
  ],
  proofBytes: 14656,
  // recurse.mjs: one and two noir-recursive UltraHonk verifications in one circuit; a tampered proof fails.
  recursion: { one: 704636, two: 1471658, twoSeconds: 28.36 },
  // sections.mjs over blocks 1891466–1892905 (1,440 blocks, 1.997 days), node.ergo.watch, 2026-10-12.
  day: { blocks: 721.2, transactions: 4832, unsignedBytes: 3813300, signedBytes: 4344044, idCompressions: 32659, merkleCompressions: 19290 },
  autolykosPerHeader: 2152,
  // native-headers.mjs: autolykosPowValid over 300 mainnet headers, @noble/hashes in Node 24, one core.
  nativeHeaderMs: 11.22,
};
const perCompression = (measured.blake2b[2560] - measured.blake2b[1280]) / 10;
const blake2sPerByte = (measured.blake2s[2560] - measured.blake2s[1280]) / 1280;
const top = measured.prove.at(-1);
const secondsPerPaddedGate = top.seconds / top.padded;
const recursionGates = measured.recursion.two - measured.recursion.one;
// One proof per 2^22 rows that also verifies its predecessor (a chain), leaving this many compressions per proof.
const perProof = Math.floor((top.padded - recursionGates - measured.blake2b[100] + perCompression) / perCompression);
const day = measured.day;
const sections = day.idCompressions + day.merkleCompressions + Math.round(day.blocks * 2);
const autolykos = Math.round(day.blocks * measured.autolykosPerHeader);
const hours = (compressions) => +(Math.ceil(compressions / perProof) * top.seconds / 3600).toFixed(1);
console.log(JSON.stringify({
  cpu, measured,
  derived: {
    gatesPerCompression: perCompression,
    gatesPerByte: { blake2b: +(perCompression / 128).toFixed(1), blake2sBlackBox: +blake2sPerByte.toFixed(1) },
    microsecondsPerPaddedGate: +(secondsPerPaddedGate * 1e6).toFixed(2),
    recursionGates,
    compressionsPerChainedProof: perProof,
    perDay: {
      sectionCompressions: sections,
      sectionProofs: Math.ceil(sections / perProof),
      sectionProverHours: hours(sections),
      autolykosCompressions: autolykos,
      autolykosProofs: Math.ceil(autolykos / perProof),
      autolykosProverHours: hours(autolykos),
      nativeHeaderSeconds: +(measured.nativeHeaderMs * day.blocks / 1000).toFixed(1),
    },
    parsingBreakEvenGatesPerUnsignedByte: Math.round(sections * perCompression / day.unsignedBytes),
  },
}, null, 1));
