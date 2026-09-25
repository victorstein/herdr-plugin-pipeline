# Live smoke run 2: herdr pipeline plugin v1.5.13

- **Date:** 2026-09-24 21:33 → 22:30 CST (the 2026-09-25 UTC day)
- **Plugin:** stein.pipeline **v1.5.13**, installed globally from GitHub (commit `35b9233`). herdr 0.9.0, Claude Code 2.1.281.
- **Runbook:** `test/integration/smoke.md` at origin/main `35b9233`
- **Session:** `pipesmoke2`, fresh. **Target repo:** `victorstein/hpipe-smoke`, pulled to `0aed11c` before the run.
- **Runs:**
  - `hpipe-smoke-20260925-smoke-batch-2-1jwe`, the full runbook:
    - t1 `smoke/one` #8: `shout()`, carrying a decision only the owner may settle.
    - t2 `smoke/two` #9: filed through `--title`.
    - t3 `smoke/three` #10: the agentless, unbriefed and closed-pane task.
    - t4 `smoke/four` #11: `--depends-on t1`.
    - PRs #12, #14 and #13 merged.
  - `hpipe-smoke-20260925-smoke-collide-47nx`, a short second run to observe §3, because the first run's collision was masked by N5.
    - c-one #15 and c-two #16. PRs #18 and #17 merged.
- **Stall thresholds:** a temporary `config.env` set `TASK_STALL_MINUTES=10` and `STALL_MINUTES=5`.
  - It existed only while the supervisor booted, and again for the §6 reopen.
  - It was removed after each boot, so the config directory is empty again.
- **Evidence** was kept in the session scratchpad (`r2/out/`, not committed):
  - `cap/*.log`: pane snapshots every 4s.
  - `status.log`: `hpipe status` every 5s.
  - `agentpoll.log`: agent status and artifacts every 2s.
  - `decpoll-t1.log`, `suggestions2.log` and the `ansi-*.raw` box samples.
  - `ledger/`, `history*.txt`, `supervisor.pipesmoke2.crash.log` and `plugin-log.json`.

**Verdict: every one of F1–F14 is fixed, or covered by a changed runbook, except F10, which is only partly fixed.** Both runs finished `done`, with all five PRs merged and their issues closed.

The live-only checks all passed:
- herdr delivers `pane.closed`, `pane.moved` and `worktree.opened` to the plugin's hooks.
- A dependent task is cut from a freshly fetched base commit.
- A rewind prompts the owner of the phase.
- Held deliveries show in `hpipe status`.
- A catch-up digest arrives when the orchestrator recovers.
- A human draft in the input box holds the send and is never cleared.
- Reopening the supervisor leaves exactly one supervisor pane.

The run found **9 new findings.** Two are worth fixing first:
- **N5:** answering a decision can strand a task that already wrote its verdict.
- **N7:** a task whose pane was closed in `merge` ends `orphaned`, leaving its worktree on disk.

## F1–F14 re-verification

