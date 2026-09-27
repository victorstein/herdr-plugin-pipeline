# Live smoke run 5: herdr pipeline plugin v1.7.0 (PR #150)

- **Date:** 2026-09-26 23:01 → 23:15 CST (2026-09-27 05:01 → 05:15Z). The pipeline itself ran 05:04 → 05:14Z.
- **Build under test:** `main` at `bb19359` (v1.7.0), which carries PR #150, the fixes for run 4's F1–F3, §7b.4 and O1 (#144–#148). It was linked from this checkout into an isolated herdr instance and not edited during the run.
  - herdr 0.9.1, Claude Code 2.1.283 (orchestrator and worker on Opus 5.5 1M).
- **Scope:** targeted, not the full runbook. One task on the `light` route, chosen so that one run exercises every run-4 finding: a worker dispatched at registration (O1), a draft in the orchestrator's box while only digests are owed (F2), a hand merge with the orchestrator `/exit`ed (F1), a teardown that removes the worktree (F3), and a run that ends without `branch-review` (§7b.4).
- **Target repo:** `victorstein/hpipe-smoke` at `4a010fb`; `main` ended at `8ea7068`.
- **Stall thresholds:** `TASK_STALL_MINUTES=10`, `STALL_MINUTES=5` in the isolated `config.env`, as in runs 3 and 4. No probe came due.

### Isolation

The user had a live run in `berean-os` on the globally installed v1.6.0, so this run used the separate herdr instance from run 4. The `~/.hps` tree had been removed after run 4 and was rebuilt:

