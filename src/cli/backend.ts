// A command's verifier (slice 10 M10b, item 10): built from the package's
// shipped relations over the parameters cached in its own directory, never
// taken from outside. A verify-only command destroys the key-deriving
// instance once the verifier is built; nothing here loads `@noir-lang`.
import type { Barretenberg } from "@aztec/bb.js";
import { openV3Verifier } from "../pool/v3/verifier.js";
import { startBackend, type ProofVerifier } from "../pool/proof-verifier.js";
import { readParameters } from "../pool/parameter-files.js";
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
