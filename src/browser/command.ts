// One `moe wallet` command in a browser engine's worker (slice 41): what the command bundle (scripts/browser/build.mjs
// `command.js`) holds. The command is the Node path's own (src/cli/wallet.ts through main.ts `run`), over the worker's
// file pool (files.ts, slice 40) for its directory, node:fs and SQLite, and the browser's `fetch` for the venue's nodes
// and the operator's service; its output is collected as a process's would be.
//
// A command is a process here as under Node: one command a worker, whose end (the host terminates it once the result
// is posted) releases what the command held, its directory lock among them (common.ts holds it until the process
// exits), as the operating system does at a process's exit. The pool admits one worker at a time, so a second command
// on a pool another worker holds (a second tab) is refused BUSY, as a second process on a held directory is.
//
// What a command reads that a holder hands it (a venue file, a service file, a request frame) the host writes into the
// pool first (`files`); what it writes that the holder takes away (a request frame, a backup) the host reads back after
// it (`read`); what the holder should not leave in the pool (a key file handed in, an init that did not finish) the host
// removes after it (`remove`), as a holder removes a file under Node. The seed a restore takes comes on its stdin
// (`stdin`), which is zeroed once read; the page transfers its buffer, so no copy stays there.
import { moeProcess } from "./globals.js";
import { mountFiles } from "./files.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "./node-fs.js";
import { dirname } from "./node-path.js";
import { run } from "../cli/main.js";

export interface CommandRequest {
  /** `wallet <command> ...`, as `moe` takes it. */
  readonly argv: readonly string[];
  /** The OPFS directory holding the pool (files.ts `mountFiles`); default `moe-files`. */
  readonly pool?: string;
  /** Files written into the pool before the command, by absolute path (an existing one is replaced). */
  readonly files?: Readonly<Record<string, Uint8Array | string>>;
  /** Files read back from the pool after the command, by absolute path: their bytes, or null where there is none. */
  readonly read?: readonly string[];
  /** Paths removed from the pool after the command and its read-back (a file, or a directory with what it holds). */
  readonly remove?: readonly string[];
  /** The command's stdin (restore-seed's seed); none reads as an empty pipe. Zeroed once read. */
  readonly stdin?: Uint8Array;
}

export interface CommandResult {
  /** `moe`'s exit code: 0 done, 1 refused, 2 usage, 3 unexpected, 4 replayed. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: Readonly<Record<string, Uint8Array | null>>;
  /** Paths read back or removed that the pool refused, by the refusal's code: the command's own outcome stands. */
  readonly fileErrors: Readonly<Record<string, string>>;
  /** Whether the browser keeps the origin's storage under pressure (the mount's `navigator.storage.persist` answer). */
  readonly persisted: boolean | undefined;
}

let ran = false;

/** Run one wallet command in this worker; the host ends the worker after it. A second call is refused: a worker is
 * one process. */
export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  if (ran) throw new Error("a command worker runs one command; start a new worker for the next");
  ran = true;
  const stdout: string[] = [], stderr: string[] = [];
  const collect = (into: string[]) => ({
    write(text: string | Uint8Array, done?: () => void): boolean { into.push(typeof text === "string" ? text : new TextDecoder().decode(text)); done?.(); return true; },
  });
  moeProcess.stdout = collect(stdout);
  moeProcess.stderr = collect(stderr);
  moeProcess.stdin = pipe(request.stdin);
  const files: Record<string, Uint8Array | null> = {}, fileErrors: Record<string, string> = {};
  const result = (code: number, persisted?: boolean): CommandResult =>
    ({ code, stdout: stdout.join(""), stderr: stderr.join(""), files, fileErrors, persisted });
  let persisted: boolean | undefined;
  try {
    persisted = (await mountFiles(request.pool, { persist: true })).persisted;
  } catch (error) {
    // Another worker holds the pool: another tab's command, or one still running.
    if ((error as { code?: string }).code === "EBUSY") {
      stderr.push(`${JSON.stringify({ code: "BUSY", message: "another command or tab holds this wallet's files" })}\n`);
      return result(1);
    }
    stderr.push(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return result(3);
  }
  for (const [path, data] of Object.entries(request.files ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  const code = await run(request.argv, { wallet: async () => (await import("../cli/wallet.js")).wallet });
  // The command's outcome is final here: a path the pool refuses is reported beside it, never in its place.
  const refusal = (error: unknown): string => String((error as { code?: unknown }).code ?? "EIO");
  for (const path of request.read ?? []) {
    try { files[path] = new Uint8Array(readFileSync(path) as Buffer); } catch (error) {
      files[path] = null;
      if ((error as { code?: string }).code !== "ENOENT") fileErrors[path] = refusal(error);
    }
  }
  for (const path of request.remove ?? []) {
    try { rmSync(path, { recursive: true, force: true }); } catch (error) { fileErrors[path] = refusal(error); }
  }
  return result(code, persisted);
}

/** `input` as a pipe on stdin: one chunk, then its end; the caller's bytes are zeroed once taken. */
function pipe(input: Uint8Array | undefined): typeof moeProcess.stdin {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      if (input === undefined || input.length === 0) return;
      const chunk = Buffer.from(input);
      input.fill(0);
      yield chunk;
    },
  };
}

/** As a dedicated worker's module (wallet.html `moeCommand`): `{ ready: true }` once it listens, so the host's request
 * is never posted before, then one request message in and its result posted back, after which the worker ends itself,
 * as a process exits, so a host that kept it would not keep the pool (the host's `terminate` stays a backstop). */
const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; addEventListener?(type: "message", listener: (event: { data: CommandRequest }) => void): void;
  postMessage?(message: CommandResult): void; close?(): void };
if (scope.WorkerGlobalScope !== undefined && scope.addEventListener !== undefined) {
  scope.addEventListener("message", event => {
    runCommand(event.data).then(result => scope.postMessage!(result), (error: unknown) => scope.postMessage!({
      code: 3, stdout: "", stderr: `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, files: {}, fileErrors: {}, persisted: undefined }))
      .finally(() => scope.close?.());
  });
  (scope.postMessage as unknown as (message: { ready: true }) => void)({ ready: true });
}
