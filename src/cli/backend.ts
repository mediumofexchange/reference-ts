// A command's verifier (slice 10 M10b, item 10): built from the package's
// shipped relations over the parameters cached in its own directory, never
// taken from outside. A verify-only command destroys the key-deriving
// instance once the verifier is built; nothing here loads `@noir-lang`.
import type { Barretenberg } from "@aztec/bb.js";
import { openV3Verifier } from "../pool/v3/verifier.js";
import { openTrailCheckSet, type TrailCheckSet } from "../pool/v3/check-set.js";
import { availableParallelism } from "node:os";
import { startBackend, startCheckSetBackend, type ProofVerifier } from "../pool/proof-verifier.js";
import { CHECK_SET_FILES, copyParameters, prepareCheckSetParameters, readCheckSetParameters, readParameters } from "../pool/parameter-files.js";
import type { TrailProver } from "../pool/v3/aggregator.js";
import { CommandError, flag, integer, type Arguments, type Directory } from "./common.js";

/** `--verifiers n`: the verifier's instance count, default 2, at most 6 (about 85 MB each). */
export function verifierCount(args: Arguments): number {
  const value = flag(args, "verifiers");
  return value === undefined ? 2 : Number(integer(value, "--verifiers", 1n, 6n));
}

/** The directory's verifier, or none where its construction carries no proofs (lit, M14g4): such a directory keeps
 * no parameters. */
export async function directoryVerifier(directory: Directory, args: Arguments): Promise<ProofVerifier | undefined> {
  return directory.construction.reader.proofs ? openVerifier(directory, verifierCount(args)) : undefined;
}

/** A backend instance started from the directory's cached parameters, the verifier's and the prover's alike: files that
 * are missing refuse `PARAMETERS`, files that are not the manifest's `ParameterError`. The caller owns the instance. */
export async function directoryBackend(directory: Pick<Directory, "path">): Promise<Barretenberg> {
  let parameters;
  try { parameters = await readParameters(directory.path); } catch (error) {
    if (error instanceof Error && /^No proving parameters/.test(error.message)) {
      throw new CommandError("PARAMETERS", "the directory's proving parameter files are missing; copy them back from --parameters' source");
    }
    throw error;
  }
  return startBackend(parameters);
}

export async function openVerifier(directory: Directory, instances: number): Promise<ProofVerifier> {
  const api = await directoryBackend(directory);
  try { return await openV3Verifier(api, { instances }); } finally { await api.destroy(); }
}

/** The shipped trail check set a succinct directory reads covers under (succinct-read §§2, 6; slice 38): its pinned keys
 * on one verifier instance of its own over the directory's cached parameters, which verifying a cover reads no more of.
 * It is a test set until an adoption names one, and every read says so. */
export async function openCheckSet(directory: Directory): Promise<TrailCheckSet> {
  const api = await directoryBackend(directory);
  try { return openTrailCheckSet(api); } finally { await api.destroy(); }
}

/** The aggregator a replica proves covers with (succinct-read §§3.2, 3.5; slice 38), checking each statement proof with
 * `statements` first: on its own instance started from the check set's parameters (the leading 2^21 points, 128 MiB),
 * copied from `from` or fetched into the directory where missing. Loaded by dynamic import, so only a proving process
 * loads `@noir-lang`. The caller closes it. */
export async function openCoverProver(directory: Pick<Directory, "path">, statements: ProofVerifier, from: string | undefined,
  log: (line: string) => void): Promise<{ readonly prover: TrailProver; close(): Promise<void> }> {
  try {
    if (from !== undefined) await copyParameters(from, directory.path, CHECK_SET_FILES);
    else await prepareCheckSetParameters(directory.path, { log });
  } catch (error) {
    if (error instanceof Error && /^No verified /.test(error.message)) throw new CommandError("PARAMETERS", error.message);
    throw error;
  }
  const api = await startCheckSetBackend(await readCheckSetParameters(directory.path), { threads: availableParallelism() });
  try {
    const { openTrailProver } = await import("../pool/v3/aggregator.js");
    const prover = await openTrailProver(api, statements);
    return { prover, async close() { await prover.close(); await api.destroy(); } };
  } catch (error) { await api.destroy(); throw error; }
}
