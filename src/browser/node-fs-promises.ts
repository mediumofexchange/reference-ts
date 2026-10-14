// node:fs/promises in a browser engine (slice 41), for the browser bundle: node:fs's calls over the worker's file pool
// (node-fs.ts), each answered as a settled promise, as far as the library uses them (parameter-files.ts caching the
// proving parameters at a directory's init). The pool's calls are synchronous, so nothing here waits on another.
import * as fs from "./node-fs.js";

const settled = <T>(call: () => T): Promise<T> => { try { return Promise.resolve(call()); } catch (error) { return Promise.reject(error); } };

/** A file opened by `open`, over its descriptor. */
export interface FileHandle {
  readonly fd: number;
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | bigint | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export function open(path: string | URL, flags: string | number = "r", mode?: number): Promise<FileHandle> {
  return settled(() => {
    const fd = fs.openSync(path, flags, mode);
    let closed = false;
    return {
      fd,
      read: (buffer, offset = 0, length = buffer.byteLength - offset, position = null) =>
        settled(() => ({ bytesRead: fs.readSync(fd, buffer, offset, length, position), buffer })),
      write: (buffer, offset = 0, length = buffer.byteLength - offset, position = null) =>
        settled(() => ({ bytesWritten: fs.writeSync(fd, buffer, offset, length, position), buffer })),
      sync: () => settled(() => fs.fsyncSync(fd)),
      close: () => settled(() => { if (!closed) { closed = true; fs.closeSync(fd); } }),
    };
  });
}
export const mkdir = (path: string | URL, options?: number | { readonly recursive?: boolean; readonly mode?: number }) => settled(() => fs.mkdirSync(path, options));
export const readFile = (path: string | URL, options?: Parameters<typeof fs.readFileSync>[1]) => settled(() => fs.readFileSync(path, options));
export const writeFile = (path: string | URL, data: string | ArrayBufferView, options?: Parameters<typeof fs.writeFileSync>[2]) =>
  settled(() => fs.writeFileSync(path, data, options));
export const rename = (from: string | URL, to: string | URL) => settled(() => fs.renameSync(from, to));
export const rm = (path: string | URL, options?: Parameters<typeof fs.rmSync>[1]) => settled(() => fs.rmSync(path, options));
export const unlink = (path: string | URL) => settled(() => fs.unlinkSync(path));

export default { open, mkdir, readFile, writeFile, rename, rm, unlink };
