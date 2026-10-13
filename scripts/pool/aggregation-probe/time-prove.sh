#!/bin/bash
# time-prove.sh <program.json> <witness.gz> <out dir>: the circuit's key (written once beside program.json, under
# noir-recursive), then a timed prove with that key (peak RSS sampled), then verify. Prints one JSON line.
P=$1; W=$2; O=$3; TG=noir-recursive; BB=$(dirname "$0")/../../../node_modules/@aztec/bb.js/build/amd64-linux/bb
K=$(dirname $P)/vk; mkdir -p $K $O/proof; v=0
if [ ! -f $K/vk ]; then s=$(date +%s.%N); $BB write_vk -b $P -o $K -t $TG >$K/vk.log 2>&1 || { echo '{"error":"write_vk"}'; exit 1; }; v=$(echo "$(date +%s.%N) - $s" | bc); fi
s=$(date +%s.%N)
$BB prove -b $P -w $W -k $K/vk -o $O/proof -t $TG >$O/prove.log 2>&1 & pid=$!
hwm=0; while kill -0 $pid 2>/dev/null; do x=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null); [ -n "$x" ] && hwm=$x; read -t 0.5 < /dev/zero 2>/dev/null || true; done
wait $pid; rc=$?
e=$(date +%s.%N)
$BB verify -p $O/proof/proof -k $K/vk -i $O/proof/public_inputs -t $TG >$O/verify.log 2>&1 && ok=true || ok=false
echo "{\"exit\":$rc,\"writeVkS\":$v,\"proveS\":$(echo "$e - $s" | bc),\"peakMiB\":$((hwm/1024)),\"proofBytes\":$(stat -c %s $O/proof/proof 2>/dev/null || echo 0),\"verified\":$ok}"
