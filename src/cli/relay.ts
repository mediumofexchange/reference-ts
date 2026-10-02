// `moe relay` (slice 10 M10b, item 8): publishes a holder's or backer's
// publication file at the venue from a funding key kept apart from any wallet.
// `relay publish <file>` refuses a venue other than its own `venue.json`'s,
// decodes the publication and requires its backing to be the subject, refuses
// a demand whose instant its view has not reached, then publishes with its
// funding key (`funding.key`) within the directory's spend budget, keeping its
// publisher's pending transactions in `relay.db`. A rerun is keyed by the
// record: once the view witnesses it, the rerun prints that index.
//
// This supplies the mechanism; the duty stays open (docs/POOL_V3_VISIBILITY.md):
// a relay of the holder's own links its gap acts to each other and to its
// funding, and a third party's relay learns the holder's channel.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../bytes.js";
import { adoptedDomain } from "../pool/v3/configuration.js";
import { decodePublication } from "../pool/v3/records.js";
import { CommandError, flag, integer, openDirectory, parseArguments, print, readJson, required, UsageError, writeExclusive,
  type Arguments } from "./common.js";
import { initRole } from "./reader.js";
import { freshFunding, fundingTree, openPublisher, openView, publisherStore, requireVenue } from "./venue.js";

async function init(argv: readonly string[]): Promise<void> {
  return initRole(argv, "relay", { venue: "required", budget: true, fill: async directory => {
    const funding = freshFunding();
    writeExclusive(directory.file("funding.key"), funding);
    const shown = { fundingTree: fundingTree(funding) };
    funding.fill(0);
    return shown;
  } });
}

/** A publication file as a wallet's `publish` or `publish-acceptance` writes it. */
interface PublicationFile { readonly venue: Uint8Array; readonly backing: Uint8Array; readonly kind: 4; readonly subject: Uint8Array; readonly record: Uint8Array }
export function parsePublicationFile(value: unknown): PublicationFile {
  const invalid = (): never => { throw new CommandError("INVALID", "the file is not a moe publication file"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as { [key: string]: unknown };
  if (Object.keys(v).sort().join() !== "backing,kind,record,schema,subject,venue" || v.schema !== "moe-publication-1") invalid();
  const bytes = (x: unknown, length?: number): Uint8Array => typeof x === "string" && /^(?:[0-9a-f]{2})+$/.test(x) &&
    (length === undefined || x.length === 2 * length) ? hexToBytes(x) : invalid();
  // A wallet publishes only at kind 4, the backing's publications (pool-v3 §13).
  if (v.kind !== "4") throw new CommandError("INVALID", "a relay publishes only a backing's publications (kind 4)");
  return { venue: bytes(v.venue, 32), backing: bytes(v.backing, 32), kind: 4, subject: bytes(v.subject, 32), record: bytes(v.record) };
}

const pollMs = (args: Arguments): number => Number(integer(flag(args, "poll-ms") ?? "5000", "--poll-ms", 10n, 600_000n));
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

/** `publish <file> [--wait <indices>]`: publish the file's record; with `--wait`, sync until the view witnesses it,
 * at most that many witnessed indices past the publication. */
async function publish(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", wait: "value", "poll-ms": "value" }, 1);
  const directory = openDirectory(required(args, "dir"), "relay"), venue = requireVenue(directory);
  const file = parsePublicationFile(readJson(args.positional[0]!, "the publication file"));
  if (compareBytes(file.venue, venue.id) !== 0) throw new CommandError("VENUE", "the publication names another venue than this relay's venue.json");
  let publication;
  try { publication = decodePublication(file.record); } catch (error) {
    if (error instanceof EncodingError) throw new CommandError("INVALID", "the record is not a pool-v3 publication");
    throw error;
  }
  if (compareBytes(publication.backing, file.backing) !== 0 || compareBytes(file.subject, file.backing) !== 0) {
    throw new CommandError("SUBJECT", "the publication's backing is not the subject it is filed under");
  }
  if (compareBytes(publication.domain, adoptedDomain()) !== 0) throw new CommandError("CONFIGURATION", "the publication names another configuration");
  const wait = flag(args, "wait") === undefined ? undefined : integer(flag(args, "wait")!, "--wait", 1n, 1000n);
  const view = openView(directory), store = publisherStore(directory.file("relay.db"));
  try {
    const { publisher, budget } = openPublisher(directory, store.persistence);
    try {
      // Attached before the sync, so the sync settles what the publisher kept pending.
      view.venue.attachPublisher(publisher);
      const at = (await view.sync()).witnessedIndex;
      if (at === undefined) throw new CommandError("UNAVAILABLE", "the venue has witnessed nothing yet: its first index is final once the depth is mined above it");
      const record = sha256(file.record), witnessed = () => view.venue.witnessedAt(4, file.subject, file.record);
      const held = witnessed();
      if (held !== undefined) { print({ status: "final", record, index: held }); return; }
      // A demand's instant is the index its holder read at; one the view has not reached would be published early.
      if (publication.kind === 1 && view.venue.witnessedIndex() < publication.record.publicInputs.at(-2)!) {
        throw new CommandError("EARLY", "the demand's instant is past this relay's witnessed index; sync its nodes and publish again");
      }
      let sent;
      budget.take();
      try { sent = await view.venue.publish(4, file.subject, file.record); } catch (error) { throw budget.take() ?? error; }
      if (wait !== undefined) {
        const start = view.venue.witnessedIndex(), ms = pollMs(args);
        for (;;) {
          const index = witnessed();
          if (index !== undefined) { print({ status: "final", record, index, transaction: sent === undefined ? null : bytesToHex(sent.id) }); return; }
          if (view.venue.witnessedIndex() > start + wait) throw new CommandError("UNWITNESSED", `the view has not witnessed the record within ${wait} indices; rerun to publish again`);
          process.stderr.write(`${JSON.stringify({ event: "waiting", witnessedIndex: view.venue.witnessedIndex().toString() })}\n`);
          await pause(ms);
          await view.sync();
        }
      }
      print({ status: "pending", record, transaction: sent === undefined ? null : bytesToHex(sent.id), witnessedIndex: at });
    } finally { budget.close(); }
  } finally { view.close(); store.close(); }
}

export async function relay(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return init(rest);
    case "publish": return publish(rest);
    default: throw new UsageError("moe relay init|publish");
  }
}
