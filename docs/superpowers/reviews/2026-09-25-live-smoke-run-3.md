# Live smoke run 3: herdr pipeline plugin v1.5.19

- **Date:** 2026-09-25, 08:28 → 09:10 CST
- **Plugin:** stein.pipeline **v1.5.19**, installed globally from GitHub (commit `16eb7ce`), with 9 event hooks including `workspace.closed`.
  - herdr 0.9.0, Claude Code 2.1.281.
- **Runbook:** `test/integration/smoke.md` at origin/main `16eb7ce`.
- **Session:** `pipesmoke3`, fresh.
- **Target repo:** `victorstein/hpipe-smoke`, pulled to `abdba4f` before the run.
- **Main run:** `hpipe-smoke-20260925-smoke-batch-3-5ns5`, with four tasks:

  | Task | Branch | Issue | Role in the run |
  |---|---|---|---|
  | t1 | `smoke/one` | #19 | `initials()`; carries a decision only the owner may settle |
  | t2 | `smoke/two` | #20 | filed with `--title` |
  | t3 | `smoke/three` | #21 | used for the grace, pane-close, rewind, open and move checks |
  | t4 | `smoke/four` | #22 | `--depends-on t1` |

  - PRs #23 (t2), #24 (t1) and #25 (t4) merged.
- **Abort probe:** `hpipe-smoke-dummy-…-abort-probe-7amt`, a separate throwaway local repo, started and aborted only to check N9's `aborted from` line.
- **Stall thresholds:** a temporary `config.env` set `TASK_STALL_MINUTES=10` and `STALL_MINUTES=5`.
  - It existed only while the supervisor booted, then was removed.
  - The config dir is empty again.
- **Evidence:** kept in the session scratchpad (`r3/out/`, not committed).
  - `cap/*.log`: pane snapshots every 4s.
  - `status.log`: `hpipe status` every 5s.
  - `agentpoll.log`: agent status every 2s.
  - `n4watch-t1.log` and `n4watch-t4.log`: the input box plus the ledger phase, polled every 0.05–0.2s.
  - `ledger/`, `history-utc.txt` (UTC times), `plugin-log.json` and `supervisor.pipesmoke3.crash.log`.

**Verdict: pass.** Eight of N1–N9 pass outright. N4 passes on its main assertion; I could not create its secondary case, which is stuck input typed beside a pasted answer that is still being held. The run-1 and run-2 behaviours I spot-checked still hold. There are no major new findings: two minor ones (M1, M2) and one environment note (M3).

## N1–N9 re-verification

