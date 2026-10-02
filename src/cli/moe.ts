#!/usr/bin/env node
// `moe`: one executable over role directories (slice 10 M10b). Each
// invocation is one process that does one operation and exits, except
// `moe operator serve`. A command prints one JSON object on stdout. A refusal
// prints `{ code, check, message }` on stderr and exits 1; a usage error
// exits 2; anything else exits 3 with its stack alone, as unexpected failures
// stay visible. Role modules load on demand, so a reader process loads no
// prover.
import { EncodingError } from "../bytes.js";
import { VenueError } from "../venue-error.js";
import { CommandError, UsageError } from "./common.js";

const USAGE = `usage: moe <role> <command> --dir <directory> ...
roles: reader (init, terms add|show, service add, supply, presentation)
       operator (init, venue create, open, serve, return, adopt)`;

/** The fields a refusal prints, or undefined for an unexpected failure. */
async function refusal(error: unknown): Promise<{ code: string; check?: string; message: string } | undefined> {
  if (!(error instanceof Error)) return undefined;
  const [{ V3StoreError }, { V3ServiceClientError }, { ReferenceVenueError }, { ProgramError }, { ParameterError }, { EvidenceRefusal, ReplayRefusal }] =
    await Promise.all([import("../pool/v3/store.js"), import("../pool/v3/service-client.js"), import("../pool/v3/guard.js"),
      import("../pool/v3/programs.js"), import("../pool/proof-verifier.js"), import("../pool/v3/refusals.js")]);
  const coded = error as Error & { code?: string; check?: string };
  if (error instanceof CommandError || error instanceof V3StoreError || error instanceof ProgramError || error instanceof ParameterError) {
    return { code: coded.code!, ...(coded.check === undefined ? {} : { check: coded.check }), message: error.message };
  }
  if (error instanceof V3ServiceClientError) return { code: error.code, check: String(error.status), message: error.message };
  if (error instanceof ReplayRefusal) return { code: "REFUSED", check: error.check, message: error.message };
  if (error instanceof EvidenceRefusal) return { code: "UNRESOLVED", check: error.status, message: error.message };
  if (error instanceof ReferenceVenueError) return { code: "REFERENCE", message: error.message };
  if (error instanceof VenueError) return { code: "VENUE", message: error.message };
  if (error instanceof EncodingError) return { code: "INVALID", message: error.message };
  return undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [role, ...rest] = argv;
  try {
    if (role === "reader") await (await import("./reader.js")).reader(rest);
    else if (role === "operator") await (await import("./operator.js")).operator(rest);
    else throw new UsageError(USAGE);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`${error.message}\n`); return 2; }
    const refused = await refusal(error).catch(() => undefined);
    if (refused !== undefined) { process.stderr.write(`${JSON.stringify(refused)}\n`); return 1; }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 3;
  }
}

process.exitCode = await main(process.argv.slice(2));
// Worker threads a backend left behind must not hold the process open past its answer, once it is written out.
process.stdout.write("", () => process.stderr.write("", () => process.exit()));
