#!/bin/bash
# time-prove.sh <build dir>: write_vk, then a timed prove with the vk, sampling peak RSS.
P=$1; BB=$(dirname "$0")/../../../node_modules/@aztec/bb.js/build/amd64-linux/bb
mkdir -p $P/vkdir $P/p2
$BB write_vk -b $P/program.json -o $P/vkdir >/dev/null 2>&1 || { echo write_vk failed; exit 1; }
s=$(date +%s.%N)
$BB prove -b $P/program.json -w $P/witness.gz -k $P/vkdir/vk -o $P/p2 >$P/p2.log 2>&1 & pid=$!
hwm=0; while kill -0 $pid 2>/dev/null; do v=$(awk '/VmHWM/{print $2}' /proc/$pid/status 2>/dev/null); [ -n "$v" ] && hwm=$v; read -t 0.5 < /dev/zero 2>/dev/null || true; done
wait $pid; rc=$?
e=$(date +%s.%N)
$BB verify -p $P/p2/proof -k $P/vkdir/vk -i $P/p2/public_inputs >/dev/null 2>&1 && ok=verified || ok=FAILED
echo "{\"dir\":\"$P\",\"exit\":$rc,\"proveS\":$(echo "$e - $s" | bc),\"peakMiB\":$((hwm/1024)),\"proof\":$(stat -c %s $P/p2/proof),\"$ok\":true}"
