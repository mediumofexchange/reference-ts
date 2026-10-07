// A database file's identity (slice 13 M13d, M13e): its inode, and its birth time where the filesystem keeps one (not
// the device, which a remount can change). A fresh copy, or a file restored to another disk or machine, usually has
// another. It is a guard, never the mechanism: a file overwritten in place or a filesystem or machine snapshot rolled
// back keeps it, and where no birth time is kept (Linux) a directory removed and copied back from a backup can take
// the freed inodes again. Restoration is the owner's step to record. Each store that signs, credits or reuses its own
// rows keeps the identity of the file it was made in and treats another as a copy: the operator journal and a wallet
// refuse until a restoration is recorded, a replay file is discarded, an Ergo view is audited.
import { statSync } from "node:fs";

// Linux reports a birth time only through statx; without it libuv reports the change time, which every write moves.
const BIRTH_TIME = !["linux", "android"].includes(process.platform);

/** The identity of the file at `path`, which must exist. */
export function fileIdentity(path: string): string {
  const { ino, birthtimeNs } = statSync(path, { bigint: true });
  return BIRTH_TIME && birthtimeNs !== 0n ? `${ino}:${birthtimeNs}` : `${ino}`;
}
