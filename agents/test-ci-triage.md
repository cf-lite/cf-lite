---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: triage a failing test or CI job

## 1. Purpose
Find out why a test or CI job fails, say whether it is a product bug, a test bug, or an environment flake, and fix it at the cause with evidence. Not your job: making CI green by skipping, retrying until it passes, loosening a budget or deleting a test.

## 2. Trigger
A CI run on a PR or on `main` fails; a local `bun run test*` fails; the weekly Node 22 job fails. Not for a failure caused by your own uncommitted change (fix that first).

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| The failing run or command | task statement, `gh run list --branch <branch>` | find the latest failing run yourself |
| The commit under test | the run's head SHA | `git log` on the branch |
| A clean worktree of that SHA | `git worktree add <dir> <sha>` | never triage in a dirty tree |

## 4. Steps
1. Find the run and the failing step (`gh` can list runs and show job status; the full log may need the web UI, in which case reproduce locally instead):
   ```bash
   gh run list --branch <branch> --limit 5
   gh run view <run-id>
   ```
2. Reproduce in a fresh worktree with the same install:
   ```bash
   bun install --frozen-lockfile && bun run build
   ```
   then run only the failing command. Map CI step to command:
   | CI step | Command |
   |---|---|
   | Docs links, anchors, decisions, briefs | `bun run docs:check && bun run llms:check` (regenerate with `bun run llms:gen`) |
   | Docs snippets typecheck | `bun run docs:snippets` |
   | Typecheck | `bun run typecheck` |
   | Unit tests under Bun | `bun --bun vitest run --exclude '**/*-workerd.test.ts'` |
   | Coverage ratchet and workerd-spawning tests | `node node_modules/vitest/vitest.mjs run --coverage` |
   | Worker size budget | `bun run size:check` ([performance-budgets](../docs/performance-budgets.md)) |
   | e2e under local workerd | `bun run test:e2e` (one script: `node scripts/<name>-e2e.mjs`) |
   | Dev-server e2e | `bun run test:dev` |
   | Browser tests | `bun run test:browser` (needs `bunx playwright install chromium`) |
3. Run the failing test twice more. Consistent failure = a real defect; passes sometimes = suspect a flake and go to step 4; never call it a flake after one pass.
4. Known environmental causes, check before blaming the code:
   - `security-e2e` fails if re-run within about 60 seconds of a previous run (Durable Object limiter state persists under `.wrangler`): wait or clear the state ([rc-status](../docs/rc-status.md), known items).
   - A workerd-spawning vitest file can time out in its `beforeAll` (90 s) on a loaded machine when two suites run at once; it passed on a plain re-run of the whole suite (seen once on 2026-10-06). Run it alone before concluding anything.
   - `workerd ... bind(): Address already in use (os error 98)` in a coverage-ratchet or e2e step: two runs overlapped on the same host (for example a push-to-`main` run and a PR run) and collided on a fixed port. Seen on 2026-10-06 on PR #77 (docs-only change, passed on re-run). Check `gh run list` for a concurrent run, then `gh run rerun <id> --failed` once; a second identical failure is a real problem.
   - The browser tests use a fixed demo port (18999); `PW_DEMO_PORT` moves it if taken.
   - The local dev server runs on Node, not Bun ([bun-first](../docs/bun-first.md)); a hang under Bun there is the known upstream issue, not a regression.
5. Bisect when the cause is not obvious: `git bisect` between the last green run's SHA and the failing SHA, with the failing command as the test.
6. Fix at the cause, with a test that fails before and passes after (red-before-green evidence in the PR). A real flake gets its cause removed (isolate state, per-run keys), not a retry loop or a `skip`.
7. Re-run the whole affected job locally, push, and check the new CI run ends green (`gh run list --branch <branch>`).

## 5. Outputs
A fix PR titled `fix: <what failed>` (or `test: <what was unstable>`) with the test, or a written report if the cause is environmental. PR body: failing command and output, cause, the red and green runs, anything left.

## 6. Evidence rules
A cause is "confirmed" only when removing it makes the failing command pass and restoring it fails again (or a test shows both). "Looks like a flake" is a hypothesis; say how many runs you did. A budget (`bench/*.json`) is changed only with the measurement that justifies it, never to turn a run green.

## 7. Stop and ask (owner)
Changing a gate, budget or coverage ratchet downwards; skipping or deleting a test; adding a retry; a failure that only happens on the real Cloudflare platform (needs a scratch account); a suspected security regression (also see [`SECURITY.md`](../SECURITY.md)); CI infrastructure or runner changes.

## 8. Forbidden
`--no-verify`, `skip`/`only` left in, retry loops, loosening an assertion to match a bug, lowering a budget check, hand-editing generated files, secrets or runner details in a PR or log.

## 9. Hand-off
Final message: failing run or command, cause with evidence, fix PR, runs before and after, what is still flaky or unknown.

## 10. Where truth lives
| Question | Source |
|---|---|
| What CI runs | `.github/workflows/ci.yml` |
| What each local command covers | [`CONTRIBUTING.md`](../CONTRIBUTING.md) (test table) |
| Size and speed budgets | `bench/module-sizes.json`, `bench/budgets.json` |
| Known flakes | step 4 above, [rc-status](../docs/rc-status.md) |

## 11. Definition of done
- [ ] failing command reproduced locally, cause named
- [ ] fix with a test that failed before (output pasted)
- [ ] the affected job's commands pass locally; the new CI run is green (`gh run list`)
- [ ] no gate, budget or test weakened

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version from the repository's CI file, its contributing guide and the flakes seen on that day (one workerd suite timeout on a first full `bun run test`, green on re-run; one CI port collision between overlapping runs, green on re-run). Not run end to end by a second agent | doc agent | triage steps were scattered across chat and notes |