| # | Run-2 finding | Live evidence (v1.5.19) | Result |
|---|---|---|---|
| N1 | Registration-time dispatch path omits `agent start` | `hpipe task` for t1 and t2 printed the lines below. The orchestrator started both workers with the flag. t4's supervisor `Dispatch t4` prompt carried the same block. | **PASS** |
| N2 | Empty batch-context heading | `hpipe brief --task t1 \| grep -c "Batch context"` returns `0` for a task with no `--notes` | **PASS** |
| N3 | Unstarted task flagged immediately, with no worktree step | t3 was dispatched at registration at 08:30:4x. `hpipe status` listed nothing for it under `waiting on you:` for 5 minutes. At 08:35:4x it listed `YOUR move: no worktree and no agent — herdr worktree create … --base <commit> (the commit on the base: line hpipe show --task t3 prints …), run the repo's bootstrap…, then herdr agent start … -- --dangerously-skip-permissions, then hpipe dispatch --task t3 …`. | **PASS** (see M1 on the `dispatch under way` wording) |
| N4 | Phase reset before the long answer was submitted | Box-level watch. t1 d1: `08:32:40.3 box='[Pasted text #2 +30 lines]'`, `40.6 box` no longer holds the paste, phase `→ research` at `08:32:41.7`. t4 d1: `08:59:47.0 [Pasted text #3 +30 lines]`, paste still there at `48.0`, gone by `48.3`, phase `→ spec` at `08:59:49.5`, and the `# Decision answered — resume spec` block is in the pane. In both cases the phase moved only after the paste left the box. | **PASS** (the "typing beside a held paste" case could not be created: see note 1) |
| N5 | A verdict written before `decide` is stranded | t2: spec-review verdict written 08:33:24, `hpipe decide` at 08:33:45, answer delivered and the phase back at 08:33:59, `spec-review→plan cleared` at **08:34:09**. The verdict was not rewritten (mtime still 08:33:24) and no stall probe was involved. | **PASS** |
| N6 | `workspace_id` goes stale | `pane close w5:p1` (last pane) at 08:37:06 → plugin log `pane.closed` and `workspace.closed`, both 08:37:06 → `hpipe show`: `workspace: none`, `pane: none (last: w5:p1)`, `failed`. The rewind printed the open-first sequence (`herdr worktree open --cwd … --branch smoke/three`; `create … --base <commit from hpipe show>` only on `worktree_not_found`; `agent start … --dangerously-skip-permissions`; `dispatch --task`), and status listed the same line at once. `worktree open` → `workspace: w6`. `pane move w6:p1 --new-tab --workspace w2` → `workspace.closed` and `pane.moved` at 08:37:39 → `workspace: none`, `pane: w2:p4`, phase kept (`research`, working). | **PASS** |
| N7 | Closing the workspace or pane in `merge` leads to `orphaned` | **Workspace close:** t2 at 08:40:05 (plugin log `workspace.closed`) → `workspace: none`, phase `merge` kept. It was merged with `gh pr merge 23 --squash --delete-branch`. gh exited 1 because it could not delete the local branch (checked out in the worktree), so the orchestrator deleted the remote with `git push origin --delete smoke/two`. Teardown at 08:40:45 read `teardown→done worktree removed` with no remote branch left, which exercises the `refs/pull/<n>/head` path. The checkout was gone. The local `smoke/two` branch stayed, because `git branch -d` refuses a squash-merged branch, as the runbook allows. **Pane close:** t1 `pane close w3:p1` in `merge` at 08:44:34 (`pane.closed` and `workspace.closed`) → merged → 08:45:00 `teardown→done worktree removed`. The dependent t4 went `queued→research gate opened` in the same second, never `blocked-on-failure`. **Dirty variant:** t4 had `untracked-smoke-note.txt` in its checkout, then `workspace close w7` in `merge` → 09:07:39 `teardown→done worktree kept: /Volumes/stein/.herdr/worktrees/hpipe-smoke/smoke-four (modified or untracked files)`. The file survived (`keep me`). No task was ever called a dead end. | **PASS** |
| N8 | Recovery advice used `--base main` | Every recovery line says `--base <commit>`, taken from `hpipe show --task t3`, which printed `base: abdba4f… (origin/main as just fetched)`. The same text appears in the rewind output and in status. | **PASS** |
| N9 | A finished run nags | The finished run shows `ended: done t1, t2, t4 · failed t3`, then `ℹ t3 [failed] smoke/three — hpipe show --task t3 --run …`, and nothing under `waiting on you:`. The aborted run shows `aborted from intake — hpipe resume hpipe-smoke-dummy-…-7amt puts it back`. | **PASS** |

The N1 dispatch block, verbatim from `hpipe task` for t1:
```
dispatch, in order:
    herdr worktree create --cwd '<repo>' --branch smoke/one --base abdba4f8ece1a8433d439d0b6ec27d83ad29c0cf
    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)
    herdr agent start <name> --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions
    hpipe dispatch --task t1 --pane <.result.root_pane.pane_id>
```

**Note 1: N4, typing beside a held paste.** A watcher polled the worker's box every 0.05s and typed ` human typing beside` the moment `[Pasted text …]` appeared. In both attempts the paste was submitted before the typed text reached the box: it sat about 0.3s for t1 and about 1.3s for t4. The typed text therefore landed in an empty box after submission.
- The answer was delivered intact, and the `Decision answered` block does not contain the typed text.
- The typed text then held the *next* phase prompt, with `⚠ stuck input in w3:p1 …` and `⚠ stuck input in w7:p1 …`. It was never cleared by the supervisor, and `input box … is clear again; delivering to it` followed within a tick of my `ctrl+c`.
- I could not produce a live state where the paste is held *and* human text sits beside it.

