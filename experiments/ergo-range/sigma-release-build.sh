#!/usr/bin/env bash
# Reproduce the vendored decoder package, vendor/ergo-lib-wasm-nodejs: a release build of sigma-rust 2f840d3's
# ergo-lib-wasm for Node. Upstream's npm alphas are built with `wasm-pack build --dev` (its build-nodejs-alpha script);
# this is the same source with the release profile. It first checks the committed vendor files against
# vendor/ergo-lib-wasm-nodejs/SHA256SUMS, then fetches the source at the pinned commit into an ignored directory,
# builds with the vendored lockfile (upstream commits none; core2 0.4.0 is yanked, so a fresh resolution fails) and
# paths remapped, generates the Node glue with wasm-bindgen 0.2.128 and compares every built file with SHA256SUMS.
#
# Host: the vendored bytes were built on Windows (x86_64-pc-windows-gnu host). Panic locations keep the host's path
# separators after remapping, so only a Windows build can reproduce them; reproduced there from two directories and a
# fresh checkout on 2026-09-23, and independently by review. A build on another host is expected to differ.
#
# Requires git, rustup with toolchain 1.87 and target wasm32-unknown-unknown (cargo on PATH), and the wasm-bindgen
# CLI 0.2.128 release binary, passed as WASM_BINDGEN (GitHub asset wasm-bindgen-0.2.128-x86_64-pc-windows-msvc.tar.gz,
# SHA-256 8fd8e2165da16b21ee3f5efd19e7f97d8d27cb7832f54edaef4b18e830283ec0). About 8–13 minutes.
# Usage, from the repository root:
#   WASM_BINDGEN=<path to wasm-bindgen 0.2.128> bash experiments/ergo-range/sigma-release-build.sh [build dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="${1:-$here/../../scratch/sigma-release-build}"
commit=2f840d3872367d6181d66d4a168194dbefad77f1
vendor="$here/vendor/ergo-lib-wasm-nodejs"
: "${WASM_BINDGEN:?set WASM_BINDGEN to the wasm-bindgen 0.2.128 CLI}"
"$WASM_BINDGEN" --version | grep -qx 'wasm-bindgen 0.2.128' || { echo "wasm-bindgen must be 0.2.128" >&2; exit 1; }
[ "$(rustc +1.87 --version | cut -d' ' -f2)" = 1.87.0 ] || { echo "rustc 1.87.0 required" >&2; exit 1; }
(cd "$vendor" && sha256sum -c SHA256SUMS) || { echo "the committed vendor files differ from SHA256SUMS" >&2; exit 1; }

rm -rf "$build"; mkdir -p "$build/src"; build="$(cd "$build" && pwd)"
git -C "$build/src" -c core.autocrlf=false init -q
git -C "$build/src" -c core.autocrlf=false fetch -q --depth 1 https://github.com/ergoplatform/sigma-rust.git "$commit"
git -C "$build/src" -c core.autocrlf=false checkout -q FETCH_HEAD
cp "$here/vendor/sigma-rust-2f840d3.Cargo.lock" "$build/src/Cargo.lock"

native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
cargo_home="${CARGO_HOME:-$HOME/.cargo}" rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
# Flags separated by 0x1f, so a path with a space stays one flag.
sep=$'\x1f'
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$(native "$build/src")=/sigma-rust${sep}--remap-path-prefix=$(native "$cargo_home")=/cargo${sep}--remap-path-prefix=$(native "$rustup_home")=/rustup"
unset RUSTFLAGS
(cd "$build/src" && cargo +1.87 build -p ergo-lib-wasm --lib --release --target wasm32-unknown-unknown --locked)
"$WASM_BINDGEN" --target nodejs --weak-refs --out-dir "$build/pkg" "$build/src/target/wasm32-unknown-unknown/release/ergo_lib_wasm.wasm"
(cd "$build/pkg" && sha256sum -c "$vendor/SHA256SUMS") && echo "reproduced: every vendored file matches"
