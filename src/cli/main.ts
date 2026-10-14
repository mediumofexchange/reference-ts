// One `moe` command over the roles a host holds (slice 41): `moe.ts` runs it over every role as a process; the browser
// bundle's command worker over the wallet alone (src/browser/command.ts).
import { print, refusalOf, Replayed, UsageError } from "./common.js";

const USAGE = `usage: moe <role> <command> --dir <directory> ...
roles: wallet (init, seed --show, restore-seed, handoff, restore, terms add|show, service add, replica add|remove, request, pay, freshen,
              move-window, reprove, submit, status, sync, fulfill, fulfillment, demand, withdraw, settle, presentation, publish;
              with --backer at init: venue create, terms create, issue, accept, burn, publish-acceptance)
       operator (init, venue create, open, serve, return, adopt, restore, prepare: a new version's kept reads beside serve)
       reader (init, terms add|show, service add, replica add|remove, supply, presentation, serve)
       relay (init, publish, serve, send)
       venue (audit: any role's directory, after a restore or a copy, before any other command)
init --construction moe/pool/v3 (the default) or moe/lit/v1 (wallet, operator, reader) names the one construction a directory serves.
init, restore-seed and restore --read succinct (pool-v3 wallet, reader) read trails succinctly, from covers replicas prove (test set).
reader serve --prove [--parameters <dir>] proves covers over the replica's kept trails each round.
A rerun of init, restore or restore-seed over the directory it finished prints what it printed, with replay: true.
serve --onion <v3 host> [--holder-port <p>] adds a holders' listener for a Tor onion service and writes holders.json; a holder
reaches an onion URL only with NODE_USE_ENV_PROXY=1 and HTTP_PROXY naming a loopback HTTP CONNECT proxy (Tor's HTTPTunnelPort).
relay serve [--onion <v3 host>] serves a relay to holders and writes relay.json; relay send <file> --to <relay.json> hands it a file.`;

/** A role's commands, loaded on demand so a process loads only its own role's modules. */
export type Roles = Readonly<Record<string, () => Promise<(argv: readonly string[]) => Promise<void>>>>;

/**
 * Run one command: its role's `argv`, over the roles this host holds. Returns the exit code: 0 done (its JSON object
 * printed), 1 a refusal (`{ code, check, message }` on stderr), 2 a usage error, 3 anything else (its stack alone on
 * stderr), 4 a replay of an answer already given (printed as the answer was).
 */
export async function run(argv: readonly string[], roles: Roles): Promise<number> {
  // stdout carries the command's one JSON object: what a library logs (bb.js reports each proof it makes, acvm_js's
  // debug level writes through console.debug) goes to stderr.
  console.log = console.info = console.debug = (...parts: unknown[]) => console.error(...parts);
  const [role, ...rest] = argv;
  try {
    const load = role === undefined || !Object.hasOwn(roles, role) ? undefined : roles[role];
    if (load === undefined) throw new UsageError(USAGE);
    await (await load())(rest);
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