## Per-section results

### Setup / §1
| Step | Expected | Observed | Result |
|---|---|---|---|
| Boot | one `pipeline` workspace, one supervisor pane | `w1:p2`; log `supervisor up — session pipesmoke3` | PASS |
| Malformed `--files` / orphan `--title` | exit 1; nothing registered or filed | exact messages; `a=1`, `b=1`; `gh issue list --search "smoke orphan"` empty | PASS |
| Registrations | `task_id`, `issue: #20 (filed)`, `files:`, `bootstrap:`, `base:`, `dispatch, in order:`; t4 queued | yes (N1) | PASS |
| #89 pause between `agent start` and dispatch | "not handed the brief"; `agent get` never reads `working` | `YOUR move: its agent in w3:p1 has not been handed the brief — hpipe dispatch --task t1 --pane w3:p1`; `agent_status: idle, interactive_ready: true` | PASS |
| `dispatch --task` | `brief … delivered` | `brief for t1 delivered to w3:p1; the worker has picked it up` (and the same for t2) | PASS |
| Grace, and `dispatch under way` in status | status reads `dispatch under way — …` during the grace | nothing listed during the grace, but the `dispatch under way` text never appears in `hpipe status` | PASS / **M1** |
| Unbriefed agent, pane close, rewind, open, move | runbook | see N6; `pane.closed`, `workspace.closed`, `pane.moved` and `worktree.opened` all reached the plugin log | PASS |
| Dependent dispatch (path 2) | `base:` is the fresh merge commit | `Dispatch t4` prompt: `base: 50fb905… (origin/main as just fetched)`, which equals PR #24's merge commit. Local main was stale (`abdba4f`). `merge-base --is-ancestor 50fb905 HEAD` → 0. The block includes the flag. | PASS |

### §2 / §3
| Step | Observed | Result |
|---|---|---|
| Digests | `[a → b]` arrow; every move clause names what it waits for (`worker's move: waiting for its spec artifact`, `YOUR move: waiting for PR #24 to be merged`); no bare moves | PASS |
| Files lock | `⚠ t1 blocked on files held by t2 (merge) — waiting for it to finish`; t1 was released only after t2 `done` | PASS (not re-forced; full §3 passed in run 2) |
| Plans widen only onto test files | supervisor log: `t1 … plan widened files by test/greet.test.ts` | PASS |
| Stall probe for a parked decision | 08:56 probe for t4 `blocked-on-decision`: "waiting for an answer to the open decision … standing nudge — not escalated automatically" | PASS |

