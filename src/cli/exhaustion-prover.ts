// A replica's exhaustion prover (succinct-read §4.3, slice 43; `reader serve --prove-exhaustion`), in a module of its own:
// only `reader serve` imports it, so no other command (nor the browser host's wallet) reaches the Node-only modules it
// loads.
import { readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { EXHAUSTION_SET_MANIFEST, ExhaustionSetError } from "../ergo-exhaustion-set.js";
import { nativeRefusal } from "../pool/proof-verifier.js";
import { copyParameters, EXHAUSTION_FILES, prepareExhaustionParameters, readExhaustionParameters } from "../pool/parameter-files.js";
import type { ExhaustionProver } from "./backend.js";
import { CommandError, type Directory } from "./common.js";

/** The prover a replica proves the venue's exhaustion with (succinct-read §4.3, slice 43; `--prove-exhaustion`): an
 * `ExhaustionPool` over the shipped circuits, their programs compiled once from the package's sources with `nargo` (the
 * pinned compiler: `--nargo`, default on the path) into `exhaustion-circuits/` and run only where they are the manifest's,
 * proving on the native backend (WebAssembly's memory holds no leaf) from the leading 2^22 points (256 MiB), copied
 * from `from` or fetched into the directory where missing. Its proofs are kept in `exhaustion-proofs/` until their
 * period is folded, so a restart resumes a period. Loaded by dynamic import: only a proving process loads `@noir-lang`. */
export async function openExhaustionProver(directory: Pick<Directory, "path" | "file">, from: string | undefined, nargo: string,
  log: (line: string) => void): Promise<ExhaustionProver> {
  const refusal = nativeRefusal();
  if (refusal !== undefined) throw new CommandError("PROVER", `${refusal}: the exhaustion is proved on the native backend only`);
  try {
    if (from !== undefined) await copyParameters(from, directory.path, EXHAUSTION_FILES);
    else await prepareExhaustionParameters(directory.path, { log });
  } catch (error) {
    if (error instanceof Error && /^No verified /.test(error.message)) throw new CommandError("PARAMETERS", error.message);
    throw error;
  }
  const { exhaustionPrograms, ExhaustionCompileError } = await import("../ergo-exhaustion-programs.js");
  let circuits;
  try { circuits = exhaustionPrograms({ nargo, directory: directory.file("exhaustion-circuits"), log }); } catch (error) {
    if (error instanceof ExhaustionCompileError || (error instanceof ExhaustionSetError && error.code === "IDENTITY")) {
      throw new CommandError("PROVER", `${error.message}; give --nargo the path of ${EXHAUSTION_SET_MANIFEST.compiler.split("+")[0]}`);
    }
    throw error;
  }
  const { ExhaustionPool, nativeExhaustionBackend, proofDirectory } = await import("../ergo-exhaustion-pool.js");
  const backend = nativeExhaustionBackend(circuits, () => readExhaustionParameters(directory.path), { threads: availableParallelism() });
  const proofs = directory.file("exhaustion-proofs");
  const pool = new ExhaustionPool({ circuits, backend, proofs: proofDirectory(proofs), log });
  return {
    fold: (first, inputs, period) => pool.fold(first, inputs, period),
    folded() {
      for (const name of readdirSync(proofs)) rmSync(join(proofs, name), { force: true });
    },
    close: () => backend.close(),
  };
}
