#!/usr/bin/env node
// `moe`: one executable over role directories (slice 10 M10b). Each
// invocation is one process that does one operation and exits, except
// `moe operator serve`. A command prints one JSON object on stdout (`serve`
// one once listening and one once stopped, its events on stderr). A refusal
// prints `{ code, check, message }` on stderr and exits 1; a usage error
// exits 2; anything else exits 3 with its stack alone, as unexpected failures
// stay visible. Role modules load on demand, so a reader process loads no
// prover.
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2), {
  reader: async () => (await import("./reader.js")).reader,
  operator: async () => (await import("./operator.js")).operator,
  wallet: async () => (await import("./wallet.js")).wallet,
  relay: async () => (await import("./relay.js")).relay,
  venue: async () => (await import("./venue.js")).venueAudit,
});
// Worker threads a backend left behind must not hold the process open past its answer, once it is written out.
process.stdout.write("", () => process.stderr.write("", () => process.exit()));