### §4
| Step | Observed | Result |
|---|---|---|
| 4b escalation to the human | t1 d1 (the #19 body says only the owner may decide): the orchestrator brought me the question and "bare letters ('AL', which I recommend) or dotted ('A.L.')". My answer was recorded `--by human` | PASS |
| 4a answered from the repo | t2 d1 and t4 d1 were answered `--by orchestrator` | PASS |
| Status while a decision is open | `⚠ t1 blocked on an open decision (0m): …`; `YOUR move: waiting for an answer to the open decision` | PASS |
| N5 and N4 | see the table | PASS |
| 4d.1–2: dead orchestrator, then catch-up | `/exit` at 08:38:11. Status showed `⚠ orchestrator pane w2:p1 has no live agent …` and `⚠ 1 prompt for the orchestrator undelivered for 0m (pane w2:p1 has no live agent; 4 failed attempts, last agent_not_found)`. On restart came `— catch-up`, then the held `Ready to merge — smoke/two (#20), PR #23`. Log: `recovered after 5 failed attempt(s)` | PASS |
| 4d.4: human text in the box holds the send and is never cleared | worker boxes `w3:p1` and `w7:p1`: `⚠ stuck input in <pane>: 1 prompt for tN's worker held …`, never cleared by the supervisor, released within a tick of my `ctrl+c` | PASS |
| Idle-with-nothing while a prompt is held | while t1's spec prompt was held by stuck input, status also said `YOUR move: worker idle with nothing at …/specs/…issue-19-design.md` | **M2** |

### §5 / §6
| Step | Observed | Result |
|---|---|---|
| Teardown | t1 and t2: `worktree removed`; t4: `worktree kept` (dirty) | PASS |
| branch-review → done | 09:08 run `[done]`, with the `ended:` summary | PASS |
| `plugin_command_limit_reached` | 0; no failed hook runs | PASS |
| Supervisor kill and reopen | killed → reopen → exactly one supervisor pane (`w1:p3`); log `closed dead supervisor panes: w1:p2; their last output is in …crash.log`; crash log 1726 bytes | PASS |

## New findings

**M1: `dispatch under way — …` is never visible.** *Severity: minor, a runbook/behaviour mismatch.*
- The runbook (#120) says that, during the grace, `hpipe status` reads `dispatch under way — …` for the task.
- In fact `moveFor` returns it as a `notYours` clause (`src/lib/status.ts:150`). Status task lines never print clauses, and only `waiting on you:` entries do, so the text appears nowhere.
- I grepped every 5-second status snapshot and every orchestrator capture for "under way": 0 hits.
- Either print the clause on the task line, or change the runbook text.

**M2: a worker whose phase prompt is held by stuck input is also flagged as idle with nothing at its artifact path.** *Severity: minor.*
- At 08:33, t1 had just entered `spec`, and its spec prompt was held by human text in `w3:p1`.
- Status listed both `⚠ stuck input in w3:p1: 1 prompt for t1's worker held 0m …` and `t1 … [spec 0m] — YOUR move: worker idle with nothing at …/2026-09-25-issue-19-design.md (its branch added no document to adopt)`.
- The second line misdirects: the worker never received the spec prompt. The #23 idle check could skip tasks that have an undelivered outbox prompt.

**M3 (environment, not the plugin): Claude safeguard errors in the orchestrator.**
- After I asked for a "deliberately long answer for a delivery test", the orchestrator's turns failed with `API Error: … safeguards flagged this message … [reasoning_extraction]`.
- Two fresh orchestrator sessions reading the same instruction file hit the same error.
- I rewrote the instruction to pass a pre-written answer file, and the fourth orchestrator worked.
- The decision stayed open, with a correct standing-nudge probe, for about 13 minutes. That is a harness artifact, not a plugin issue.

### Observations
- `gh pr merge --delete-branch` exits 1 when the local branch is checked out in a pipeline worktree, although the merge itself succeeds. An orchestrator following the merge prompt could misread that exit code.
- The merge prompt does not suggest `--delete-branch`, so this only arises when asked for.
- Runbook §1's "unstarted-worker check" after `worktree create` was not repeated this run. It passed in run 2; only the grace and no-worktree path was re-checked.
- The live §3 collision was not re-forced; it passed in full in run 2, and the holder line was seen again here.
- Wall clock: about 42 minutes.

## Teardown
- The `pipesmoke3` server is stopped and the session deleted.
- Its plugin state is removed: runs, queue, orchestrators, supervisor pid and crash log, workspace id, delivery file. Copies are in `r3/out/`.
- `config.env` is removed.
- In hpipe-smoke:
  - Issue #21 (t3) is closed; #19, #20 and #22 were closed by their PRs.
  - No open issues or PRs.
  - All `smoke/*` branches are deleted, local and remote.
  - The kept `smoke-four` and leftover `smoke-three` worktrees are force-removed, and the untracked branch-review file deleted.
  - The checkout is clean on main at `09031bd`.
- The throwaway abort-probe repo is deleted.
- Only the `default` session's supervisor is still running. No other session was touched.

## Filed

| Finding | Issue |
|---|---|
| M1 | #135 |
| M2 | #136 |
| M3 | not filed — environment (Claude safeguard error in the orchestrator), not the plugin |
