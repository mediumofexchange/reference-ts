// What every `moe` command shares (slice 10 M10b, items 1, 4, 6 and 12): its
// arguments, its data directory (role, owner-only modes, the process lock,
// SQLite's temporary files kept inside it), its files and its output.
//
// A command first opens its directory: it refuses a directory group or others
// can read, sets the umask to 077 and `SQLITE_TMPDIR` to the directory before
// any SQLite file opens, then takes an exclusive SQLite lock on `lock.db`,
// held for the process's life and released by the operating system if it
// dies, and refuses `BUSY` before opening anything else. On Windows modes are
// not enforced and nothing checks ACLs (a stated limit).
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Construction } from "../pool/v3/construction.js";
import type { Commitment } from "../venue-records.js";
import { declared, isConstructionName, type ConstructionName } from "./construction.js";

export const ROLES = Object.freeze(["wallet", "operator", "reader", "relay"] as const);
export type Role = (typeof ROLES)[number];

/** A command line the command does not take: exit 2. */
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}
/** A refusal of the command itself (a directory, file or argument it will not act on): exit 1. */
export class CommandError extends Error {
  constructor(readonly code: string, message: string, readonly check?: string) { super(message); this.name = "CommandError"; }
}

/**
 * The fields a refusal prints (exit 1), or undefined for an unexpected failure (exit 3). Evidence past a reader's
 * budget (a package, trail, range or fault-evidence limit) is the read's `resource-refusal`, as an `EvidenceRefusal`
 * names it: a source's hostile size is a refusal by name, never a stack.
 */
export async function refusalOf(error: unknown): Promise<{ code: string; check?: string; message: string } | undefined> {
  if (!(error instanceof Error)) return undefined;
  const [{ V3StoreError }, { V3ServiceClientError }, { ReferenceVenueError }, { ProgramError }, { ParameterError }, { EvidenceRefusal, ReplayRefusal },
    { V3WalletError }, { PackageLimitError }, { TrailLimitError }, { RangeLimitError }, { FaultEvidenceLimitError }, { VenueError }, { EncodingError }] =
    await Promise.all([import("../pool/v3/store.js"), import("../pool/v3/service-client.js"), import("../pool/v3/guard.js"),
      import("../pool/v3/programs.js"), import("../pool/proof-verifier.js"), import("../pool/v3/refusals.js"), import("../pool/v3/wallet-store.js"),
      import("../pool/v3/package.js"), import("../pool/v3/trail.js"), import("../record-range.js"), import("../pool/evidence-chain.js"),
      import("../venue-error.js"), import("../bytes.js")]);
  const coded = error as Error & { code?: string; check?: string };
  if (error instanceof CommandError || error instanceof V3StoreError || error instanceof ProgramError || error instanceof ParameterError ||
      error instanceof V3WalletError) {
    return { code: coded.code!, ...(coded.check === undefined ? {} : { check: coded.check }), message: error.message };
  }
  if (error instanceof V3ServiceClientError) return { code: error.code, check: String(error.status), message: error.message };
  if (error instanceof ReplayRefusal) return { code: "REFUSED", check: error.check, message: error.message };
  if (error instanceof EvidenceRefusal) return { code: "UNRESOLVED", check: error.status, message: error.message };
  if (error instanceof PackageLimitError || error instanceof TrailLimitError || error instanceof RangeLimitError ||
      error instanceof FaultEvidenceLimitError) return { code: "UNRESOLVED", check: "resource-refusal", message: error.message };
  if (error instanceof ReferenceVenueError) return { code: "REFERENCE", message: error.message };
  if (error instanceof VenueError) return { code: "VENUE", message: error.message };
  if (error instanceof EncodingError) return { code: "INVALID", message: error.message };
  return undefined;
}

/** A command that is never replayed, rerun: its saved result is printed and the process exits 4 (`fulfill`). */
export class Replayed extends Error {
  constructor(readonly value: object) { super("replayed"); this.name = "Replayed"; }
}

/** A command's arguments: positionals in order, and each `--flag value` (or bare `--flag`) by name. */
export interface Arguments {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}
/** `spec` names each flag the command takes: `value` (once), `values` (repeatable) or `switch` (no value). */
export type FlagSpec = Readonly<Record<string, "value" | "values" | "switch">>;