- `~/.hps/bin/hh` sets `XDG_CONFIG_HOME=~/.hps/config`. That instance has its own session and plugin registries, with this checkout linked as `local:`.
- `~/.hps/bin/hpipe` → this checkout's `src/cli.ts`, and the isolated `config.env` sets `HPIPE_LINK_PATH` to it.
- The orchestrator and observation panes exported `PATH="$HOME/.hps/bin:$PATH"`; the orchestrator pane asserted that `hpipe` resolves into the checkout and that `$HERDR_SESSION` is `pipesmoke7`.
- The server was launched from `bash` with every `CLAUDE*` / `AI_AGENT` variable unset and `GH_CONFIG_DIR=~/.config/gh` (run 4's E1 and E2). No Claude it started printed the transcript-saving warning.
- Global state before and after: `herdr plugin list` shows `github:victorstein/herdr-plugin-pipeline@v1.6.0`, and `~/.local/bin/hpipe` → `…/stein.pipeline-f39fb4f3495d/src/cli.ts`. `berean-os` was not touched.

### Session, run, task

| Session | Run | Task | Branch | Issue | PR | Tier | End |
|---|---|---|---|---|---|---|---|
| pipesmoke7 | `hpipe-smoke-20260927-smoke-round-5-fjsf` | t1 | `smoke/capitalize` | #39 | #40 | light (`--tier`) | done (worktree removed) |

Run history (UTC):

```
05:04:31 t1  queued → research          dispatched at registration
05:04:56 run intake → dispatch          a task was registered
05:04:58 run dispatch → execute         every dispatched task has a worktree
05:05:35 t1  research → spec            actor idle + artifact fresh
05:06:30 t1  spec → spec-review         actor idle + artifact fresh
05:07:33 t1  spec-review → plan         cleared
05:08:21 t1  plan → blocked-on-files    actor idle + artifact fresh
05:08:23 t1  blocked-on-files → implement
05:09:47 t1  implement → pr-review      PR #40 at e0701fd
05:10:49 t1  pr-review → ci             cleared
05:11:31 t1  ci → merge                 cleared
05:13:31 t1  merge → close              PR merged
05:13:32 t1  close → teardown           issue #39 closed
05:13:34 t1  teardown → done            worktree removed
05:13:35 run execute → done             one task landed; branch-review skipped
```

**Evidence** is kept outside the repo, in `~/.hps/r5/`: `status.log` (`hpipe status` every 5s), `phase-watch.log` (run and task phase with workspace and pane ids, every 1s, from the merge onward), `orch-1.txt` and `orch-toolresults.txt` (the orchestrator's screen and tool output), `ledger/` and `state/` (the run ledger, delivery file and supervisor pane).

**Verdict: pass.** Every run-4 finding re-checked live is fixed. One new minor finding (F1 below).

## Re-checks of run 4

| Run 4 | Issue | Expected | Observed | Result |
|---|---|---|---|---|
| O1 | #148 | no digest tells the orchestrator a worker "has not been handed the brief" after it dispatched | `hpipe status` carried the line for one 5s sample (23:04:47), while it was true. Every `[pipeline]` message in the orchestrator's transcript was checked: `→ dispatch (from intake)` with 0 events, `→ execute` with one `research → spec` line, the catch-up, and the done notice. None carried it | PASS |
| F2 | #145 | a pane holding only digests shows its stuck input in `hpipe status` | draft typed into `w2:p1` at 23:06:01, nothing owed. `spec → spec-review` at 05:06:30Z produced a digest; the supervisor logged `stuck input in w2:p1 … \`hpipe status\` lists it`, and status read `⚠ stuck input in w2:p1: nothing has been sent to the orchestrator for 0m because its input box holds text the supervisor did not send — submit or clear that text and delivery resumes` from 23:06:33. One ctrl+c → `input box of w2:p1 is clear again; delivering to it`, the stuck line left status, and the `— catch-up` digest arrived at 05:06:43Z | PASS |
| F1 | #144 | a PR merged while the orchestrator has no agent is noticed on the next tick | orchestrator `/exit`ed at 23:11:49 (`agent: null`, `agent_status: unknown`). PR #40 merged by hand at 23:13:30; `merge → close` at 23:13:31, `teardown → done` at 23:13:34, with no orchestrator running | PASS |
| F3 | #146 | a worktree teardown removed leaves `workspace_id: null`, `pane_id: null`, keeps `last_pane_id` | `phase-watch.log`: `23:13:33 teardown ws=w3 pane=w3:p1` → `23:13:35 done ws=null pane=null last=w3:p1`, `agent_status: unknown`. herdr's workspace list no longer had `w3` | PASS |
| §7b.4 | #147 | a run that ends without `branch-review` tells the orchestrator | `execute → done` at 05:13:35Z queued `Run … is done — one task landed; branch-review skipped. Nothing more is sent for it.` / `- t1 smoke/capitalize (#39): done`. It was held through 5 failed sends (`agent_not_found`) while the orchestrator was down; after `claude --resume` at 23:14:13 it arrived at 05:14:20Z as `[pipeline] run … → done (from execute)`, and the supervisor logged `delivery to w2:p1 recovered after 5 failed attempt(s)` | PASS |

The light route itself matched run 4: `research → spec → spec-review → plan → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done`, with no `plan-review`. Implement → ci took 146s (light, run 4: 179s).

## Findings

### Critical
None.

### Major
None.

### Minor

**F1: the run's dispatch prompt arrives after the dispatch is done (#152).**
- The orchestrator registered t1, which dispatched at registration. It then ran the printed dispatch sequence and `hpipe dispatch --done`, all in one turn.
- The run left `intake` at 05:04:56Z, when that turn ended. The `→ dispatch (from intake)` digest carrying the whole `dispatch.md` arrived at 05:04:57Z, and the run moved on to `execute` at 05:04:58Z.
- The prompt still said **Still registering?** and **When the last task is registered: `hpipe dispatch --done`**. The orchestrator flagged it as "arrived after the work it describes" and spent a turn on it.
- Cause: `intake → dispatch` waits for the orchestrator to be idle, and `hpipe task` dispatches at registration, so in the common flow intake is already closed and every ready task has a worktree by the time `dispatch` is entered. `renderRunPhasePrompt` renders `dispatch.md` regardless.
- The same "true when written, stale when read" shape as run 4's O1.

### Not findings

The orchestrator reported three more things as wrong; none holds:

- **`.result.worktree.path` does not exist.** It does. herdr's `worktree create` response is `{"id":…,"result":{…,"type":"worktree_created","workspace":{…},"worktree":{…,"path":"…/smoke-capitalize"}}}`; `orch-toolresults.txt` holds the captured response.
- **Prompts name `bun run <checkout>/src/cli.ts` rather than `hpipe`.** Expected in this isolation: the supervisor resolves the bare `hpipe` to the global v1.6.0 install, not this build, so it names the checkout explicitly. Run 4 saw the same.
- **`--base <commit>` "contradicts" the brief's `git push -u origin HEAD`.** It does not: the commit leaves a *bare* `git push` with no upstream, and the brief's push names one.

### Environment notes (not the plugin)

- **E1: zsh does not word-split `env $unset_args`.** The first server launch passed the whole `-u … -u …` list as one argument and kept all 11 Claude variables. Checked with `ps eww` on the server pid, fixed by relaunching from `bash -c` with an `unset` loop.
- **E2: the controller's auto-mode classifier.** Starting Claude with `--dangerously-skip-permissions`, a read of the orchestrator pane through `hh`, and `gh pr merge` of the worker's PR were each denied (`Create Unsafe Agents`, `Self-Approval`) until the user approved them.

## Teardown

- `pipesmoke7`: server stopped and session deleted. Plugin state for it (`runs|queue|orchestrators/pipesmoke7`, delivery, pid, crash-log and workspace-id files) removed; copies in `~/.hps/r5/state/` and `~/.hps/r5/ledger/`.
- hpipe-smoke: #39 closed by PR #40 (merged, `main` = `8ea7068`). `smoke/capitalize` deleted locally and on the remote; the worktree was removed by teardown. No open issues or PRs.
- Global state unchanged (see Isolation).
