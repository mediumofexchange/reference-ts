#!/bin/bash
# Every 5 minutes: serve's resident memory by mapping kind (anonymous mappings, malloc's [heap], the binary) and the
# journal's statement count, appended to run/serve-smaps.tsv. Disposable probe tooling.
cd /home/user/reference-ts/scratch/depth
while true; do
  P=$(node -e 'try{console.log(require("./run/pids.json").serve)}catch{}')
  if [ -n "$P" ] && [ -r /proc/$P/smaps ]; then
    N=$(node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("run/operator/journal.db",{readOnly:true});console.log(d.prepare("select count(*) n from journal_receipt").get().n)' 2>/dev/null)
    R=$(awk '/^[0-9a-f]+-/{name=($6==""?"anon":$6)} /^Rss:/{r[name]+=$2} END{printf "%d\t%d\t%d", r["anon"]/1024, r["[heap]"]/1024, r["/opt/node24/bin/node"]/1024}' /proc/$P/smaps)
    T=$(ls /proc/$P/task | wc -l)
    echo -e "$(date -u +%H:%M)\t$P\t$N\t$R\t$T" >> run/serve-smaps.tsv
  fi
  sleep 300
done