export function parseArguments(argv: readonly string[], spec: FlagSpec, positionals: number): Arguments {
  const positional: string[] = [], flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2), kind = spec[name];
    if (kind === undefined) throw new UsageError(`unknown option --${name}`);
    const seen = flags.get(name) ?? [];
    if (kind !== "values" && seen.length > 0) throw new UsageError(`--${name} is given twice`);
    if (kind === "switch") { flags.set(name, ["true"]); continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags.set(name, [...seen, value]);
  }
  if (positional.length !== positionals) throw new UsageError(`expected ${positionals} argument${positionals === 1 ? "" : "s"}, got ${positional.length}`);
  return { positional, flags };
}
/** The flags every read takes: its directory, a package file in place of its sources, and its verifier's instances. */
export const READ_FLAGS = { dir: "value", package: "value", verifiers: "value" } as const satisfies FlagSpec;
export const flag = (args: Arguments, name: string): string | undefined => args.flags.get(name)?.[0];
export const flags = (args: Arguments, name: string): readonly string[] => args.flags.get(name) ?? [];
export const has = (args: Arguments, name: string): boolean => args.flags.has(name);
export function required(args: Arguments, name: string): string {
  const value = flag(args, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

/** A decimal integer argument in [min, max]. */
export function integer(text: string, what: string, min = 0n, max = (1n << 63n) - 1n): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new UsageError(`${what} is not a decimal integer`);
  const value = BigInt(text);
  if (value < min || value > max) throw new UsageError(`${what} is out of range`);
  return value;
}
/** 32 bytes as 64 lowercase hex digits. */
export function hex32(text: string, what: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(text)) throw new UsageError(`${what} is not 64 lowercase hex digits`);
  return hexToBytes(text);
}
export const hex = (bytes: Uint8Array): string => bytesToHex(bytes);

const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString()
  : v instanceof Uint8Array ? bytesToHex(v) : v);
/** A commitment as every output names it. */
export const commitmentOut = (c: Commitment) => ({ operator: c.operator, sequence: c.sequence, root: c.root });
/** One JSON object on stdout: bytes as lowercase hex, integers as decimal strings. */
export function print(value: unknown): void { process.stdout.write(`${json(value)}\n`); }
/** One progress event on stderr, written as `print` writes. */
export function event(value: object): void { process.stderr.write(`${json(value)}\n`); }

/** `--poll-ms`: how long a waiting command sleeps between syncs. */
export const pollMs = (args: Arguments): number => Number(integer(flag(args, "poll-ms") ?? "5000", "--poll-ms", 10n, 600_000n));
export const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/** The directory's fixed role and its own node endpoints, written last by `init`, so a directory without it is
 * an interrupted `init`. */
export interface Config {
  readonly role: Role;
  /** This directory's own Ergo node REST endpoints, read in order. */
  readonly nodes: readonly string[];
  /** A funding directory's spend budget for its publisher, in nanoErg. */
  readonly spendBudgetNanoErg?: string;
  /** The construction the directory serves (slice 14 M14g4); absent in a directory made before the choice: pool-v3. */
  readonly construction?: ConstructionName;
}
const CONFIG = "config.json";

function readConfig(directory: string): Config {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(directory, CONFIG), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommandError("INCOMPLETE", "the directory has no config.json: its init did not finish; remove it and init again");
    throw new CommandError("INVALID", "config.json is not JSON");
  }
  const config = parsed as Partial<Config>;
  if (parsed === null || typeof parsed !== "object" || !ROLES.includes(config.role as Role) || !Array.isArray(config.nodes) ||
      !config.nodes.every(node => typeof node === "string" && /^https?:\/\/[^\s]+$/.test(node)) ||
      (config.spendBudgetNanoErg !== undefined && !(typeof config.spendBudgetNanoErg === "string" && /^(0|[1-9][0-9]{0,18})$/.test(config.spendBudgetNanoErg))) ||
      (config.construction !== undefined && !isConstructionName(config.construction)) ||
      Object.keys(parsed).some(key => !["role", "nodes", "spendBudgetNanoErg", "construction"].includes(key))) {
    throw new CommandError("INVALID", "config.json is not a moe directory configuration");
  }
  return config as Config;
}

/** An opened data directory: its absolute path, configuration and declared construction, under the process lock. */
export interface Directory {
  readonly path: string;
  readonly config: Config;
  readonly construction: Construction;
  file(name: string): string;
}

/** The process-wide settings a command needs before any file opens. */
function prepare(path: string): void {
  process.umask(0o077);
  process.env.SQLITE_TMPDIR = path;
}

/** Group or others may read: a directory holding keys must not be. Unchecked where modes are not enforced. */
function requirePrivate(path: string): void {
  let stat;
  try { stat = statSync(path); } catch { throw new CommandError("ABSENT", `no directory at ${path}`); }
  if (!stat.isDirectory()) throw new CommandError("ABSENT", `${path} is not a directory`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CommandError("MODE", `${path} is readable or writable by group or others; chmod 700 it`);
  }
}

/** The exclusive lock on `lock.db`, held until the process exits. */
function lock(path: string): void {
  const db = new DatabaseSync(join(path, "lock.db"), { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) {
      throw new CommandError("BUSY", "another moe command holds this directory");
    }
    throw error;
  }
  // Held for the process's life: never committed, released by the operating system at exit.
  held.push(db);
}
const held: DatabaseSync[] = [];

function directory(path: string, config: Config): Directory {
  return Object.freeze({ path, config, construction: declared(config), file: (name: string) => join(path, name) });
}

