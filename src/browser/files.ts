// Durable files for the browser host (slice 40): a synchronous file system over the origin's private file system
// (OPFS), for node-fs.ts's node:fs and node-sqlite.ts's SQLite files alike, so the library's kept replay files,
// retained evidence and wallet file keep the code, the write-ahead logs and the digests they keep under Node.
//
// A browser engine's file calls are asynchronous except a synchronous access handle's reads, writes, truncation and
// flush, which a dedicated worker may make. So, as SQLite's own OPFS pool does, the files live in a pool of OPFS files
// whose handles are taken when the pool is mounted (`mountFiles`, asynchronous), each holding one file of this system
// behind a header that names it; creating, renaming, linking and removing a file rewrite headers, and a free member of
// the pool is an empty one. New members are added in the background, between the synchronous calls; a file made with
// none free fails as a full disk does (ENOSPC), visibly.
//
// - A header holds the file's names (a hard link adds one), its identity (a random number and its making time, which a
//   copy does not share: file-identity.ts) and a sequence number, in two copies, each with its SHA-256: a header is
//   rewritten over the older copy, so a write torn by a crash leaves the newer one standing. At a mount, a name two
//   members claim (a rename stopped between its two header writes) belongs to the one written last.
// - A mount first takes the access handle of the pool's lock file, which one worker at a time may hold: a second
//   worker's mount (another tab), of an empty pool too, is refused by name (EBUSY) and holds nothing; the browser
//   releases the handles when the worker ends, a crash included.
// - A failure of the browser's storage (a read or flush it could not make, a quota) is reported as a system call's
//   (EIO, ENOSPC), never as damage (replay-store.ts `systemFailure`). A header write that fails leaves the names as
//   they were in memory, but it may have reached the disk: every later call is refused (EIO) until the pool is mounted
//   again, when the headers on disk decide.
// - Directories are names' prefixes, and those made in this mount: an empty directory does not outlive its mount.
// - Durability: a header write is flushed; data is flushed by `flush` (fsync, SQLite's sync), as on a disk.
import { sha256 } from "@noble/hashes/sha2.js";
import { dirname, resolve } from "./node-path.js";

/** The bytes before a file's data in its member: two header copies. */
export const HEADER = 4096;
const COPY = HEADER / 2, SUM = COPY - 32;
const MAGIC = new TextEncoder().encode("moe-files 1\0\0\0\0\0");
/** The pool's lock file: held by the mounted worker, never a member. */
const LOCK = "lock";
/** Free members kept ready by default. More are made once a quarter of them is taken: a synchronous run of calls
 * (a wallet opening its files, its evidence and its kept replay file) takes members with no turn for the background to
 * add any, so the reserve bounds the files one such run may make. */
const RESERVE = 64;

interface SyncHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileHandle { readonly kind: "file"; createSyncAccessHandle(): Promise<SyncHandle> }
interface DirectoryHandle {
  readonly kind: "directory";
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>;
  entries(): AsyncIterable<[string, FileHandle | DirectoryHandle]>;
}
interface StorageManager { getDirectory(): Promise<DirectoryHandle>; persist?(): Promise<boolean>; persisted?(): Promise<boolean> }

/** One member of the pool: a file of this system, or a free one (no names, empty). */
export interface Member {
  readonly handle: SyncHandle;
  names: string[];
  /** The file's identity: a random number and its making time (nanoseconds), fixed while it lives. */
  ino: bigint;
  birth: bigint;
  /** The sequence number of its newer header copy, and which copy that is. */
  sequence: bigint;
  copy: 0 | 1;
  /** Descriptors and SQLite files open on it: a file whose last name goes is freed when the last closes. */
  opens: number;
  /** A temporary file SQLite opened without a name: never given a header, freed at its close. */
  anonymous: boolean;
}

