# Live smoke run 4: herdr pipeline plugin, `feat/review-tiers` (PR #143)

- **Date:** 2026-09-26, 14:50 → 16:00 CST (the pipeline itself ran 15:02 → 15:57).
- **Build under test:** branch `feat/review-tiers` at `266c2e2` (review tiers, model routing, CI-gating fixes), linked from this checkout into an isolated herdr instance. The checkout was not edited during the run.
  - herdr 0.9.1, Claude Code 2.1.282 (orchestrators and workers on Opus 5.5 1M; implement subagents on Sonnet 5).
- **Runbook:** `test/integration/smoke.md` at `266c2e2`.
- **Target repo:** `victorstein/hpipe-smoke`, pulled to `09031bd` before the run; `main` ended at `4a010fb`.
- **Stall thresholds:** `TASK_STALL_MINUTES=10`, `STALL_MINUTES=5` were added to the isolated `config.env` for the run, as in run 3. That file is back to its single `HPIPE_LINK_PATH` line.

### Isolation

The user had a live run on the globally installed v1.5.21, so this run used a separate herdr instance:

- Every herdr call went through `~/.hps/bin/hh`, which sets `XDG_CONFIG_HOME=~/.hps/config`. That instance has its own session registry and plugin registry, with this checkout linked as `local:`.
- The isolated `config.env` set `HPIPE_LINK_PATH=~/.hps/bin/hpipe`, so the global `~/.local/bin/hpipe` was never rewritten.
  - It pointed at `…/stein.pipeline-f39fb4f3495d/src/cli.ts` before the run and after it.
  - Global `herdr plugin list` shows `github:victorstein/herdr-plugin-pipeline@v1.5.21` before and after.
- Every orchestrator and observation pane exported `PATH="$HOME/.hps/bin:$PATH"`, and I asserted two things in each:
  - `readlink "$(command -v hpipe)"` resolves into this checkout.
  - `$HERDR_SESSION` is the smoke session.
- Supervisors resolve the bare `hpipe` to the global v1.5.21, so every supervisor prompt rendered `{{hpipe}}` as `bun run <checkout>/src/cli.ts`. Workers therefore always ran this build.
- Two environment fixes were needed before the first task (E1, E2 below). I restarted the isolated servers from a wrapper that:
  - strips the controller's `CLAUDE*` / `AI_AGENT` variables;
  - sets `GH_CONFIG_DIR=~/.config/gh`.

### Sessions, runs, tasks

| Session | Run | Task | Branch | Issue | PR | Tier | End |
|---|---|---|---|---|---|---|---|
| pipesmoke4 | `hpipe-smoke-20260926-smoke-batch-dmfk` | t1 | `smoke/one` | #26 | #30 | heavy (`--tier`) | done (worktree removed) |
| | | t2 | `smoke/two` | #28 (filed by `--title`) | #29 | heavy | done (worktree kept: untracked file) |
| | | t3 | `smoke/three` | #27 | — | heavy | failed (deliberately, after the §1 lifecycle checks) |
| pipesmoke5 | `hpipe-smoke-20260926-tier-batch-a-t0q2` | t1 | `smoke/tier-light` | #31 (label `pipeline:tier-light`) | #35 | light | done (kept) |
| | | t2 | `smoke/tier-standard` | #32 | #38 | standard (default) | done (kept) |
| | | t3 | `smoke/tier-heavy` | #33 | #36 | heavy | done (kept) |
| pipesmoke6 | `hpipe-smoke-20260926-tier-batch-b-81iy` | t1 | `smoke/tier-raise` | #34 | #37 | light → standard | done (worktree removed) |

All three runs ended `[done]`. The main run's `branch-review` and Batch A's `branch-review` both cleared `VERDICT: CLEAR`. Batch B skipped `branch-review` by design.

