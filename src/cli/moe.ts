#!/usr/bin/env node
// `moe`: one executable over role directories (slice 10 M10b). Each
// invocation is one process that does one operation and exits, except
// `moe operator serve`. A command prints one JSON object on stdout (`serve`
// one once listening and one once stopped, its events on stderr). A refusal
// prints `{ code, check, message }` on stderr and exits 1; a usage error
// exits 2; anything else exits 3 with its stack alone, as unexpected failures
// stay visible. Role modules load on demand, so a reader process loads no
// prover.
import { print, refusalOf, Replayed, UsageError } from "./common.js";

const USAGE = `usage: moe <role> <command> --dir <directory> ...
roles: wallet (init, seed --show, restore-seed, handoff, restore, terms add|show, service add, request, pay, freshen,
              move-window, reprove, submit, status, sync, fulfill, fulfillment, demand, withdraw, settle, presentation, publish;
              with --backer at init: venue create, terms create, issue, accept, burn, publish-acceptance)
       operator (init, venue create, open, serve, return, adopt, restore, prepare: a new version's kept reads beside serve)
       reader (init, terms add|show, service add, supply, presentation)
       relay (init, publish, serve, send)
       venue (audit: any role's directory, after a restore or a copy, before any other command)
init --construction moe/pool/v3 (the default) or moe/lit/v1 (wallet, operator, reader) names the one construction a directory serves.
serve --onion <v3 host> [--holder-port <p>] adds a holders' listener for a Tor onion service and writes holders.json; a holder
reaches an onion URL only with NODE_USE_ENV_PROXY=1 and HTTP_PROXY naming a loopback HTTP CONNECT proxy (Tor's HTTPTunnelPort).
relay serve [--onion <v3 host>] serves a relay to holders and writes relay.json; relay send <file> --to <relay.json> hands it a file.`;

export async function main(argv: readonly string[]): Promise<number> {
  // stdout carries the command's one JSON object: what a library logs (bb.js reports each proof it makes, acvm_js's
  // debug level writes through console.debug) goes to stderr.
  console.log = console.info = console.debug = (...parts: unknown[]) => console.error(...parts);
  const [role, ...rest] = argv;
  try {
    if (role === "reader") await (await import("./reader.js")).reader(rest);
    else if (role === "operator") await (await import("./operator.js")).operator(rest);
    else if (role === "wallet") await (await import("./wallet.js")).wallet(rest);
    else if (role === "relay") await (await import("./relay.js")).relay(rest);
    else if (role === "venue") await (await import("./venue.js")).venueAudit(rest);
    else throw new UsageError(USAGE);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`${error.message}\n`); return 2; }
    if (error instanceof Replayed) { print(error.value); return 4; }
    const refused = await refusalOf(error).catch(() => undefined);
    if (refused !== undefined) { process.stderr.write(`${JSON.stringify(refused)}\n`); return 1; }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 3;
  }
}

process.exitCode = await main(process.argv.slice(2));
// Worker threads a backend left behind must not hold the process open past its answer, once it is written out.
process.stdout.write("", () => process.stderr.write("", () => process.exit()));
