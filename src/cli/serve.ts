// What the three `serve` commands share (slice 12 M12a–c): the operator's service, a replica and a relay each listen on
// a loopback port, behind a v3 onion name Tor serves for it where `--onion` names one, poll until SIGTERM or SIGINT, and
// hand holders a file naming the listener's URL and its credential.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ONION_HOST } from "../pool/v3/service-client.js";
import { CommandError, flag, integer, pollMs, readOptional, readRequired, UsageError, writeExclusive, type Arguments, type Directory } from "./common.js";

/** The flags every `serve` takes beside `--dir`. */
export const SERVE_FLAGS = { port: "value", onion: "value", "poll-ms": "value" } as const;
/** A port flag: 0 (any free port) when absent. */
export const portOf = (args: Arguments, name: string): number => Number(integer(flag(args, name) ?? "0", `--${name}`, 0n, 65535n));
/** `--port`, `--onion` (a v3 onion host) and `--poll-ms`. */
export function serveFlags(args: Arguments): { port: number; onion: string | undefined; ms: number } {
  const port = portOf(args, "port"), ms = pollMs(args), onion = flag(args, "onion");
  if (onion !== undefined && !ONION_HOST.test(onion)) throw new UsageError("--onion takes a v3 onion host: 56 base32 characters and .onion");
  return { port, onion, ms };
}

/** Listen on 127.0.0.1 at `port` and answer the port listened on; a port in use is `UNAVAILABLE`, naming it. */
export async function listenLoopback(server: Server, port: number): Promise<number> {
  try {
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => { server.off("error", failed); done(); }); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CommandError("UNAVAILABLE", `port ${port} is in use`);
    throw error;
  }
  return (server.address() as AddressInfo).port;
}
/** Close a listener, listening or not, ending its open connections. */
export const closeListener = (server: Server): Promise<void> => new Promise(done => { server.closeAllConnections(); server.close(() => done()); });

/** Until SIGTERM or SIGINT, or the command's own `stop`: whether it is stopping, and a pause that either cuts short. */
export function untilStopped(): { stopping: () => boolean; stop: () => void; pause: (ms: number) => Promise<void> } {
  let stopping = false, wake: (() => void) | undefined;
  const stop = (): void => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { stopping: () => stopping, stop, pause: ms => stopping ? Promise.resolve() : new Promise<void>(done => { wake = done; setTimeout(done, ms); }) };
}

/** Work one at a time, in order: a failure is its caller's and the next still runs. */
export function serialized(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

/** A listener's credential kept in the directory as 64 hex digits; with `fresh`, made at the first run. */
export function tokenFile(directory: Directory, name: string, fresh?: () => Uint8Array): string {
  const path = directory.file(name);
  if (fresh !== undefined && readOptional(path) === undefined) writeExclusive(path, `${bytesToHex(fresh())}\n`);
  const text = new TextDecoder().decode(readRequired(path, name)).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CommandError("INVALID", `${name} is not 64 hex digits`);
  return text;
}

/** A loopback listener's URL, or a v3 onion service's, which a holder reaches only through its own loopback proxy. */
export const LISTENER_URL =/^http:\/\/(127\.0\.0\.1:[0-9]{1,5}|[a-z2-7]{55}d\.onion(:[0-9]{1,5})?)\/$/;
/** A file handed to holders (an operator's service file, a relay file): `{ url, <key> }`, the listener's URL and its one
 * credential, never per holder. */
export function listenerFile(value: unknown, key: "walletToken" | "token", what: string): { readonly url: string; readonly token: string } {
  const v = value as Record<string, unknown>;
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== ["url", key].sort().join() ||
      typeof v.url !== "string" || !LISTENER_URL.test(v.url) || typeof v[key] !== "string" || !/^[0-9a-f]{64}$/.test(v[key] as string)) {
    throw new CommandError("INVALID", `the ${what} file is not { url, ${key} } with a loopback or v3 onion URL`);
  }
  return { url: v.url, token: v[key] as string };
}