interface Mounted {
  readonly root: DirectoryHandle;
  readonly lock: SyncHandle;
  readonly reserve: number;
  /** Every member, in use or free. */
  readonly all: Set<Member>;
  readonly free: Member[];
  readonly names: Map<string, Member>;
  readonly directories: Set<string>;
  sequence: bigint;
  /** The most members in use at once, for sizing the reserve. */
  peak: number;
  refilling: Promise<void> | undefined;
  refillError: unknown;
  /** A header write or a release that failed: its outcome on disk is unknown, so every call is refused until a remount. */
  failed: unknown;
}
let mounted: Mounted | undefined;

/** An error as a Node system call reports it: its code, negative errno, call and path. */
export function systemError(code: string, errno: number, syscall: string, path: unknown, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}, ${syscall} '${String(path)}'`), { code, errno, syscall, path: String(path) });
}
const ERRNO = { EIO: -5, ENOENT: -2, EBADF: -9, EBUSY: -16, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, ENOSYS: -38, ENOTEMPTY: -39 } as const;
export const fail = (code: keyof typeof ERRNO, syscall: string, path: unknown, message: string): Error =>
  systemError(code, ERRNO[code], syscall, path, message);

/** Whether the pool is mounted in this worker. */
export const isMounted = (): boolean => mounted !== undefined;
function pool(syscall: string, path: unknown): Mounted {
  if (mounted === undefined) throw fail("ENOSYS", syscall, path, "a browser host keeps no files until its file pool is mounted");
  if (mounted.failed !== undefined) throw fail("EIO", syscall, path, `a header write failed (${String(mounted.failed)}); mount the pool again`);
  return mounted;
}

/** A storage call, its browser failure reported as a system call's: a quota as ENOSPC, anything else as EIO. */
function storage<T>(syscall: string, path: unknown, call: () => T): T {
  try { return call(); } catch (error) {
    if (typeof (error as { errno?: unknown }).errno === "number") throw error;
    const name = (error as { name?: string }).name;
    throw fail(name === "QuotaExceededError" ? "ENOSPC" : "EIO", syscall, path, `the browser's storage failed: ${String((error as Error)?.message ?? error)}`);
  }
}
const nonNegative = (value: number, syscall: string, path: unknown): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail("EINVAL", syscall, path, "invalid argument");
};

/** A path as this system names it: absolute, normalized. */
export const normal = (path: string | URL): string => resolve(path instanceof URL ? path.pathname : String(path));

function decode(bytes: Uint8Array, copy: 0 | 1): { names: string[]; ino: bigint; birth: bigint; sequence: bigint } | undefined {
  const part = bytes.subarray(copy * COPY, (copy + 1) * COPY);
  if (!MAGIC.every((byte, i) => part[i] === byte)) return undefined;
  const sum = sha256(part.subarray(0, SUM));
  if (!sum.every((byte, i) => part[SUM + i] === byte)) return undefined;
  const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
  const sequence = view.getBigUint64(16), ino = view.getBigUint64(24), birth = view.getBigUint64(32), count = view.getUint16(40);
  const names: string[] = [], text = new TextDecoder("utf-8", { fatal: true });
  let at = 42;
  for (let i = 0; i < count; i++) {
    const length = view.getUint16(at);
    if (at + 2 + length > SUM) return undefined;
    names.push(text.decode(part.subarray(at + 2, at + 2 + length)));
    at += 2 + length;
  }
  return { names, ino, birth, sequence };
}

function encode(member: Member, names: readonly string[], sequence: bigint): Uint8Array {
  const part = new Uint8Array(COPY), view = new DataView(part.buffer);
  part.set(MAGIC);
  view.setBigUint64(16, sequence); view.setBigUint64(24, member.ino); view.setBigUint64(32, member.birth);
  view.setUint16(40, names.length);
  let at = 42;
  for (const name of names) {
    const bytes = new TextEncoder().encode(name);
    if (at + 2 + bytes.length > SUM) throw fail("EINVAL", "open", name, "a file's names exceed its header");
    view.setUint16(at, bytes.length); part.set(bytes, at + 2);
    at += 2 + bytes.length;
  }
  part.set(sha256(part.subarray(0, SUM)), SUM);
  return part;
}

