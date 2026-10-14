// node:fs in a browser engine (slices 39 and 40), for the browser bundle (scripts/browser/build.mjs substitutes this
// module for node:fs).
// - `readFileSync` of a URL reads the package's own assets beside the bundle (the compiled relations and the check
//   set, which `programs.ts` and `check-set.ts` read by URL beside their module) by a synchronous request, which a
//   worker may make; its answer is checked by the reader of the asset exactly as a file's would be.
// - Paths are files of the worker's file pool (files.ts) once it is mounted (`mountFiles`): the synchronous calls the
//   library and its tests make, with Node's semantics and refusals (ENOENT, EEXIST, EISDIR, ENOTDIR, ENOTEMPTY, EBADF)
//   as far as they use them. Modes are not kept (an origin's files are its own).
// - Before a mount no file exists: `existsSync` answers false and every other call fails as a system call does where
//   the system has none (ENOSYS, naming the call), so a store that would keep a file fails visibly, as a failure of
//   the system and never as damage to discard (replay-store.ts `systemFailure`).
import * as files from "./files.js";
import { fail, isMounted, normal, systemError } from "./files.js";
import { dirname } from "./node-path.js";

interface SyncRequest {
  open(method: string, url: string, async: false): void;
  overrideMimeType(type: string): void;
  send(): void;
  readonly status: number;
  readonly responseText: string;
}
declare const XMLHttpRequest: { new(): SyncRequest } | undefined;

function absent(syscall: string, path: unknown): Error {
  return systemError("ENOSYS", -38, syscall, path, "a browser host keeps no files until its file pool is mounted");
}
const asset = (path: unknown): URL | undefined => {
  const url = path instanceof URL ? path : typeof path === "string" && /^https?:\/\//.test(path) ? new URL(path) : undefined;
  return url !== undefined && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
};
type Encoding = BufferEncoding | null | undefined;
const encodingOf = (options: unknown): Encoding =>
  typeof options === "string" ? options as BufferEncoding : (options as { encoding?: Encoding } | undefined)?.encoding ?? undefined;

function readAsset(url: URL, encoding: Encoding): string | Buffer {
  if (typeof XMLHttpRequest === "undefined") throw absent("open", url.href);
  const request = new XMLHttpRequest();
  request.open("GET", url.href, false);
  // Bytes as they were sent: a byte-per-character answer, read back below.
  if (encoding !== "utf8" && encoding !== "utf-8") request.overrideMimeType("text/plain; charset=x-user-defined");
  request.send();
  if (request.status !== 200) {
    throw systemError("ENOENT", -2, "open", url.href, `no such asset (${request.status})`);
  }
  if (encoding === "utf8" || encoding === "utf-8") return request.responseText;
  const text = request.responseText, bytes = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return encoding === undefined || encoding === null ? bytes : bytes.toString(encoding);
}

