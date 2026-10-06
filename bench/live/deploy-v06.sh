#!/usr/bin/env bash
# Deploy (or redeploy with a new version message) one bench worker from builds in ~/cf-lite-live/ (rsynced from the build host by rebench-sync.sh).
# usage: deploy-v06.sh <bare|cflite|full|vinext|next> [message]
set -euo pipefail
L=~/cf-lite-live; export PATH=$L/tool/node_modules/.bin:$PATH; M=${2:-deploy}
case $1 in
  cflite) cf-deploy $L/cf-lite/dist/bench_cf_lite -- --name bench-cflite --message "$M" ;;
  full)   cf-deploy $L/cf-lite-full/dist/bench_cf_lite_full -- --name bench-cflite-full --message "$M" ;;
  bare)   cf-deploy $L/bare-wrangler/dist/bench_bare_worker -- --name bench-bare --message "$M" ;;
  next)   cf-deploy $L/next-opennext -- --name bench-next --message "$M" ;;
  vinext) cf-deploy2 $L/vinext deploy --prebuilt --message "$M" ;;
esac
