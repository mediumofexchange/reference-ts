// node:fs in a browser engine (slice 39), for the browser bundle (scripts/browser/build.mjs substitutes this module
// for node:fs). The browser host keeps no files (slice 39's stop), so:
// - `readFileSync` reads the package's own assets beside the bundle (the compiled relations and the check set,
//   which `programs.ts` and `check-set.ts` read by URL beside their module) by a synchronous request, which a
//   worker may make; its answer is checked by the reader of the asset exactly as a file's would be;
// - `existsSync` answers false: no file exists here;
// - every other call fails as a system call does where the system has none (ENOSYS, naming the call), so a store
//   that would keep a file fails visibly, as a failure of the system and never as damage to discard
//   (replay-store.ts `systemFailure`).

interface SyncRequest {
  open(method: string, url: string, async: false): void;
  overrideMimeType(type: string): void;
  send(): void;
  readonly status: number;
  readonly responseText: string;
}
declare const XMLHttpRequest: { new(): SyncRequest } | undefined;

function absent(syscall: string, path: unknown): Error {
  return Object.assign(new Error(`ENOSYS: a browser host keeps no files, ${syscall} '${String(path)}'`),
    { code: "ENOSYS", errno: -38, syscall, path: String(path) });
}
const asset = (path: unknown): URL | undefined => {
  const url = path instanceof URL ? path : typeof path === "string" && /^https?:\/\//.test(path) ? new URL(path) : undefined;
  return url !== undefined && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
};

export function readFileSync(path: string | URL, options?: string | { readonly encoding?: string | null }): string | Buffer {
  const url = asset(path);
  if (url === undefined || typeof XMLHttpRequest === "undefined") throw absent("open", path);
  const encoding = typeof options === "string" ? options : options?.encoding ?? undefined;
  const request = new XMLHttpRequest();
  request.open("GET", url.href, false);
  // Bytes as they were sent: a byte-per-character answer, read back below.
  if (encoding !== "utf8" && encoding !== "utf-8") request.overrideMimeType("text/plain; charset=x-user-defined");
  request.send();
  if (request.status !== 200) {
    throw Object.assign(new Error(`ENOENT: no such asset, open '${url.href}' (${request.status})`), { code: "ENOENT", errno: -2, syscall: "open", path: url.href });
  }
  if (encoding === "utf8" || encoding === "utf-8") return request.responseText;
  const text = request.responseText, bytes = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return encoding === undefined || encoding === null ? bytes : bytes.toString(encoding as BufferEncoding);
}

export const existsSync = (_path: unknown): boolean => false;
const refused = (syscall: string) => (path?: unknown): never => { throw absent(syscall, path); };
export const closeSync = refused("close");
export const fstatSync = refused("fstat");
export const fsyncSync = refused("fsync");
export const linkSync = refused("link");
export const lstatSync = refused("lstat");
export const mkdirSync = refused("mkdir");
export const openSync = refused("open");
export const readSync = refused("read");
export const readdirSync = refused("scandir");
export const realpathSync = refused("realpath");
export const renameSync = refused("rename");
export const rmSync = refused("rm");
export const statSync = refused("stat");
export const writeFileSync = refused("open");
export const writeSync = refused("write");

export default {
  readFileSync, existsSync, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
};
