# Live benchmark harness

These scripts produced the numbers in `RESULTS-live.md`, `RESULTS-live-0.6.md` and `RESULTS-rsc-live.md`. The raw per-request dumps they write to `bench/results-live/` (about 12 MB of `.jsonl`/`.json`) are not kept in the repository (the directory is gitignored); the summarised tables in those result files are the record.

To reproduce a run you need a scratch Cloudflare account (never a production one) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, and one or more client hosts:

1. Build the variants with `build-v06.sh` (or the older `build-remote.sh`) on an idle machine.
2. Deploy them as temporary Workers on `workers.dev` with `deploy-v06.sh`. `variants*.json` lists the hostnames; replace `ACCOUNT` with your `workers.dev` subdomain. The scripts call `cf-deploy` / `cf-deploy2`, thin wrappers around `wrangler deploy` (the second for vinext's own CLI); substitute your own.
3. Probe with `run-v06.sh <client-label>` (warm TTFB, Worker CPU through the Workers analytics GraphQL API, cold start after a fresh deploy), then print the tables with `analyze-v06.py`.
4. Delete every temporary Worker with `teardown-v06.sh` and check that each returns 404.

Numbers depend on the client's network position and colo; compare variants measured from the same client only.