function absolute(path: string): string {
  if (path.trim() === "") throw new UsageError("--dir is empty");
  return isAbsolute(path) ? path : resolve(path);
}

/** Open an existing directory of `role`, or of any role for a command every directory takes (`moe venue audit`).
 * `beside` takes no process lock, for a command that only reads the directory's databases beside the process holding
 * it and writes files of its own (`moe operator prepare`, Next 4 (bg)). */
export function openDirectory(dir: string, role: Role | "any", options: { readonly beside?: boolean } = {}): Directory {
  const path = absolute(dir);
  requirePrivate(path);
  prepare(path);
  if (options.beside !== true) lock(path);
  const config = readConfig(path);
  if (role !== "any" && config.role !== role) throw new CommandError("ROLE", `the directory is a ${config.role} directory, not a ${role} directory`);
  return directory(path, config);
}

/** Create a new directory for `role` (owner-only), take its lock and run `fill`; the configuration is written last. */
export async function initDirectory(dir: string, config: Config, fill: (directory: Directory) => Promise<void>): Promise<Directory> {
  const path = absolute(dir);
  prepare(path);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CommandError("EXISTS", `${path} already exists; init creates a new directory`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommandError("ABSENT", `the parent of ${path} does not exist`);
    throw error;
  }
  requirePrivate(path);
  lock(path);
  const opened = directory(path, config);
  await fill(opened);
  writeExclusive(opened.file(CONFIG), `${JSON.stringify(config, null, 2)}\n`);
  return opened;
}

/** Create `path` owner-only, write all of `data` and sync it; refuses an existing file. */
function writeNew(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600), bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  try {
    for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Sync the directory holding `path`, so a link or rename into it outlives a crash; on Windows, which refuses to
 * sync a directory, and where the platform cannot open one, the file system orders it. */
function syncParent(path: string): void {
  if (process.platform === "win32") return;
  let fd: number;
  try { fd = openSync(dirname(path), "r"); } catch (error) {
    if (["EISDIR", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try { fsyncSync(fd); } catch (error) {
    // Some file systems cannot sync a directory; they order the link or rename themselves.
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
  } finally { closeSync(fd); }
}

/** Write a new file whole or not at all: a synced temporary file linked into place, which refuses an existing one.
 * A crash leaves the file absent or complete, so a rerun never meets an empty or partial one. */
export function writeExclusive(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeNew(temporary, data);
    try { linkSync(temporary, path); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new CommandError("EXISTS", `${path} already exists`);
      // FAT and exFAT, among others, take no hard link; Windows also reports denied access as EPERM.
      if (code === "EPERM" || code === "ENOTSUP" || code === "EINVAL" || code === "ENOSYS" || code === "EISDIR") {
        throw new CommandError("STORAGE", `${path}: cannot be linked into place (a file system without hard links, or no access), which a whole-or-nothing write needs`);
      }
      throw error;
    }
  } finally { rmSync(temporary, { force: true }); }
  syncParent(path);
}

/** Write a new file, or accept one already holding exactly `data` (a rerun's output); other bytes there conflict. */
export function writeSame(path: string, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data, held = readOptional(path);
  if (held === undefined) { writeExclusive(path, bytes); return; }
  if (held.length !== bytes.length || held.some((byte, i) => byte !== bytes[i])) throw new CommandError("EXISTS", `${path} already exists and holds other bytes`);
}

/** Replace a file atomically (a synced temporary file renamed over it). */
export function writeReplace(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeNew(temporary, data); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
  syncParent(path);
}

/** A file's bytes, or undefined where it does not exist. */
export function readOptional(path: string): Uint8Array | undefined {
  try { return new Uint8Array(readFileSync(path)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** A file's bytes; a missing one is the command's refusal. */
export function readRequired(path: string, what: string): Uint8Array {
  const bytes = readOptional(path);
  if (bytes === undefined) throw new CommandError("ABSENT", `no ${what} at ${path}`);
  return bytes;
}
/** A JSON file the command reads as public input. */
export function readJson(path: string, what: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRequired(path, what))); } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError("INVALID", `${what} is not JSON`);
  }
}

/** A 32-byte secret kept in a file of its own, written exclusively by `init`: a copy the caller wipes, and the buffer
 * it was read into (which can share a pooled allocation) wiped here, so wiping the copy leaves no other. */
export function readSecret(path: string, what: string): Uint8Array {
  let read: Buffer;
  try { read = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommandError("ABSENT", `no ${what} at ${path}`);
    throw error;
  }
  try {
    if (read.length !== 32) throw new CommandError("INVALID", `${what} is not 32 bytes`);
    return Uint8Array.from(read);
  } finally { read.fill(0); }
}

/** 32 fresh random bytes for a key or token, in an array of their own (never a pooled allocation a wipe would miss). */
export const fresh = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