**Evidence** is kept outside the repo, in the session scratchpad `r4/`:
- `status-<session>.log`: `hpipe status` every 5s.
- `agentpoll-<session>.log`: every pane's `agent_status` every 5s.
- `cap/<session>/<pane>.log`: changed pane snapshots.
- `decwatch-t1-d1.log`: t1's phase against its pane, polled every 0.25s.
- `ledger/`: the three run ledgers and both branch-review verdicts.
- `state/`: plugin logs, supervisor panes, pid, delivery and crash files.
- The per-check files named in the tables below.

**Verdict: pass, with three minor findings.**
- Every tier and model-routing check passed live, in all three batches.
- The CI-gating fixes were only partly exercised:
  - No review BLOCKER occurred in any batch, and CI never went red, so neither path ran live. The runbook gives no way to force them.
  - The parts that did run behaved: `ci: none` on entry to `ci`, and green CI clearing `ci → merge`.
- Among the rest of the runbook, one finding (F1) matters in practice: a PR merged while the orchestrator has no live agent is not noticed until an orchestrator comes back.

## Per-section results

### Setup / §1

| Step | Expected | Observed | Result |
|---|---|---|---|
| Floor | one `pipeline` workspace, one `Pipeline supervisor` pane | pipesmoke4 `w1:p2`, pipesmoke5 `w1:p2`, pipesmoke6 `w1:p2`; each logged `supervisor up — session <s>` | PASS |
| Warm restart (environment fix) | still exactly one supervisor pane | after each of two server restarts: `reclaiming stale pid file`, `closed dead supervisor panes: w1:p3` / `w1:p4`, then exactly one pane | PASS |
| `hpipe start` | intake prompt; status `supervisor: live`, `[intake]`, `orchestrator: w2:p1` | as expected | PASS |
| Malformed `--files` | exit 1, whitespace message, `→ --files src/lib,src/lib/config.ts` | exact text, `a=1`, nothing registered (`s1-malformed.txt`) | PASS |
| Orphan `--title` | exit 1, `no agent definition at …/nope-dev.md`, no issue | exact message, `b=1`, and `gh issue list --search "smoke orphan"` empty. Validation ran before gh: the first attempt failed with no gh auth (E2) and still printed the agent-file error, not `gh issue create failed` | PASS |
| Registrations | `task_id`, `tier: heavy (--tier)`, `issue: #28 (filed)` on the `--title` task, `files:`, `bootstrap:`, `base:`, `dispatch, in order:` | in that order for all three; exactly one issue #28 | PASS |
| #89 pause between `agent start` and `dispatch --task` | `YOUR move: its agent in w3:p1 has not been handed the brief — … dispatch --task t1 --pane w3:p1`; `agent get` never `working` | exact line from 15:02 to 15:08. `w3:p1` sampled 12× `idle` and 2× `unknown`, never `working`. The 15:08:02 probe went to the **orchestrator** ("was never handed the brief … dispatch --task t1 --pane w3:p1"); t1's worker had no transcript at all until it was dispatched | PASS |
| `dispatch under way` in status (#135, run-3 M1) | the task line shows the clause during the grace | `t3 … heavy unknown — dispatch under way — see `hpipe show --task t3`` | PASS (M1 fixed) |
| #12 unstarted worker (t3: `worktree create` only) | `agent_not_found`; no `agent` field; silent for 5 min, then `no agent detected in its worktree`; orchestrator probe after STALL_MINUTES | exactly that. At 15:08:14 status listed it with the `pane list` → `agent start` → `dispatch --task` advice; the 15:08:06 orchestrator probe carried the same advice, not a research path | PASS |
| Start + dispatch clears the flags | entries gone within a tick | both `waiting on you:` entries gone at the next status; t1 and t3 `working — worker's move: waiting for its research artifact` | PASS (the 45-min re-armed first probe was not waited for) |
| `pane close` on a bound worker | `failed`; `pane: none (last: …)`; `agent: unknown`; `workspace: none`; `pane.closed` hook | 15:09:13 close; `failed (0m)`, `workspace: none`, `pane: none (last: w5:p1)`; plugin log `pane.closed` and `workspace.closed` at the same second | PASS |
| Rewind to research with no workspace | status: `no worktree and no agent — herdr worktree open …`, `create … --base <commit>` only on `worktree_not_found` | rewind output and status both print that exact open-first sequence (`t3-rewind.txt`) | PASS |
| `worktree open` binds | `workspace: w<n>` | `workspace: w6` within 3s | PASS |
| `pane move` (#86) | phase kept, new pane id | `pane move w6:p1 --new-tab --workspace w2` → `research`, `working`, `pane: w2:p3`, `workspace: none` | PASS |
| Rewind into `implement` variant | one message with brief and implement prompt | not run | NOT EXERCISED |
| Close pane / workspace in `merge` (#86/#116) | phase kept; `teardown→done`, never `orphaned`; checkout gone; a dirty checkout is kept | **workspace close**: t2 at 15:11:25, with `untracked-smoke-note.txt` → `merge` kept, `workspace: none`. After the merge: `teardown→done worktree kept: …/smoke-two (modified or untracked files)`, file intact. **pane close**: t1 `w3:p1` at 15:19:39 → `merge` kept. After the merge: `teardown→done worktree removed`, checkout gone from `git worktree list`. Neither was called a dead end | PASS |

### §2 / §3

| Step | Observed | Result |
|---|---|---|
| Digest shape and arrows | `- t2 smoke/two (#28) [research → spec] agent:done — worker's move: waiting for its spec artifact`; footers carry the same clause as status. No bare moves and no old-shape lines | PASS |
| Both workers at `spec` (fan-out) | never simultaneous: t1 was held undispatched for the #89 check while t2 ran ahead. Separate panes only ever received their own issue | NOT EXERCISED (no simultaneous window) |
| Live `blocked-on-files` collision | t2 held `src/lib/config.ts` in `merge` (held for the test) when t1 left `plan-review`. Status tracked the holder `⚠ t1 blocked on files held by t2 (merge)` ×5 → `(close)` → `(teardown)`, always `— waiting for it to finish`. t1 was released `blocked-on-files → implement` at 15:15:15, the **same second** t2 reached `done`, not at its merge (15:15:09) | PASS. t2 won and t1 waited, because t1 was deliberately started late |
| `release` against an in-flight holder | `task t2 is still in flight (merge)`, rc 1 | PASS |
| Plans widen only onto test files | supervisor log: `plan widened files by test/config.test.ts`, `test/greet.test.ts`, `test/text.test.ts`, `test/math.test.ts` | PASS |
| Stall probes | orchestrator probes for t1 and t3 at 15:08 (above). Batch A's `branch-review` was probed while its subagent was blocked (E4) | PASS |

### §4

| Step | Observed | Result |
|---|---|---|
| 4a. Answered from the repo (t2 d1: camelCase or snake_case) | asked 15:03:35.3 → decision prompt to the orchestrator at 15:03:38.2, alone with no footer (#93) → the orchestrator read `config.ts` and answered `--by orchestrator` at 15:03:42.9 (`recorded answer … pending delivery`) → the worker got `# Decision answered — resume research` at 15:03:45.8 → phase back to `research` at 15:03:48.0 | PASS |
| Status while open | `⚠ t2 blocked on an open decision (0m): …` and `YOUR move: waiting for an answer to the open decision` | PASS |
| 4b. Escalated to the human (t1 d1: capitalise in `wave`?) | the orchestrator brought me the question with a named recommendation ("don't capitalise, as the issue's own example does"). That is correct, since #26 reserves it for the owner; it is neither over- nor under-escalation. I decided "don't capitalise", recorded `--by human`. Box watch: `[Pasted text #2 +18 lines]` at 15:10:04.87 → submitted 15:10:05.12 → phase `research` at 15:10:06.38 | PASS |
| 4d.1 Dead orchestrator | `/exit` at 15:19:36 → at once `⚠ orchestrator pane w2:p1 has no live agent`. The merge-row probe came due 15:29 → `⚠ 1 stall probe for the orchestrator undelivered for 0m (pane w2:p1 has no live agent; 4 failed attempts, last agent_not_found)`. The supervisor logged `delivery to w2:p1 failed (agent_not_found)` **once**; there were 4 attempts in 52s (5/10/20s backoff) | PASS, but see **F1** |
| 4d.2 Resume | `agent start … --resume` at 15:30:30 → log `delivery to w2:p1 recovered after 5 failed attempt(s)`; t1 went `merge → close → teardown → done` 15:30:36–41. The held probe was dropped as moot, and no catch-up digest came (no digest was owed). The catch-up path **was** observed in 4d.4 | PASS |
| 4d.3 Gone worker pane with a probe due | not run | NOT EXERCISED |
| 4d.4 Stuck input (orchestrator) | a typed draft carries no faint `^[[2m` (`❯ human draft not submitted yet`). The supervisor logged `stuck input in w2:p1` and nothing was sent over it. Once a `Ready to merge` was owed, status showed `⚠ stuck input in w2:p1: 1 prompt for the orchestrator held 0m …`. One ctrl+c at 15:41:45 → `input box of w2:p1 is clear again; delivering to it`, and within about 1s came `— catch-up` then the held `Ready to merge — smoke/tier-light (#31), PR #35`. The draft was never cleared by the plugin | PASS, but see **F2** |
| 4d.5 Usage limit | not hit | NOT EXERCISED |

### §5: subagent vs `agent_status` (re-measured)

Every 5s sample of the worker pane read `working` while a subagent ran:
- t2 `spec-review` 15:04:39–15:05:41: 12 of 12.
- t2 `implement`, Sonnet subagent: 17 of 17.
- t1 `implement`, Sonnet subagent, *backgrounded* (`core-dev(Implement wave helper #26) Sonnet 5 — Backgrounded agent`, with the worker polling for the commit): 21 of 21.

Never `idle` or `done` while a subagent was running. Run 1's answer still holds.

### §6

| Step | Observed | Result |
|---|---|---|
| `Closes #<n>` in PR bodies | #29 `Closes #28`, #30 `Closes #26`, and each close edge read `issue #n closed` | PASS |
| `teardown` removes the worktree unless `--keep-worktree` | removed for the main t1 and Batch B t1; `worktree kept by request` for all three Batch A tasks | PASS |
| `plugin_command_limit_reached` | 0 in all three sessions; 0 failed hook runs | PASS |
| Supervisor kill and reopen (#97) | killed pid 42363 → pane read `supervisor exited — run hpipe status`. The `supervisor` action opened `w1:p3`, logging `closed dead supervisor panes: w1:p2; their last output is in …crash.log`. The crash log held the tail; exactly one supervisor pane; invoking again printed `already running (pid 54629); nothing to reopen` | PASS |
| branch-review → done | main: 15:30:43 → 15:32:19 `review cleared`; Batch A: 15:45:44 → 15:57:03 (10 min of that was E4) | PASS |

## Tier and model-routing checks (the new behaviour in PR #143)

| Check | Evidence | Result |
|---|---|---|
| `tier:` line at registration | `tier: light (label pipeline:tier-light; --tier said standard)`, `tier: standard (default)`, `tier: heavy (--tier)`, in that order; the main batch printed `tier: heavy (--tier)` ×3 | PASS |
| Label overrides `--tier` | #31 carried `pipeline:tier-light` and was registered `--tier standard` → tier `light` | PASS |
| Tier on status lines | `t1 smoke/tier-light #31 [research 0m] light working — …` | PASS |
| `tier log:` | `2026-09-26 21:34Z — → light (label pipeline:tier-light; --tier said standard)`; one entry per Batch A task | PASS |
| `visited:` light | `research → spec → spec-review → plan → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done` | PASS |
| `visited:` standard | `… → plan → plan-review → blocked-on-files → implement → pr-review → ci → …` | PASS |
| `visited:` heavy | Batch A t3 exactly the heavy row. Main t1 and t2: `research → blocked-on-decision → research → spec → … → pr-review-intent → pr-review-quality → ci → …`, with each decision correctly between two `research` entries. Main t3: `research → failed → ↺research` | PASS |
| `Tier:` atop each verdict | all 20 per-task verdicts read the task's tier on line 1 (`Tier: light` ×2, `Tier: standard` ×6, `Tier: heavy` ×12). Batch B's three read `standard`: its first verdict (`spec-review`, 15:37) came after the 15:36 raise | PASS |
| `Tiers:` atop branch-review | main: `Tiers: t1 heavy, t2 heavy, t3 heavy`; Batch A: `Tiers: t1 light, t2 standard, t3 heavy` | PASS |
| Implement subagent on Sonnet | every worker transcript (7 workers) shows `"model":"sonnet"` twice, which is the Agent call's input. Exactly one subagent per worker ran `claude-sonnet-5`, and each started inside `implement`: main t2 15:07:50 (implement 15:07:39), main t1 15:15:37 (15:15:15), A-t1 15:38:24, A-t2 15:41:57, A-t3 15:39:51, B-t1 15:40:29 (15:40:14). Every review subagent ran `claude-opus-5-5`. No PR body mentioned a rejected model | PASS |
| implement → ci wall clock (Batch A) | light 179s, standard 192s, heavy 198s | recorded |
| 7b raise mid-`spec` | `t1: light → standard. spec completes as it is; the next step follows standard.` `tier log:` holds `→ light (--tier) · … light → standard (hpipe-tier, pane w2:p2): smoke: research found it touches a contract`. No tier entry in `run.history` | PASS |
| Raise changes the route | B-t1 `visited:` equals the standard row exactly: `plan-review` present, one `pr-review` | PASS |
| Lowering guard | from the orchestrator's pane: `lowering a tier needs a human; run this from your own pane`, rc 1; `tier log:` unchanged | PASS |
| One task landed → no branch-review | last run entry `{"from":"execute","to":"done","why":"one task landed; branch-review skipped"}`; no final-review prompt was sent | PASS |
| 7b.4: did the orchestrator hear the end? | **Silent.** The last thing the pipeline sent Batch B's orchestrator was `Ready to merge — smoke/tier-raise (#34), PR #37` (15:43:28). It merged and ended its turn at 15:43:52, noting that status still said "waiting for PR #37 to be merged". Nothing followed: no `teardown → done` line and no run-end digest. `hpipe status` shows the run `[done]` with `ended: done t1` | recorded (open question answered: silent) |

## CI-gating checks

| Check | Evidence | Result |
|---|---|---|
| `ci: none` on entry to `ci` | main t2 `hpipe show` at `ci (0m)` read `ci: none` | PASS |
| Green CI clears `ci → merge` | seven PRs, `ci → merge cleared` 12–25s after entry | PASS |
| `implement` does not clear after a review BLOCKER until the fix push; `head_sha_at_entry` = PR head at the send-back | no review in any batch returned a BLOCKER: every verdict is pass 0, and both branch reviews were CLEAR | NOT EXERCISED |
| Second CI round waits for a fresh poll (`ci: none` until the new head is polled) | CI was green on the first poll for all seven PRs | NOT EXERCISED |

## Findings

### Critical
None.

### Major
None.

### Minor

**F1: a PR merged while the orchestrator has no live agent is never noticed, and status keeps asking the human to merge it.**
- Timeline:
  - The main run's t1 sat in `merge` when its orchestrator was `/exit`ed at 15:19:36.
  - I merged PR #30 by hand at 15:20:01Z (`gh pr view 30` → `MERGED`), and issue #26 closed.
  - For the next 10½ minutes t1 stayed `[merge]`, and `hpipe status` kept listing `YOUR move: waiting for PR #30 to be merged`.
  - The merge was picked up 6s after the orchestrator restarted: `merge→close PR merged` at 15:30:36.
- Cause:
  - `src/supervisor/tasks.ts:229-233` skips rows whose actor is the orchestrator (`merge`, `close`) unless the orchestrator pane reads idle.
  - A pane with no agent never reads idle.
- The stall clause (`stall.ts:332-338`) tells the orchestrator "if it is already merged, end your turn". That cannot help when there is no orchestrator.
- Effect: a human who merges by hand while the orchestrator is down sees a run that never advances, plus a status line that misstates the PR.
- Nothing is lost; restarting or claiming an orchestrator recovers it at once. The `⚠ orchestrator pane … has no live agent` line is the only hint.
- Evidence: `s4d-dead-orch-status.txt`, `s4d-held-probe-status.txt`, and the ledger history in `ledger/hpipe-smoke-20260926-smoke-batch-dmfk.json`.

**F2: stuck input that holds only digests is invisible in `hpipe status`, although the supervisor log says status lists it.**
- 15:37:30: a draft is typed into Batch A's orchestrator box.
- 15:37:39: the supervisor logs `stuck input in w2:p1: … nothing more is sent there until it is submitted or cleared — `hpipe status` lists it`.
- `delivery.pipesmoke5.json` records `{"code":"stuck_input"}`.
- Yet three status reads (15:37:52, 15:37:59, 15:38:05) and every read up to 15:41 showed no stuck line, while digests for t1, t2 and t3 transitions were being held.
- The line appeared only at 15:41:36, once an owed `Ready to merge` was held.
- Cause: `deliveryWarnings` (`src/lib/outbox.ts:245-259`) only renders holds for owed items (outbox prompts, decisions, probes). It never renders a pane hold that holds only digests.
- Fix options: either print the pane hold from `delivery.<session>.json` on its own, or drop the log's promise.
- Evidence: `4d4-*.txt`, `4d4-delivery.json`, `status-pipesmoke5.log`.

**F3: teardown that removes the worktree leaves the dead workspace and pane ids on the finished task.**
- Batch B t1 ended `teardown→done worktree removed` at 15:43:59, and herdr's `workspace list` no longer had `w3`.
- At 15:44:41, `hpipe show` still read `agent: done`, `workspace: w3`, `pane: w3:p1`, and the ledger holds `workspace_id: "w3", pane_id: "w3:p1"`.
- Contrast the main run's t1: its pane was closed before teardown, and it reads `workspace: none`, `pane: none (last: w3:p1)`.
- #116's rule ("`workspace: none` within two ticks, never the dead id") is only enforced on the close paths, not on teardown's own removal.
- This is cosmetic for a `done` task, but herdr reuses ids across workspaces, so a later workspace `w3` would appear to belong to it.
- Evidence: `7b-show-done.txt`, `ledger/hpipe-smoke-20260926-tier-batch-b-81iy.json`.

### Observations (not defects)

- **O1: "not handed the brief" arrives after the dispatch.**
  - Both orchestrators flagged a digest line `YOUR move: its agent in <pane> has not been handed the brief` as stale.
  - It was true when composed. It is built on the `agent_detected` tick between `agent start` and `dispatch --task`: main batch 21:02:43.1Z against a dispatch at 21:02:43–44; Batch B queued 21:35:56.823 against a confirm at 21:35:56.929.
  - It lands after the orchestrator has already dispatched, costing a turn of doubt each time.
  - Delaying that event line by one tick, or re-checking `briefed_at` at send, would remove the noise.
- **O2: supervisor ticks lost to on-disk changes.** Supervisor panes repeatedly logged `this tick not saved (run … changed on disk since it was read); its prompts are dropped and it is re-read next tick`, several times per busy minute in pipesmoke4 and pipesmoke5. It is self-healing and nothing was lost, but it is the normal log noise under concurrent CLI writes.
- **O3: no catch-up digest after the main-batch outage.** After the 4d outage there was no `— catch-up` digest, because no digest had been lost: the only owed item was the merge-row probe, which the restart made moot. The catch-up path was exercised in 4d.4 instead.
- **O4: merged branches stay on the remote.** The orchestrators' merges (`gh pr merge --squash`) left the remote branches in place, because the merge prompt does not ask for deletion. I deleted them in teardown.

### Environment notes (not the plugin)

- **E1: the isolated server inherited the controller's Claude env.**
  - The first `pipesmoke4` server was started from inside a Claude Code session and carried `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID` and the messaging socket.
  - Every Claude it launched printed `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`. That would have made the Sonnet transcript check impossible.
  - Fix: restart the server with those variables stripped. Any future isolated smoke run launched by an agent needs the same.
- **E2: `gh` was unauthenticated in the isolated instance.**
  - `hh` sets `XDG_CONFIG_HOME`, and gh keeps its auth under `$XDG_CONFIG_HOME/gh`.
  - Every pane, and the supervisor's PR and CI polls, would have failed.
  - Fix: `GH_CONFIG_DIR=~/.config/gh` in the server env.
- **E3: a server restart auto-resumed the orchestrator in auto mode.**
  - herdr resumed the orchestrator's Claude (`claude --resume <id>`) without `--dangerously-skip-permissions`.
  - A shell line I sent with `pane run` went to Claude as a prompt; it only re-ran read-only checks.
  - I relaunched with the flag and `--resume`.
- **E4: a Claude Code safety prompt blocked a subagent despite bypass mode.**
  - Batch A's branch-review subagent was stopped by `Dangerous rm operation on possibly-empty variable path` even under bypass permissions.
  - The orchestrator pane read `blocked` for about 10 minutes.
  - The plugin handled it correctly: `⚠ 1 stall probe for the orchestrator undelivered for 4m (6 failed attempts, last agent_blocked)`, and nothing was typed into the dialog. I approved it by hand.
- **E5: folder-trust dialog.** `~/.hps/hpipe-smoke` showed Claude's folder-trust dialog once (`agent start` → `agent_not_ready`). This is the known run-1 environment note.

## Teardown

- Batch A worktrees were removed with `hh --session pipesmoke5 worktree remove --workspace w3|w4|w5 --force`.
- The workspace-less `smoke-two` (the kept dirty checkout) and `smoke-three` were removed with `git worktree remove --force`.
- `pipesmoke4/5/6`: servers stopped and sessions deleted. The isolated `session list` shows only its `default`.
- Plugin state removed: `runs|queue|orchestrators/pipesmoke*`, plus the `pipesmoke*` delivery, pid, crash-log and workspace-id files. Copies are in `r4/state/` and `r4/ledger/`.
- The isolated `config.env` is back to `HPIPE_LINK_PATH=/Volumes/stein/.hps/bin/hpipe` only.
- hpipe-smoke:
  - #27 closed by hand. #26, #28, #31–#34 were closed by their PRs.
  - Merged into `main`: #29, #30, #35, #36, #37, #38 (`main` = `4a010fb`).
  - No open issues or PRs.
  - Every `smoke/*` branch deleted, local and remote.
  - The untracked branch-review verdict files were removed from the checkout.
- Global state is unchanged:
  - `herdr plugin list` shows `stein.pipeline … github:victorstein/herdr-plugin-pipeline@v1.5.21`.
  - `readlink ~/.local/bin/hpipe` → `/Volumes/stein/.config/herdr/plugins/github/stein.pipeline-f39fb4f3495d/src/cli.ts`, the same as before.
  - No `berean-os`, `personal`, `pipeline` or `default` session was touched.