/** The pool, mounted: every file call but an asset's needs it. */
function mountedFor(syscall: string, path: unknown): void {
  if (!isMounted()) throw absent(syscall, path);
}
const pathOf = (path: unknown, syscall: string): string => {
  if (typeof path !== "string" && !(path instanceof URL) && !(path instanceof Uint8Array)) {
    throw Object.assign(new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL`), { code: "ERR_INVALID_ARG_TYPE" });
  }
  mountedFor(syscall, path);
  return normal(path instanceof Uint8Array ? new TextDecoder().decode(path) : path);
};
function existing(path: string, syscall: string): files.Member {
  const member = files.lookup(path);
  if (member === undefined) {
    if (files.isDirectory(path)) throw fail("EISDIR", syscall, path, "illegal operation on a directory");
    throw fail("ENOENT", syscall, path, "no such file or directory");
  }
  return member;
}
const bytesOf = (data: string | ArrayBufferView, encoding: Encoding = "utf8"): Uint8Array =>
  typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/** Every byte of a file. */
function contents(member: files.Member): Buffer {
  const bytes = Buffer.alloc(files.size(member));
  if (files.read(member, bytes, 0) !== bytes.length) throw fail("EINVAL", "read", member.names[0], "a short read");
  return bytes;
}

export function readFileSync(path: string | URL | number, options?: Encoding | { readonly encoding?: Encoding; readonly flag?: string }): string | Buffer {
  const url = asset(path), encoding = encodingOf(options);
  if (url !== undefined) return readAsset(url, encoding);
  const bytes = typeof path === "number" ? contents(descriptor(path, "read").member) : contents(existing(pathOf(path, "open"), "open"));
  return encoding === undefined || encoding === null ? bytes : bytes.toString(encoding);
}

export function writeFileSync(path: string | URL | number, data: string | ArrayBufferView,
  options?: Encoding | { readonly encoding?: Encoding; readonly flag?: string; readonly mode?: number }): void {
  const flag = typeof options === "object" && options !== null ? options.flag ?? "w" : "w";
  const fd = typeof path === "number" ? path : openSync(path, flag);
  try {
    const bytes = bytesOf(data, encodingOf(options));
    for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
  } finally { if (typeof path !== "number") closeSync(fd); }
}

export function existsSync(path: unknown): boolean {
  if (!isMounted() || (typeof path !== "string" && !(path instanceof URL))) return false;
  const name = normal(path);
  return files.lookup(name) !== undefined || files.isDirectory(name);
}

/** What `statSync` gives: Node's fields the library and its tests read, as numbers or (`bigint`) bigints. */
function stats(member: files.Member | undefined, bigint: boolean): object {
  const size = member === undefined ? 0 : files.size(member), ino = member?.ino ?? 1n, birth = member?.birth ?? 0n;
  const nlink = member === undefined ? 1 : Math.max(1, member.names.length);
  const directory = member === undefined, ms = Number(birth / 1_000_000n);
  const common = { isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
  return bigint
    ? { ...common, size: BigInt(size), ino, nlink: BigInt(nlink), dev: 1n, mode: directory ? 0o40700n : 0o100600n, birthtimeNs: birth, mtimeNs: birth, birthtimeMs: BigInt(ms), mtimeMs: BigInt(ms) }
    : { ...common, size, ino: Number(ino), nlink, dev: 1, mode: directory ? 0o40700 : 0o100600, birthtimeMs: ms, mtimeMs: ms, birthtime: new Date(ms), mtime: new Date(ms) };
}

export function statSync(path: string | URL, options?: { readonly bigint?: boolean; readonly throwIfNoEntry?: boolean }): object | undefined {
  const name = pathOf(path, "stat"), member = files.lookup(name);
  if (member === undefined && !files.isDirectory(name)) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw fail("ENOENT", "stat", name, "no such file or directory");
  }
  return stats(member, options?.bigint === true);
}
export const lstatSync = statSync;

export function realpathSync(path: string | URL): string {
  const name = pathOf(path, "realpath");
  if (files.lookup(name) === undefined && !files.isDirectory(name)) throw fail("ENOENT", "realpath", name, "no such file or directory");
  return name;
}

// Descriptors: a file's opening, or a directory's (which only `fsyncSync` and `closeSync` take, as Node's on POSIX).
interface Descriptor { readonly member: files.Member | undefined; readonly path: string; readonly read: boolean; readonly write: boolean; readonly append: boolean; position: number }
const descriptors = new Map<number, Descriptor>();
let nextDescriptor = 3;
function descriptor(fd: number, syscall: string): Descriptor & { readonly member: files.Member } {
  const open = descriptors.get(fd);
  if (open === undefined) throw fail("EBADF", syscall, fd, "bad file descriptor");
  if (open.member === undefined) throw fail("EISDIR", syscall, open.path, "illegal operation on a directory");
  return open as Descriptor & { readonly member: files.Member };
}

export function openSync(path: string | URL, flags: string | number = "r", _mode?: number): number {
  const name = pathOf(path, "open");
  if (typeof flags !== "string") throw fail("EINVAL", "open", name, "numeric flags are not supported here");
  const match = /^(r|w|a)(x)?(\+)?$/.exec(flags);
  if (match === null) throw fail("EINVAL", "open", name, `unsupported flags ${flags}`);
  const [, kind, exclusive, plus] = match;
  let member: files.Member | undefined;
  if (kind === "r") {
    member = files.lookup(name);
    if (member === undefined) {
      if (files.isDirectory(name) && plus === undefined) {
        const fd = nextDescriptor++;
        descriptors.set(fd, { member: undefined, path: name, read: true, write: false, append: false, position: 0 });
        return fd;
      }
      throw fail(files.isDirectory(name) ? "EISDIR" : "ENOENT", "open", name, files.isDirectory(name) ? "illegal operation on a directory" : "no such file or directory");
    }
  } else {
    member = files.create(name, exclusive === "x");
    if (kind === "w") files.truncate(member, 0);
  }
  files.opened(member);
  const fd = nextDescriptor++;
  descriptors.set(fd, { member, path: name, read: kind === "r" || plus !== undefined, write: kind !== "r" || plus !== undefined, append: kind === "a", position: 0 });
  return fd;
}

export function closeSync(fd: number): void {
  const open = descriptors.get(fd);
  if (open === undefined) throw fail("EBADF", "close", fd, "bad file descriptor");
  descriptors.delete(fd);
  if (open.member !== undefined) files.closed(open.member);
}

export function fstatSync(fd: number, options?: { readonly bigint?: boolean }): object {
  const open = descriptors.get(fd);
  if (open === undefined) throw fail("EBADF", "fstat", fd, "bad file descriptor");
  return stats(open.member, options?.bigint === true);
}

export function fsyncSync(fd: number): void {
  const open = descriptors.get(fd);
  if (open === undefined) throw fail("EBADF", "fsync", fd, "bad file descriptor");
  // A directory's entries are written with their headers, each flushed (files.ts).
  if (open.member !== undefined) files.flush(open.member);
}
export const fdatasyncSync = fsyncSync;

/** `readSync(fd, buffer, offset, length, position)`, or with `{ offset, length, position }`. */
export function readSync(fd: number, buffer: ArrayBufferView, offsetOrOptions?: number | { offset?: number; length?: number; position?: number | bigint | null },
  length?: number, position?: number | bigint | null): number {
  const open = descriptor(fd, "read");
  if (!open.read) throw fail("EBADF", "read", fd, "bad file descriptor");
  let offset = 0;
  if (typeof offsetOrOptions === "object" && offsetOrOptions !== null) ({ offset = 0, length, position } = offsetOrOptions);
  else if (typeof offsetOrOptions === "number") offset = offsetOrOptions;
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  length ??= bytes.length - offset;
  if (offset < 0 || length < 0 || offset + length > bytes.length) throw Object.assign(new RangeError("The value of \"length\" is out of range."), { code: "ERR_OUT_OF_RANGE" });
  const at = position === undefined || position === null || position === -1 ? open.position : Number(position);
  const got = files.read(open.member, bytes.subarray(offset, offset + length), at);
  if (position === undefined || position === null || position === -1) open.position += got;
  return got;
}

/** `writeSync(fd, buffer, offset?, length?, position?)` or `writeSync(fd, string, position?, encoding?)`. */
export function writeSync(fd: number, data: string | ArrayBufferView, offsetOrPosition?: number | null, lengthOrEncoding?: number | BufferEncoding,
  position?: number | null): number {
  const open = descriptor(fd, "write");
  if (!open.write) throw fail("EBADF", "write", fd, "bad file descriptor");
  let bytes: Uint8Array, at: number | null | undefined;
  if (typeof data === "string") { bytes = bytesOf(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8"); at = offsetOrPosition; }
  else {
    const all = bytesOf(data), offset = offsetOrPosition ?? 0, length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : all.length - offset;
    bytes = all.subarray(offset, offset + length); at = position;
  }
  const where = open.append ? files.size(open.member) : at === undefined || at === null ? open.position : at;
  const wrote = files.write(open.member, bytes, where);
  if (open.append || at === undefined || at === null) open.position = where + wrote;
  return wrote;
}

export function ftruncateSync(fd: number, length = 0): void { files.truncate(descriptor(fd, "ftruncate").member, length); }
export function truncateSync(path: string | URL, length = 0): void { files.truncate(existing(pathOf(path, "open"), "open"), length); }

export function renameSync(from: string | URL, to: string | URL): void { files.rename(pathOf(from, "rename"), pathOf(to, "rename")); }
export function linkSync(from: string | URL, to: string | URL): void { files.link(pathOf(from, "link"), pathOf(to, "link")); }
export function unlinkSync(path: string | URL): void { files.unlink(pathOf(path, "unlink")); }

export function copyFileSync(from: string | URL, to: string | URL, mode = 0): void {
  const source = contents(existing(pathOf(from, "copyfile"), "copyfile")), target = pathOf(to, "copyfile");
  // COPYFILE_EXCL (1): refused where the target exists.
  writeFileSync(target, source, { flag: (mode & 1) !== 0 ? "wx" : "w" });
}

export function rmSync(path: string | URL, options?: { readonly force?: boolean; readonly recursive?: boolean; readonly maxRetries?: number; readonly retryDelay?: number }): void {
  const name = pathOf(path, "rm");
  if (files.lookup(name) !== undefined) { files.unlink(name, "rm"); return; }
  if (files.isDirectory(name)) {
    if (options?.recursive !== true) throw systemError("ERR_FS_EISDIR", -21, "rm", name, "Path is a directory");
    files.rmdir(name, true);
    return;
  }
  if (options?.force !== true) throw fail("ENOENT", "rm", name, "no such file or directory");
}
export function rmdirSync(path: string | URL, options?: { readonly recursive?: boolean }): void { files.rmdir(pathOf(path, "rmdir"), options?.recursive === true); }

export function mkdirSync(path: string | URL, options?: number | { readonly recursive?: boolean; readonly mode?: number }): string | undefined {
  const name = pathOf(path, "mkdir"), recursive = typeof options === "object" && options?.recursive === true;
  const existed = files.isDirectory(name);
  files.mkdir(name, recursive);
  return recursive && !existed ? name : undefined;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function mkdtempSync(prefix: string): string {
  mountedFor("mkdtemp", prefix);
  for (;;) {
    const name = prefix + Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => ALPHABET[byte % ALPHABET.length]).join("");
    if (existsSync(name)) continue;
    if (!files.isDirectory(dirname(normal(name)))) throw fail("ENOENT", "mkdtemp", name, "no such file or directory");
    files.mkdir(name, false);
    return name;
  }
}

export function readdirSync(path: string | URL, options?: Encoding | { readonly withFileTypes?: boolean }): string[] | object[] {
  const name = pathOf(path, "scandir"), entries = files.list(name);
  if (typeof options === "object" && options !== null && "withFileTypes" in options && options.withFileTypes === true) {
    return entries.map(entry => {
      const directory = files.isDirectory(`${name}/${entry}`);
      return { name: entry, parentPath: name, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
    });
  }
  return entries;
}

export const constants = Object.freeze({ COPYFILE_EXCL: 1, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });

export default {
  readFileSync, writeFileSync, existsSync, statSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, fsyncSync,
  fdatasyncSync, readSync, writeSync, ftruncateSync, truncateSync, renameSync, linkSync, unlinkSync, copyFileSync, rmSync,
  rmdirSync, mkdirSync, mkdtempSync, readdirSync, constants,
};
