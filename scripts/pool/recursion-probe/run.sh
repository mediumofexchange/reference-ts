#!/bin/bash
# The recursion probe (slice 43 adoption, succinct-read §2 rule 2 and §6): bb 5.2.0's recursive Ultra-ZK Honk
# verifier, the one Noir's HONK_ZK recursion builds, against (1) an inner proof whose KZG quotient W is chosen so the
# inner opening's P0 is the point at infinity, with the honest proof and a moved W as controls, and (2) a malicious
# prover's witnesses (bb's native assertions set to warn) for limbs, aliased and off-curve coordinates and a key hash.
# Builds bb's stdlib_honk_verifier_tests at the pinned tag with probe.test.cpp added (about 15 minutes on 4 cores;
# clang 18, cmake, ninja) and runs it; the CRS is fetched from Aztec's host. Output as in result.log.
# Usage: bash scripts/pool/recursion-probe/run.sh <empty work directory>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${1:?a work directory}
git clone -q --depth 1 --branch v5.2.0 --filter=blob:none --sparse https://github.com/AztecProtocol/aztec-packages.git "$work/bb"
git -C "$work/bb" sparse-checkout set barretenberg/cpp
cpp="$work/bb/barretenberg/cpp"
cp "$here/probe.test.cpp" "$cpp/src/barretenberg/stdlib/honk_verifier/moe_infinity_probe.test.cpp"
(cd "$cpp" && cmake --preset default -DAVM=OFF -DBB_LITE=ON > "$work/configure.log")
(cd "$cpp/build" && ninja stdlib_honk_verifier_tests > "$work/build.log")
"$cpp/build/bin/stdlib_honk_verifier_tests" --gtest_filter='MoeInfinityProbe.*' | grep -E 'MOE-PROBE|OK \]|FAILED'