| # | Original finding | Re-test | Result |
|---|---|---|---|
| F1 | `pane close` never fails the task | `pane close w5:p1` at 21:50:03. `plugin log`: `pane.closed succeeded 21:50:03`. t3 → `failed` ("pane exited with no PR"), `agent: unknown`, `pane: none (last: w5:p1)`. Closing the **moved** pane `w2:p4` also failed t3, at 21:52:01. `pane close` in `merge`, and `workspace close w6` in `merge`, both kept the phase and released the pane | **PASS** (see N6, N7) |
| F2 | dependent task cut from stale local main | The t4 dispatch prompt carried `base: 3a96d6484b… (origin/main as just fetched)`, which is PR #12's merge commit. Local main was still `0aed11c`. `merge-base --is-ancestor 3a96d64 HEAD` → 0. An unpushed dispatched branch has no upstream: `smoke/three` → `fatal: no upstream configured`. `smoke/four` tracked `origin/smoke/four` only after the worker's `git push -u origin HEAD`, which the brief tells it to run | **PASS** |
| F3 | rewind sends no prompt | `rewind … implement --task t3`: "its prompt is queued for t3's worker … sent on their own once herdr detects the agent". After a bare `agent start`, one message arrived: brief `---` `# Implement — smoke/three (#10)`. `rewind … pr-review-intent --task t4` printed "next verdict → …intent-1.md; its prompt is queued for w6:p1". It was held by my draft (stuck input) and delivered within a tick once I cleared the box | **PASS** |
| F4 | false "idle with nothing at" before the brief | Between `agent start` and `dispatch --task`: `t1 [research 0m] agent:idle — YOUR move: its agent in w3:p1 has not been handed the brief — hpipe dispatch --task t1 --pane w3:p1`. `agent get` read `idle` (`interactive_ready: true`), never `working`. t3 was left unbriefed for 5 min after its bind (21:43:24). The probe arrived in the **orchestrator** pane: "The agent in w5:p1 is running but was never handed the brief … hpipe dispatch --task t3 --pane w5:p1". The worker pane got 0 probes | **PASS** |
| F5 | dead orchestrator invisible in status | Right after `/exit` (21:53:22): `⚠ orchestrator pane w2:p1 has no live agent — start Claude in it, or run the plugin's "claim" action…`. Once t4's decision was owed: `⚠ 1 decision for the orchestrator undelivered for 0m (pane w2:p1 has no live agent; 1 failed attempt, last agent_not_found)`, and the attempt count climbed to 4. The log line `delivery to w2:p1 failed (agent_not_found)` appeared **once** | **PASS** |
| F6 | dead-window digests lost | On restart (21:55:18) the held decision prompt arrived, then `[pipeline] run … — catch-up` listing t1–t4 with phase, age and whose move. The log then read `delivery to w2:p1 recovered after 5 failed attempt(s)` | **PASS** |
| F7 | "status lists it" but status doesn't | Not reproducible as written. A closed pane now fails the task, or releases it in `merge`/`close`, so no stall probe is ever held for a gone pane. The status lines that *are* reachable all showed (F5, F8) | **NOT REACHABLE** |
| F8 | prompts submitted over a human draft | See §4d.4 below. The orchestrator draft and the worker draft each held the send, with `⚠ stuck input in <pane>: 1 decision/prompt … held`. Neither was ever cleared: both drafts were intact 30–40 s later. Both released within a tick of my clearing the box. A greyed suggestion held nothing | **PASS** |
| F9 | decision prompt lacks footer | The runbook now says the prompt arrives alone. Observed exactly that, followed by a digest event line `[blocked-on-decision 0m] … — YOUR move: waiting for an answer to the open decision` | **PASS** (doc) |
| F10 | rewound task with no worktree invisible / wrong advice | After `pane close` removed w5, `rewind research` still recorded `workspace: w5`. The advice was "check `herdr pane list --workspace w5` … `agent start --pane <root pane>`", **not** the open-first line. `worktree open` fired `worktree.opened` (21:50:25) but did **not** rebind. Only after `hpipe forget w5` did status show `YOUR move: no worktree and no agent — herdr worktree open --cwd … --branch smoke/three; if that answers worktree_not_found … create … then agent start … then dispatch --task`. A second `worktree open` then bound the task through `worktree.opened` (`workspace: w7`) | **PARTIAL → N6** |
| F11 | bare "YOUR move" | No bare `YOUR move` or `worker's move` in any digest, status or footer. Examples: `YOUR move: waiting for PR #14 to be merged`, `worker's move: waiting for its review verdict`, `waiting for an answer to the open decision` | **PASS** |
| F12 | plans widen onto docs/superpowers/ | The supervisor logged only `plan widened files by test/greet.test.ts` and `by test/config.test.ts`, never `docs/superpowers/` | **PASS** |
| F13 | orchestrator never escalated | For t1 d1 (the #8 body says only the owner may decide), the orchestrator refused to answer. It brought the question, the worker's recommendation, its own read and "A (recommended) / B" to me. It recorded my answer `--by human` (ledger `answered_by: "human"`). t2 d1 and t4 d1 were settled `--by orchestrator` from their issue text, correctly | **PASS** |
| F14 | dead supervisor pane left beside the new one | Killed at 22:10:11 → the pane showed `supervisor exited`. On reopen the new supervisor logged `closed dead supervisor panes: w1:p2; their last output is in …/supervisor.pipesmoke2.crash.log`. The crash log was 2735 bytes and ends with the `supervisor exited` tail. `pane list --workspace w1` showed only `w1:p3`. Invoking the action again printed `the supervisor is already running (pid 1483); nothing to reopen` | **PASS** |

**Tally:** 12 PASS, 1 PARTIAL (F10), 1 NOT REACHABLE (F7).

## Per-section results

### Setup
| Step | Expected | Observed | Result |
|---|---|---|---|
| Plugin | v1.5.13 listed | `stein.pipeline … [github:…@v1.5.13]`; hooks include `worktree.opened`, `pane.closed`, `pane.moved` | PASS |
| Boot | one `pipeline` workspace and one supervisor pane | w1 / `w1:p2`; log `supervisor up — session pipesmoke2` | PASS |
| In-pane sanity | session env set | `pipesmoke2 / …/sessions/pipesmoke2/herdr.sock` | PASS |

### §1
| Step | Expected | Observed | Result |
|---|---|---|---|
| `hpipe start` | intake prompt, `[intake]`, `orchestrator:` line | as expected | PASS |
| malformed `--files` | exit 1 with the suggestion | exact text, exit 1 | PASS |
| `--title … --surface nope` | exit 1, no issue filed | exact text, exit 1; `gh issue list --search "smoke orphan"` empty | PASS |
| registrations | `task_id`, `issue: #9 (filed)`, `files:`, `bootstrap:`, `base: <sha> (origin/main as just fetched)`; t4 `queued: waiting on t1` | exactly | PASS |
| worktree + `agent start` | one pane before and after | 1/1 for w3, w4 | PASS |
| `dispatch --task` | `brief for tN delivered` | `brief for t1 delivered to w3:p1; the worker has picked it up` | PASS |
| #89 pause | "not handed the brief" line, never `working` | see F4 | PASS |
| registration-time dispatch path | orchestrator starts workers as `dispatch.md` says | the `hpipe task` header carries no `agent start` line, so the orchestrator started both workers **without** `--dangerously-skip-permissions` (it noticed only when the dispatch prompt arrived after `--done`) | **N1** |
| brief content | — | `Batch context the public issue does not carry:` is rendered with nothing after it when `--notes` is absent | **N2** |
| dispatch → execute | `[execute]` once every dispatched task has a worktree | 21:37:36, right after t3's worktree was created | PASS |
| unstarted check (#12) | nothing flagged for 5 min, then the "no agent detected" line and footer; orchestrator probe | t3 was flagged **at once**, even before any worktree existed: `YOUR move: no agent has been started for it yet — start one, then hpipe dispatch --task t3`, with no worktree step. After the 5-min grace it switched to `no agent detected in its worktree — check herdr pane list --workspace w5…`. The orchestrator probe (21:43) carried that advice | PASS, doc mismatch **N3** |
| re-arm on bind | probes reset at the bind | `probes 0`, `last_probe_at` = bind 21:43:24 | PASS |
| pane close → failed; rewind; open-first; `worktree.opened` binds | see F1 and F10 | F1 PASS; F10 partial | **N6** |
| rewind into implement, then `agent start` | one message: brief, then the implement prompt | `---` then `# Implement — smoke/three (#10)`, delivered on its own after `agent start`. The brief portion had scrolled off, so "without its research section" was not visible | PASS (partial evidence) |
| pane move | stays in phase, new pane id | `pane move w7:p1 --new-tab --workspace w2` → `plugin log pane.moved`; `hpipe show` → `pane: w2:p4`, phase unchanged. `workspace:` still read `w7`, now closed | PASS (N6) |
| close pane in merge/close | phase kept, pane released, dependent not `blocked-on-failure` | t2 `pane close` and t4 `workspace close` in `merge`: phase kept, `pane: none (last: …)`. No dependent existed to check. Both later ended **`orphaned`** | PASS / **N7** |

### §2
| Step | Expected | Observed | Result |
|---|---|---|---|
| fan-out at `spec` | one prompt per pane, its own issue and path | 21:37:17 / 21:37:29. w3: `❯ Write the spec — smoke/one (#8)` → `…/specs/2026-09-25-issue-8-design.md`. w4: `❯ Write the spec — smoke/two (#9)` → `…issue-9-design.md`. No `---` join, no foreign issue number | PASS |
| digest shape and `→` | box with arrow, whose-move clause | `- t2 smoke/two (#9) [spec → spec-review] agent:done — worker's move: waiting for its review verdict` | PASS |
| footer = status | same clause in both | identical in every case (t1, t3, t2/t4 merge) | PASS |
| last-mile probe | clause names what it waits for; never escalated | t2 `merge` at 22:08: "waiting for you to merge PR #14 … standing nudge — not escalated automatically" | PASS |
| no `dropping prompt … no pane` | none | none | PASS |
| uncommitted-work line | — | not re-exercised (PASS in run 1; unchanged) | — |

### §3 (second run, `smoke collide`)
| Step | Expected | Observed | Result |
|---|---|---|---|
| one leaves `blocked-on-files` | exactly one | t2 (c-two) reached `blocked-on-files` 22:19:09 → `implement` 22:19:11. t1 arrived 22:19:24 and was held | PASS |
| status line tracks the holder | `⚠ t1 blocked on files held by t2 (<phase>) — waiting for it to finish` | seen with `implement`, `pr-review-intent`, `pr-review-quality`, `ci`, `merge`, `close` | PASS |
| released only at `done` | not at merge | t2 `merge→close` 22:22:26, `teardown→done` 22:22:30. t1 `→ implement` at 22:22:30 | PASS |
| run 1 | — | no collision: t1 passed straight through at 21:42:44 while t2 was stuck (N5) | — |

### §4
| Step | Expected | Observed | Result |
|---|---|---|---|
| 4a answered by the orchestrator | status `⚠ … open decision`; prompt; orchestrator answers; phase moves only after the answer lands | t2 d1 and t4 d1 were answered `--by orchestrator` from the issue text, and the status line appeared first. Ordering for t1 d1: the ledger reset the phase at 21:38:47. The capture read about 5 s later still showed the answer as `❯ [Pasted text #3 +11 lines]` **unsubmitted** in the box. It had been submitted by the 21:38:57 capture | PASS, ordering suspect **N4** |
| 4b escalated to the human | orchestrator brings question, recommendation and a named option; `--by human` | see F13 | PASS |
| second decide on an open decision | rejected | not exercised | — |
| decision after the phase's artifact is written | — | task stranded; see **N5** | **N5** |
| 4c ladder | — | orchestrator probes for t3, the unbriefed probe, and t2's `plan-review` probe (21:52, which recovered N5) all arrived on schedule. No escalation this run | PASS |
| 4d.1 dead orchestrator | see F5 | | PASS |
| 4d.2 recovery | see F6 | | PASS |
| 4d.3 gone pane holds a probe | — | not reachable (F7) | NOT REACHABLE |
| 4d.4 orchestrator draft | held, never cleared, status line, released on clear | typed draft at 21:40:13; d1 prompt due 21:41:10. Status: `⚠ stuck input in w2:p1: 1 decision for the orchestrator held 0m…`; log `stuck input in w2:p1…`. Draft still intact at 21:42. I pressed ctrl+c at 21:42:04, the log read `input box of w2:p1 is clear again; delivering to it`, and the decision plus catch-up arrived within about 5 s | PASS |
| 4d.4 worker draft | same | typed in `w6:p1` at 21:58:0x, then `rewind … pr-review-intent`. Status `⚠ stuck input in w6:p1: 1 prompt for t4's worker held …`; draft intact 45 s later. Cleared at 21:58:58 and the prompt was delivered | PASS |
| 4d.4 greyed suggestion holds nothing | no hold | suggestions sat in `w2:p1` at 22:11:22 and 22:11:54 while the branch-review prompt and digests were delivered, with no `stuck input` | PASS |
| 4d.4 ansi samples | typed draft without `^[[2m`; paste placeholder visible; suggestion faint | see the samples below | PASS (paste sample not obtained) |
| 4d.5 usage limit | — | the account reached 93% of its 5-hour limit and reset at 22:10; no limit hit | NOT TESTED |

**`pane read --format ansi | cat -v` samples** (the `❯` shows as `�M-^]�`, mangled by `cat -v`):
- Typed draft, orchestrator: `�M-^]� orchestrator draft typed by the human^M`, with no `^[[2m`.
- Typed draft, worker: `�M-^]� worker draft typed by the human^M`, with no `^[[2m`.
- Greyed suggestion: `❯\xa0\x1b[0m\x1b[2mok, keep driving\x1b[0m\r`. The suggestion is faint (`^[[2m`), as the parser assumes.
- Paste placeholder: I could not produce one. `pane send-text` with 15 lines rendered inline (`pasted line 1^M / pasted line 2^M …`) and never collapsed.
  - The only placeholder seen was the supervisor's own send, `❯ [Pasted text #3 +11 lines]`, in a plain-text capture.

### §5
| Step | Expected | Observed | Result |
|---|---|---|---|
| status during review subagents | never idle/done without a verdict | t4 intent pass 1 (backgrounded agent plus Monitor): `working` from 21:59:05 until the verdict at 21:59:42. t1 intent: `working` 21:43:54 → verdict 21:44:46. The only idle samples without a verdict fall between phases, before the prompt landed | PASS |

### §6
| Step | Expected | Observed | Result |
|---|---|---|---|
| tasks reach `done` | teardown removes worktrees | t1, c-one and c-two: `teardown→done worktree removed`. t2 and t4 went to **`orphaned`** ("workspace gone but checkout left") because I had closed their panes or workspace in `merge` | **N7** |
| branch-review | clears | run 1 done at 22:12:57, run 2 at 22:27:31, both CLEAR | PASS |
| `plugin_command_limit_reached` | 0 | 0; no failed hook runs | PASS |
| supervisor kill and reopen | see F14 | | PASS |
| `Closes #n` | issues auto-close | #8, #9, #11, #15 and #16 closed by their PRs | PASS |

## New findings

**N5: answering a decision strands a task whose verdict is already written.** *Severity: major.*

Repro (twice):
1. A worker writes its review verdict, then calls `hpipe decide` before the supervisor clears the phase:
   - t2: plan-review verdict at 21:40:52, decide at 21:41:10.
   - t4: intent verdict at 21:53:43, decide at 21:54:00.
2. The answer lands, and the task returns to its `decision_from` with `phase_entered_at` reset:
   - t2: reset to 21:42:15.
   - t4: reset to 21:55:33.
3. The verdict file is now older than the phase entry, fails the freshness check, and the phase never clears.

Observed:
- The worker sat idle.
- `hpipe status` showed `t2 smoke/two #9 [plan-review 7m] done`, with nothing under `waiting on you:`.
- The digest line claimed `worker's move: waiting for its review verdict` although the verdict existed.
- It recovered only through the stall probe: t2 re-reviewed at 21:52 and cleared at 21:54:13. That is 45 minutes at the default thresholds.
- t4 needed a manual `rewind`.

Expected: resuming from a decision keeps an artifact written before the decision, or the resume prompt tells the worker to rewrite it.

Suspect: `blocked-on-decision → decision_from` goes through `enterTaskPhase`, which resets `phase_entered_at`; the freshness check compares against it.

**N7: closing a task's pane or workspace while it is in `merge`/`close` ends in `orphaned`, and the worktree is left on disk.** *Severity: medium.*

- t2 had its pane closed in `merge`; t4 had its workspace closed in `merge`. Both then merged, and history reads `teardown→orphaned workspace gone but checkout left at /Volumes/stein/.herdr/worktrees/hpipe-smoke/smoke-two` (and the same for `smoke-four`).
- Status then lists both successfully merged tasks as `— dead end, needs a human`.
- Suspect: `src/supervisor/teardown.ts` removes by workspace only. It could fall back to `git worktree remove <checkout_path>`.

**N6: `workspace_id` goes stale when a workspace disappears through `pane close` or `pane move`.** *Severity: medium; it is why F10 is only partial.*

`pane close w5:p1` (the workspace's last pane) and `pane move w7:p1 --workspace w2` both left `hpipe show` reading `workspace: w5` / `w7` after those workspaces were gone. Consequences:
1. `rewind … research --task t3` printed and listed "check `herdr pane list --workspace w5` … `agent start … --pane <root pane>`", not the open-first advice.
2. `worktree open --branch smoke/three` fired `worktree.opened` (hook succeeded), but the task was **not** rebound until `hpipe forget w5`.
3. It feeds N7.

Suggest: clear `workspace_id` on `pane.closed`/`pane.moved` when the workspace has no panes left, or reconcile against `workspace list`.

**N4: the decision answer's phase reset may come before the text is actually submitted.** *Severity: medium; needs a focused re-measure.*
- For t1 d1, the ledger's `blocked-on-decision→spec` is stamped 21:38:47.
- `agent get` read `working` from about 21:38:49.
- The pane capture taken about 5 s later still showed the answer as an unsubmitted `❯ [Pasted text #3 +11 lines]` in the input box.
- It showed as submitted (`❯ Decision answered — resume spec`) by 21:38:57.

The worker did get it. But herdr's `--until working` confirmation appears to fire while Claude is still holding the paste, which is the ordering §4a.5 forbids. Evidence: `r2/out/cap/w3_p1.log` lines 2384–2440, and `r2/out/decpoll-t1.log`.

**N1: the registration-time dispatch path never shows the `agent start` command.** *Severity: minor.*
- `hpipe task` prints `task_id`/`files`/`bootstrap`/`base` and the brief, but not the `herdr agent start … -- --dangerously-skip-permissions` line.
- That line lives in the dispatch prompt, which arrives only after `dispatch --done`.
- The orchestrator therefore started both workers bare. It flagged this itself: "I started smoke-one and smoke-two without that flag, because this prompt arrived after I'd dispatched them. hpipe task's output doesn't include the start command."

**N2: the brief renders an empty `Batch context the public issue does not carry:` heading when no `--notes` is given.** *Severity: minor.* `hpipe brief --task t1`, line 18: the heading, then a blank line, then `## The loop`.

**N3: the unstarted-task flag has no grace and skips the worktree step.** *Severity: minor; doc mismatch.*
- A task dispatched at registration is listed immediately as `YOUR move: no agent has been started for it yet — start one, then hpipe dispatch --task t3 --pane <pane>`. This happened even before its worktree existed, and the advice never mentions `worktree create`.
- The runbook says nothing flags for the first five minutes after `worktree create`.

**N8: the open-first advice falls back to `herdr worktree create … --base main`.** *Severity: minor.* This contradicts the F2 rule, "cut from the `base:` commit, never a base you pick".

**N9: a finished run keeps nagging.** *Severity: minor.* After run 1 reached `[done]`, `hpipe status` kept listing its orphaned t2/t4 and failed t3 under `waiting on you: … dead end, needs a human` for as long as the session lived.

### Observations
- `this tick not saved (… changed on disk since it was read); its prompts are dropped and it is re-read next tick` still appears whenever a CLI write races a tick. No lost prompt was traced to it.
- Environment: agents inherited `CLAUDE_CODE_CHILD_SESSION`, so "Transcript saving is off"; not a plugin bug.
- `plugin log list` keeps only about the last 50 runs. The `pane.closed` (21:50:03, 21:52:01, 22:02:04), `pane.moved` (21:51:47) and `worktree.opened` (21:50:25, 21:50:45) runs were recorded as they happened, from `plugin log list` output at the time.
- Budget used: about 57 minutes of wall clock for both runs.

## Teardown
- The `pipesmoke2` server is stopped and the session deleted.
- Its plugin state is removed: `runs`, `queue`, `orchestrators`, the supervisor pid and crash log, the workspace id and delivery files. Copies are in `r2/out/`.
- `config.env` is removed, so the config directory is empty as before.
- In hpipe-smoke:
  - Issue #10 closed; every other smoke issue was closed by its PR.
  - No open PRs.
  - All `smoke/*` branches deleted, local and remote.
  - Worktrees `smoke-two`, `smoke-three` and `smoke-four` force-removed, and the untracked branch-review files deleted.
  - The checkout is clean on main.
- The only supervisor still running is the `default` session's (pid 4429, started Mon). No other session was touched.

## Filed

| Finding | Issue |
|---|---|
| N5 | #115 |
| N6, N7 | #116 |
| N4 | #117 |
| N1 | #118 |
| N2 | #119 |
| N3 | #120 |
| N8 | #121 |
| N9 | #122 |
