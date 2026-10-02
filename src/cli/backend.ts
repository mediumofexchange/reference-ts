// A command's verifier (slice 10 M10b, item 10): built from the package's
// shipped relations over the parameters cached in its own directory, never
// taken from outside. A verify-only command destroys the key-deriving
// instance once the verifier is built; nothing here loads `@noir-lang`.
import { openV3Verifier } from "../pool/v3/verifier.js";
import { startBackend, type ProofVerifier } from "../pool/proof-verifier.js";
import { readParameters } from "../pool/parameter-files.js";
import { flag, integer, type Arguments, type Directory } from "./common.js";

/** `--verifiers n`: the verifier's instance count, default 2, at most 6 (about 85 MB each). */
export function verifierCount(args: Arguments): number {
  const value = flag(args, "verifiers");
  return value === undefined ? 2 : Number(integer(value, "--verifiers", 1n, 6n));
}

export async function openVerifier(directory: Directory, instances: number): Promise<ProofVerifier> {
  const api = await startBackend(await readParameters(directory.path));
  try { return await openV3Verifier(api, { instances }); } finally { await api.destroy(); }
}
