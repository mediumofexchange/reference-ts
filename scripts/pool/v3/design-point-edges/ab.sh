#!/bin/bash
# Probe tooling, disposable: each variant builds its own 1,200-statement history (a copied journal is refused as
# COPIED), then times 1,500 admissions through serve.
cd /home/user/reference-ts/scratch/dpr
for v in "$@"; do
  rm -rf runs/$v
  export DPR_WT=/home/user/reference-ts/scratch/wt/$v DPR_RUN=/home/user/reference-ts/scratch/dpr/runs/$v
  node driver.mjs --marks 1000000 --stop-after 1200 > runs/$v-driver.log 2>&1
  node profile.mjs --statements 1500 > runs/$v-profile.log 2>&1
  echo "$v exit $?" >> runs/ab-done.log
done
echo all >> runs/ab-done.log
