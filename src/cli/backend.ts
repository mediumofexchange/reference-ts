// A command's verifier (slice 10 M10b, item 10): built from the package's
// shipped relations over the parameters cached in its own directory, never
// taken from outside. A verify-only command destroys the key-deriving
// instance once the verifier is built; nothing here loads `@noir-lang`.
import type { Barretenberg } from "@aztec/bb.js";
import { openV3Verifier } from "../pool/v3/verifier.js";
import type { TrailCheckSet } from "../pool/v3/check-set.js";
import { availableParallelism } from "node:os";
import { nativeRefusal, ParameterError, startBackend, type ProofVerifier } from "../pool/proof-verifier.js";
import { CHECK_SET_FILES, copyParameters, prepareCheckSetParameters, readCheckSetParameters, readParameters } from "../pool/parameter-files.js";
import type { TrailProver } from "../pool/v3/aggregator.js";
import type { FoldInputs } from "../ergo-exhaustion.js";
import type { ServerPeriod } from "../ergo-exhaustion-server.js";
import { shippedCheckSet, type SetStart } from "../succinct-set.js";
import { CommandError, flag, integer, UsageError, type Arguments, type Directory } from "./common.js";

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
export async function openCheckSet(directory: Directory, start: SetStart): Promise<TrailCheckSet> {
  const api = await directoryBackend(directory);
  try { return shippedCheckSet(api, start); } finally { await api.destroy(); }
}

/** `--prover native|wasm`: whether covers are proved on the native binary bb.js bundles or on WebAssembly (slice 42).
 * The default is native where the host has it (Linux and macOS on x64 and arm64), WebAssembly elsewhere; native asked
 * for where the host has none refuses `PROVER` with the reason. */
export function proverBackend(args: Arguments): boolean {
  const value = flag(args, "prover"), refusal = nativeRefusal();
  if (value === undefined) return refusal === undefined;
  if (value === "wasm") return false;
  if (value !== "native") throw new UsageError("--prover is native or wasm");
  if (refusal !== undefined) throw new CommandError("PROVER", `${refusal}; prove with --prover wasm`);
  return true;
}

/** The aggregator a replica proves covers with (succinct-read §§3.2, 3.5; slices 38, 42), checking each statement proof
 * with `statements` first: on its own instance, native or WebAssembly, started from the check set's parameters (the
 * leading 2^21 points, 128 MiB), copied from `from` or fetched into the directory where missing, and read from there
 * again at each start. Loaded by dynamic import, so only a proving process loads `@noir-lang`. The caller closes it. */
export async function openCoverProver(directory: Pick<Directory, "path">, start: SetStart, statements: ProofVerifier, from: string | undefined,
  native: boolean, log: (line: string) => void): Promise<{ readonly prover: TrailProver; close(): Promise<void> }> {
  try {
    if (from !== undefined) await copyParameters(from, directory.path, CHECK_SET_FILES);
    else await prepareCheckSetParameters(directory.path, { log });
  } catch (error) {
    if (error instanceof Error && /^No verified /.test(error.message)) throw new CommandError("PARAMETERS", error.message);
    throw error;
  }
  const { openTrailProver } = await import("../pool/v3/aggregator.js");
  try {
    const prover = await openTrailProver(() => readCheckSetParameters(directory.path), statements, start, { native, threads: availableParallelism() });
    return { prover, close: () => prover.close() };
  } catch (error) {
    // A native binary that would not start (a parameter fault stays its own): by name, with the way round it.
    if (native && error instanceof Error && !(error instanceof ParameterError)) {
      throw new CommandError("PROVER", `proving on the native backend could not begin (${error.message.split("\n")[0]}); prove with --prover wasm`);
    }
    throw error;
  }
}

/** What proves a replica's periods (`openExhaustionProver`). */
export interface ExhaustionProver {
  fold(first: boolean, inputs: FoldInputs, period: ServerPeriod): Promise<Uint8Array>;
  /** Forget the proofs kept for periods already folded. */
  folded(): void;
  close(): Promise<void>;
}