/** Rewrite a member's header over its older copy with `names`, and flush it; only then does the member take them. A
 * failed write may have reached the disk: the pool refuses every later call until it is mounted again. */
function writeHeader(state: Mounted, member: Member, names: readonly string[], syscall: string): void {
  const copy: 0 | 1 = member.copy === 0 ? 1 : 0, sequence = state.sequence++;
  const part = encode(member, names, sequence);
  try {
    storage(syscall, names[0], () => {
      if (member.handle.write(part, { at: copy * COPY }) !== COPY) throw fail("ENOSPC", syscall, names[0], "a header write fell short");
      member.handle.flush();
    });
  } catch (error) { state.failed = error; throw error; }
  member.names = [...names]; member.sequence = sequence; member.copy = copy;
}

/** Empty a member and return it to the free ones; one that cannot be emptied fails the pool as a header write does. */
function release(state: Mounted, member: Member, syscall: string): void {
  try { storage(syscall, member.names[0], () => { member.handle.truncate(0); member.handle.flush(); }); } catch (error) { state.failed = error; throw error; }
  member.names = []; member.anonymous = false; member.opens = 0; member.sequence = 0n; member.copy = 1;
  state.free.push(member);
}

const randomIno = (): bigint => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n) | 1n;
};

/** Add free members until `count` are free, in the background of the synchronous calls. */
function refill(state: Mounted, count: number): Promise<void> {
  state.refilling ??= (async () => {
    try {
      // A pool being unmounted takes no new member.
      while (state.free.length < count && mounted === state) {
        const name = `m${Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
        const handle = await (await state.root.getFileHandle(name, { create: true })).createSyncAccessHandle();
        const member: Member = { handle, names: [], ino: 0n, birth: 0n, sequence: 0n, copy: 1, opens: 0, anonymous: false };
        state.all.add(member); state.free.push(member);
      }
      state.refillError = undefined;
    } catch (error) { state.refillError = error; } finally { state.refilling = undefined; }
  })();
  return state.refilling;
}

function take(state: Mounted, path: string): Member {
  const member = state.free.pop();
  state.peak = Math.max(state.peak, state.all.size - state.free.length);
  if (state.free.length < (state.reserve * 3) / 4) void refill(state, state.reserve);
  if (member === undefined) {
    throw fail("ENOSPC", "open", path, `no free file in the pool${state.refillError === undefined ? "" : ` (${String(state.refillError)})`}`);
  }
  return member;
}

export interface Mount {
  /** Files found by name. */
  readonly files: number;
  /** Whether the browser keeps the origin's storage under storage pressure: `navigator.storage.persist`'s answer, or in a
   * worker, which cannot ask (only a window can), `persisted`'s, so a page asks before its workers mount. */
  readonly persisted: boolean | undefined;
}

/** Mount the pool in OPFS directory `name`, taking every member's handle: refused (EBUSY) where another worker holds
 * one. Each later synchronous call reads and writes through it. */
export async function mountFiles(name = "moe-files", options: { readonly reserve?: number; readonly persist?: boolean } = {}): Promise<Mount> {
  if (mounted !== undefined) throw fail("EBUSY", "mount", name, "the file pool is already mounted");
  const manager = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (manager?.getDirectory === undefined) throw fail("ENOSYS", "mount", name, "this engine has no origin private file system");
  const root = await (await manager.getDirectory()).getDirectoryHandle(name, { create: true });
  // The lock file first: two workers mounting an empty pool would otherwise each make their own members.
  let lock: SyncHandle;
  try { lock = await (await root.getFileHandle(LOCK, { create: true })).createSyncAccessHandle(); } catch (error) {
    throw (error as { name?: string }).name === "NoModificationAllowedError" ? fail("EBUSY", "mount", name, "another worker holds the file pool") : error;
  }
  const members: Member[] = [];
  try {
    for await (const [entryName, entry] of root.entries()) {
      if (entry.kind !== "file" || entryName === LOCK) continue;
      let handle: SyncHandle;
      try { handle = await entry.createSyncAccessHandle(); } catch (error) {
        throw (error as { name?: string }).name === "NoModificationAllowedError"
          ? fail("EBUSY", "mount", name, "another worker holds the file pool") : error;
      }
      const member: Member = { handle, names: [], ino: 0n, birth: 0n, sequence: 0n, copy: 1, opens: 0, anonymous: false };
      members.push(member);
      // A file's first header copy is written before its data; the second may never have been.
      const bytes = new Uint8Array(HEADER), length = handle.read(bytes, { at: 0 });
      const copies = [length >= COPY ? decode(bytes, 0) : undefined, length >= HEADER ? decode(bytes, 1) : undefined];
      const newer: 0 | 1 = copies[1] !== undefined && (copies[0] === undefined || copies[1].sequence > copies[0].sequence) ? 1 : 0;
      const header = copies[newer];
      if (header === undefined) continue;
      Object.assign(member, header, { copy: newer });
    }
  } catch (error) {
    for (const member of members) member.handle.close();
    lock.close();
    throw error;
  }
  const state: Mounted = { root, lock, reserve: Math.max(2, options.reserve ?? RESERVE), all: new Set(members), free: [], names: new Map(), directories: new Set(["/"]),
    sequence: 1n, peak: 0, refilling: undefined, refillError: undefined, failed: undefined };
  try {
    for (const member of members) if (member.sequence >= state.sequence) state.sequence = member.sequence + 1n;
    // A name two members claim belongs to the one written last: a rename stopped between its two header writes.
    for (const member of [...members].sort((a, b) => (a.sequence < b.sequence ? 1 : a.sequence > b.sequence ? -1 : 0))) {
      const kept = member.names.filter(name => !state.names.has(name));
      for (const name of kept) state.names.set(name, member);
      if (kept.length === 0) release(state, member, "mount");
      else if (kept.length !== member.names.length) writeHeader(state, member, kept, "mount");
      if (state.failed !== undefined) throw state.failed;
    }
  } catch (error) {
    for (const member of members) member.handle.close();
    lock.close();
    throw error;
  }
  mounted = state;
  await refill(state, state.reserve);
  let persisted: boolean | undefined;
  if (options.persist !== false) {
    try { persisted = await (manager.persist !== undefined ? manager.persist() : manager.persisted?.()); } catch { persisted = undefined; }
  }
  return { files: state.names.size, persisted };
}

/** The pool's members by use: files by name, open unnamed ones (temporary files, and files removed while open), and
 * free ones, and the most in use at once. */
export function poolUse(): { readonly files: number; readonly unnamed: number; readonly free: number; readonly members: number; readonly peak: number; readonly refill?: string } {
  const state = mounted;
  if (state === undefined) throw fail("ENOSYS", "stat", "(pool)", "a browser host keeps no files until its file pool is mounted");
  const named = new Set(state.names.values());
  return { files: named.size, unnamed: state.all.size - named.size - state.free.length, free: state.free.length, members: state.all.size, peak: state.peak,
    ...(state.refillError === undefined ? {} : { refill: String(state.refillError) }) };
}

/** Close every member's handle and the lock's, so another worker may mount the pool: refused (EBUSY) while a file is
 * open (a descriptor, a SQLite connection, a kept file's lock), whose state would outlive the mount. */
export async function unmountFiles(): Promise<void> {
  const state = mounted;
  if (state === undefined) return;
  for (const member of state.all) if (member.opens > 0) throw fail("EBUSY", "umount", member.names[0] ?? "(temporary)", "a file of the pool is open");
  mounted = undefined;
  await state.refilling;
  for (const member of state.all) member.handle.close();
  state.lock.close();
}

/** The file at `path`, if any. */
export function lookup(path: string): Member | undefined {
  return pool("open", path).names.get(normal(path));
}

/** Whether `path` is a directory: one made in this mount, or a prefix of a file's name. */
export function isDirectory(path: string): boolean {
  const state = pool("stat", path), name = normal(path);
  if (state.directories.has(name)) return true;
  if (state.names.has(name)) return false;
  const prefix = name === "/" ? "/" : `${name}/`;
  for (const file of state.names.keys()) if (file.startsWith(prefix)) return true;
  return false;
}

function parentExists(state: Mounted, syscall: string, name: string): void {
  const parent = dirname(name);
  if (state.names.has(parent)) throw fail("ENOTDIR", syscall, name, "a file is not a directory");
  if (!isDirectory(parent)) throw fail("ENOENT", syscall, name, "no such file or directory");
}

/** A new file at `path`, or the one there unless `exclusive` (EEXIST). */
export function create(path: string, exclusive: boolean): Member {
  const state = pool("open", path), name = normal(path);
  const there = state.names.get(name);
  if (there !== undefined) {
    if (exclusive) throw fail("EEXIST", "open", name, "file already exists");
    return there;
  }
  if (isDirectory(name)) throw fail("EISDIR", "open", name, "illegal operation on a directory");
  parentExists(state, "open", name);
  const member = take(state, name);
  member.ino = randomIno(); member.birth = BigInt(Date.now()) * 1_000_000n;
  // The whole header's length first, so an empty file reads as one at the next mount.
  try { storage("open", name, () => member.handle.truncate(HEADER)); } catch (error) { state.free.push(member); throw error; }
  writeHeader(state, member, [name], "open");
  state.names.set(name, member);
  return member;
}

/** A temporary file with no name (SQLite's), freed at its close. */
export function anonymous(): Member {
  const state = pool("open", "(temporary)"), member = take(state, "(temporary)");
  member.anonymous = true; member.ino = randomIno(); member.birth = BigInt(Date.now()) * 1_000_000n;
  return member;
}

export const opened = (member: Member): void => { member.opens++; };
/** Close one opening of `member`: one with no name left is freed at its last close. A failed pool still counts the
 * close, so it can be unmounted and mounted again, but frees nothing: the next mount judges the member. */
export function closed(member: Member): void {
  const state = mounted;
  if (state === undefined) throw fail("ENOSYS", "close", member.names[0], "a browser host keeps no files until its file pool is mounted");
  if (--member.opens <= 0 && member.names.length === 0 && state.failed === undefined) release(state, member, "close");
}

/** The data's size, in bytes. */
export const size = (member: Member): number => Math.max(0, storage("fstat", member.names[0], () => member.handle.getSize()) - HEADER);
/** Read into `bytes` from data offset `at`; the count read. */
export function read(member: Member, bytes: Uint8Array, at: number): number {
  nonNegative(at, "read", member.names[0]);
  const length = size(member);
  return at >= length ? 0 : storage("read", member.names[0], () => member.handle.read(bytes.subarray(0, Math.min(bytes.length, length - at)), { at: HEADER + at }));
}
/** Write `bytes` at data offset `at`; the count written. */
export function write(member: Member, bytes: Uint8Array, at: number): number {
  nonNegative(at, "write", member.names[0]);
  // An anonymous file has no header: its first bytes stay zero, so a crash leaves it free.
  return storage("write", member.names[0], () => member.handle.write(bytes, { at: HEADER + at }));
}
export function truncate(member: Member, length: number): void {
  nonNegative(length, "ftruncate", member.names[0]);
  storage("ftruncate", member.names[0], () => member.handle.truncate(HEADER + length));
}
export const flush = (member: Member): void => storage("fsync", member.names[0], () => member.handle.flush());

/** Remove the name `path`; the file goes with its last name, once no opening holds it. */
export function unlink(path: string, syscall = "unlink"): void {
  const state = pool(syscall, path), name = normal(path), member = state.names.get(name);
  if (member === undefined) throw fail(isDirectory(name) ? "EISDIR" : "ENOENT", syscall, name, isDirectory(name) ? "illegal operation on a directory" : "no such file or directory");
  const names = member.names.filter(other => other !== name);
  if (names.length > 0 || member.opens > 0) writeHeader(state, member, names, syscall);
  else release(state, member, syscall);
  state.names.delete(name);
}

/** A second name `to` for the file at `from` (a hard link): EEXIST where `to` exists. */
export function link(from: string, to: string): void {
  const state = pool("link", from), source = normal(from), target = normal(to), member = state.names.get(source);
  if (member === undefined) throw fail("ENOENT", "link", source, "no such file or directory");
  if (state.names.has(target) || isDirectory(target)) throw fail("EEXIST", "link", target, "file already exists");
  parentExists(state, "link", target);
  writeHeader(state, member, [...member.names, target], "link");
  state.names.set(target, member);
}

/** Rename the file `from` to `to`, replacing a file there: atomic across a crash, the moved file's header written first. */
export function rename(from: string, to: string): void {
  const state = pool("rename", from), source = normal(from), target = normal(to), member = state.names.get(source);
  if (member === undefined) throw fail("ENOENT", "rename", source, "no such file or directory");
  if (source === target) return;
  if (isDirectory(target)) throw fail("EISDIR", "rename", target, "illegal operation on a directory");
  parentExists(state, "rename", target);
  const replaced = state.names.get(target);
  // Two names of one file: POSIX leaves both.
  if (replaced === member) return;
  writeHeader(state, member, member.names.map(name => (name === source ? target : name)), "rename");
  state.names.delete(source);
  state.names.set(target, member);
  if (replaced !== undefined) {
    const names = replaced.names.filter(name => name !== target);
    if (names.length > 0 || replaced.opens > 0) writeHeader(state, replaced, names, "rename");
    else release(state, replaced, "rename");
  }
}

/** Make the directory `path` (and its parents with `recursive`): the first directory made, if any. */
export function mkdir(path: string, recursive: boolean): string | undefined {
  const state = pool("mkdir", path), name = normal(path);
  if (state.names.has(name)) throw fail("EEXIST", "mkdir", name, "file already exists");
  if (isDirectory(name)) { if (recursive) return undefined; throw fail("EEXIST", "mkdir", name, "file already exists"); }
  let first: string | undefined;
  if (recursive) { if (name !== "/") first = mkdir(dirname(name), true); }
  else parentExists(state, "mkdir", name);
  state.directories.add(name);
  return first ?? name;
}

/** The names directly in directory `path`, sorted. */
export function list(path: string): string[] {
  const state = pool("scandir", path), name = normal(path);
  if (state.names.has(name)) throw fail("ENOTDIR", "scandir", name, "not a directory");
  if (!isDirectory(name)) throw fail("ENOENT", "scandir", name, "no such file or directory");
  const prefix = name === "/" ? "/" : `${name}/`, entries = new Set<string>();
  for (const file of [...state.names.keys(), ...state.directories]) {
    if (file.startsWith(prefix) && file.length > prefix.length) entries.add(file.slice(prefix.length).split("/")[0]!);
  }
  return [...entries].sort();
}

/** Remove directory `path`: with `recursive`, every file and directory under it; otherwise only an empty one. */
export function rmdir(path: string, recursive: boolean): void {
  const state = pool("rmdir", path), name = normal(path);
  if (!isDirectory(name)) throw fail("ENOENT", "rmdir", name, "no such file or directory");
  const prefix = name === "/" ? "/" : `${name}/`;
  const files = [...state.names.keys()].filter(file => file.startsWith(prefix));
  const directories = [...state.directories].filter(directory => directory.startsWith(prefix));
  if (!recursive && (files.length > 0 || directories.length > 0)) throw fail("ENOTEMPTY", "rmdir", name, "directory not empty");
  for (const file of files) unlink(file, "rm");
  for (const directory of directories) state.directories.delete(directory);
  if (name !== "/") state.directories.delete(name);
}
