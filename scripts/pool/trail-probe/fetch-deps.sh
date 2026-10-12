#!/bin/sh
# The Ed25519 circuit's Noir libraries at the commits measured, under scratch/trail-probe/deps with path dependencies.
set -e
D="$(cd "$(dirname "$0")/../../.." && pwd)/scratch/trail-probe/deps"
mkdir -p "$D"
get() { [ -d "$D/$1" ] || git clone -q "$2" "$D/$1"; git -C "$D/$1" checkout -q "$3"; }
get noir-ed25519 https://github.com/willemolding/noir-ed25519 f9e0b44e39284d771f374eafc080adaa0d47babc
get noir-edwards-bignum https://github.com/willemolding/noir-edwards-bignum 0d706fba1236869d756fcd7ab2064df2f06f992b
get bignum https://github.com/noir-lang/noir-bignum 00d4360fbaaae71b1ee7f93f78dfad4eb7e11479
get sha512 https://github.com/zkpassport/sha512 e92ffb473f3264529a0793770f63a09946df50cc
get poseidon https://github.com/noir-lang/poseidon 0880c371e88e583d39515fd3f877538657ac41eb
sed -i "s|^poseidon = .*|poseidon = { path = \"$D/poseidon\" }|" "$D/bignum/Nargo.toml"
sed -i "s|^bignum = .*|bignum = { path = \"$D/bignum\" }|" "$D/noir-edwards-bignum/Nargo.toml" "$D/noir-ed25519/Nargo.toml"
sed -i "s|^edwards_bignum = .*|edwards_bignum = { path = \"$D/noir-edwards-bignum\" }|; s|^sha512 = .*|sha512 = { path = \"$D/sha512\" }|" "$D/noir-ed25519/Nargo.toml"
