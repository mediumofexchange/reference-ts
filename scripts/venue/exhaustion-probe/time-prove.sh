#!/bin/bash
# time-prove.sh <program.json> <witness.gz> <out dir> [target]: write_vk, then a timed prove with the vk (peak RSS sampled), then verify.
P=$1; W=$2; O=$3; TG=${4:-noir-recursive}; BB=$(dirname "$0")/../../../node_modules/@aztec/bb.js/build/amd64-linux/bb
mkdir -p $O/vk $O/proof
s=$(date +%s.%N); $BB write_vk -b $P -o $O/vk -t $TG >$O/vk.log 2>&1 || { echo write_vk failed; exit 1; }; v=$(echo "$(date +%s.%N) - $s" | bc)
s=$(date +%s.%N)
$BB prove -b $P -w $W -k $O/vk/vk -o $O/proof -t $TG >$O/prove.log 2>&1 & pid=$!
hwm=0; while kill -0 $pid 2>/dev/null; do x=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null); [ -n "$x" ] && hwm=$x; read -t 0.5 < /dev/zero 2>/dev/null || true; done
wait $pid; rc=$?
e=$(date +%s.%N)
$BB verify -p $O/proof/proof -k $O/vk/vk -i $O/proof/public_inputs -t $TG >$O/verify.log 2>&1 && ok=true || ok=false
echo "{\"program\":\"$P\",\"witness\":\"$W\",\"exit\":$rc,\"writeVkS\":$v,\"proveS\":$(echo "$e - $s" | bc),\"peakMiB\":$((hwm/1024)),\"proofBytes\":$(stat -c %s $O/proof/proof 2>/dev/null || echo 0),\"verified\":$ok}"
