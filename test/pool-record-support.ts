// Shared witnessed-record fixtures for pool checkpoint and opening tests.
import { ed25519 } from "@noble/curves/ed25519.js";
import { makeBacking, signBacking } from "../src/backing.js";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { PoolAuthorityView } from "../src/pool/authority.js";
import { readPoolCheckpoint, type PoolCheckpointEvidence } from "../src/pool/checkpoint.js";
import { Segment, type SignedBacking, type StatementVerifier } from "../src/pool/segment.js";
import { replacementMessage, ROLE_OPERATOR } from "../src/replacement.js";
import { LocalVenue } from "../src/venue.js";
import { CONFIG, DOMAIN, issueStatement, Oracle, VENUE } from "./pool-support.js";
import { KEYS, pub, SECRETS } from "./support.js";

export function terms(thing: string): SignedBacking {
  const backing = makeBacking({ obligor: KEYS.backer, payout: { thing, quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2", configuration: DOMAIN,
      witnessing: { venue: VENUE, interval: 1n }, replacementRule: KEYS.backer } });
  return { backing, signature: signBacking(SECRETS.backer, backing) };
}
export function open(venue: LocalVenue, backings: readonly SignedBacking[], oracle: Oracle, sequence = 1n,
  parents: readonly { checkpoint: PoolCheckpointEvidence; segment: Segment }[] = [], operator = KEYS.operator): Segment {
  const scope = new PoolAuthorityView(CONFIG, venue, backings).scope(operator)!;
  const entries = scope.map(e => {
    const parent = parents.find(p => p.checkpoint.directory.some(d => Buffer.from(d.name).equals(e.backing)));
    return { ...e, ...(parent === undefined ? {} : { opening: parent.checkpoint.commitment }) };
  });
  const segment = new Segment(CONFIG, { domain: DOMAIN, venue: venue.id, operator, sequence, entries }, parents.map(p => p.segment.prefix()), oracle);
  for (const b of backings) segment.register(b.backing, b.signature);
  return segment;
}
export function evidence(segment: Segment, sequence = segment.header.sequence, secret = SECRETS.operator): PoolCheckpointEvidence {
  const directory = segment.directory(), trail = segment.trail();
  return { commitment: signCommitment(secret, sequence, directoryRoot(directory)), directory,
    snapshots: trail.header.entries.map(e => ({ backing: e.backing, header: trail.header, historyHash: segment.historyHash(),
      issued: segment.issued(e.backing)!, burned: segment.burned(e.backing)!, backings: trail.backings })),
    history: { trail, length: segment.length } };
}
export function read(venue: LocalVenue, target: PoolCheckpointEvidence, ancestors: readonly PoolCheckpointEvidence[] = [], verifier: StatementVerifier = new Oracle()) {
  return readPoolCheckpoint({ configuration: CONFIG, venue, checkpoint: target.commitment, evidence: [target, ...ancestors], verifier });
}
export async function issue(segment: Segment, oracle: Oracle, backing: SignedBacking, output: bigint) {
  await segment.admit(oracle.accept(issueStatement(segment.authority(), backing.backing.name, 10n, output, SECRETS.backer)));
}
export function replace(venue: LocalVenue, backing: SignedBacking, secret: Uint8Array, effective: bigint) {
  const predecessor = new PoolAuthorityView(CONFIG, venue, [backing]).term(backing.backing.name)!.link;
  const fields = { role: ROLE_OPERATOR, successor: pub(secret), predecessor, effective,
    signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const message = replacementMessage(backing.backing.name, fields);
  venue.publishReplacement(backing.backing.name, { ...fields, signature: ed25519.sign(message, SECRETS.backer),
    successorSignature: ed25519.sign(message, secret) });
}
export async function fixture() {
  const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
  const segment = open(venue, [x, y], oracle);
  await issue(segment, oracle, x, 101n); await issue(segment, oracle, y, 102n);
  const base = evidence(segment); venue.publish(base.commitment);
  return { venue, oracle, x, y, segment, base };
}
