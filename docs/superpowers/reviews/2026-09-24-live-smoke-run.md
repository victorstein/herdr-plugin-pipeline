# Live smoke run — herdr pipeline plugin (issue #57)

- **Date:** 2026-09-24, 16:30 → ~18:20 CST
- **Plugin:** stein.pipeline **v1.5.5** (installed from GitHub, commit `96835cf`), herdr 0.9.0, Claude Code 2.1.281
- **Runbook:** `test/integration/smoke.md` @ origin/main `96835cf`
- **Session:** `pipesmoke` (fresh). **Target repo:** `victorstein/hpipe-smoke` (private throwaway)
- **Run:** `hpipe-smoke-20260924-smoke-batch-h0en`. Tasks: t1 `smoke/one` #1, t2 `smoke/two` #2 (filed by `--title`),
  t3 `smoke/three` #3 (the agentless/unstarted task), t4 `smoke/four` #4 (`--depends-on t1`, the supervisor-dispatch path).
  PRs #5 (t2), #6 (t1), #7 (t4) merged.
- **Stall thresholds shortened:** `config.env` with `TASK_STALL_MINUTES=10`, `STALL_MINUTES=5`, present only while the
  pipesmoke supervisor booted (config is global to all sessions and read once at supervisor start), then removed.
  Every "10 min" cadence below is the shortened `TASK_STALL_MINUTES`.
- **Layout:** w1 supervisor (`w1:p2`, later `w1:p3`), w2 orchestrator `w2:p1` + observation shell `w2:p2` + status logger `w2:p3`;
  workers t1 `w3:p1`, t2 `w4:p1`, t3 `w5:p1` then `w7:p1`, t4 `w6:p1`.
- Evidence captured: pane snapshots every 4s (`out/cap/*.log`), `hpipe status` every 10s (`out/status.log`), agent
  status + artifact listing every 2–3s (`out/agentpoll.log`), kept in the session scratchpad (not committed).

**Verdict:** the pipeline works end to end: three PRs merged, issues closed, worktrees torn down, the files gate, the
decision round trip, the stall ladder and escalation, delivery backoff, and supervisor restart all behaved as written.
It is **not clean**: 14 findings, three of them worth fixing before the next real batch (F1, F2, F3).

## Per-section results

### Setup / floor

| Step | Expected | Observed | Result |
|---|---|---|---|
| Plugin present | `stein.pipeline` in `plugin list`, no warnings | `stein.pipeline (Pipeline) enabled [github:…@v1.5.5]` | PASS |
| Session boot | one `pipeline` workspace, exactly one "Pipeline supervisor" pane | w1 `pipeline`, one pane `w1:p2`, log `supervisor up — session pipesmoke, tick 1000ms` | PASS |
| Sanity check in pane | `HERDR_SESSION` set | `pipesmoke / …/sessions/pipesmoke/herdr.sock` | PASS |
| Orchestrator start | agent ready | `agent start` → `agent_not_ready`: Claude's folder-trust dialog for the new repo path (the runbook's environment note). Accepted by hand. | env note |

### §1 Start, intake, dispatch

| Step | Expected | Observed | Result |
|---|---|---|---|
| `hpipe start "smoke batch"` | intake prompt in pane; status `supervisor: live`, `[intake]`, `orchestrator:` line | exactly that; `orchestrator: w2:p1` | PASS |
| Malformed `--files "src/lib src/lib/config.ts"` | exit 1, whitespace message, `→ --files src/lib,src/lib/config.ts`, nothing registered | exact text, exit 1, no task | PASS |
| `--title … --surface nope` | exit 1 `no agent definition at …/nope-dev.md`, no issue | exact, `gh issue list --search "smoke orphan"` empty | PASS |
| t1 via `gh issue create` + `--issue` | `task_id: t1`, `files: src/lib`, brief | `task_id: t1 · files: src/lib · bootstrap: .claude/pipeline-bootstrap`, then the brief | PASS |
| t2 via `--title/--body-file` | `issue: #<n2> (filed)` after `task_id: t2`; one issue; brief headed `smoke/two — issue #2` | `task_id: t2`, `issue: #2 (filed)`, `files: src/lib/config.ts`; one issue #2 | PASS |
| t4 `--depends-on t1` | `queued: waiting on t1` | `queued: waiting on t1` | PASS |
| `hpipe dispatch --done` | run leaves `[intake]` | `intake closed for …`; the dispatch prompt followed | PASS |
| `worktree create` + `agent start` adopts root pane | one pane before and after | 1/1 for w3 and w4 | PASS |
| `hpipe dispatch --task` | exit 0, `brief for t1 delivered`, brief submitted, not left in the box | `brief for t1 delivered to w3:p1; the worker has picked it up` (wording differs slightly from runbook), workers working | PASS |
| Binding | `agent_status` stops being `unknown` | `working` within a tick; `hpipe show` shows workspace, pane, checkout | PASS |
| dispatch → execute | `[execute]` once both bound | run stayed `[dispatch]` until 16:37:23, because t3 was dispatched at registration with no worktree yet (this run's ordering, not #22), then `[execute]` at once | PASS |
| #23 idle-with-nothing clause | only for a genuinely idle worker | fired for **every** worker in the gap between `agent start` and `dispatch --task` | **FINDING F4** |
| Unstarted worker (#12) — t3 `worktree create`, no agent | `agent get` → `agent_not_found`; pane with no `agent` field; quiet for 5 min | exactly; nothing flagged before 16:42 | PASS |
| … after the grace | status `waiting on you:` + digest footer, both `YOUR move: no agent detected in its worktree — check herdr pane list --workspace w5 …` | both, identical clauses (16:42–16:43) | PASS |
| … orchestrator probe after `STALL_MINUTES` | probe with the no-agent advice, not "nothing has appeared" | 16:42 `Still working? … phase research (t3)`, "No agent has been detected in this task's worktree (workspace w5)…", `probe 1 of 3` | PASS |
| … agent start + dispatch | flags go quiet; ladder re-arms (`probes 0`, anchor at bind) | 16:44:41: flag gone, ledger `probes:0`, `last_probe_at` = bind time | PASS |
| Kill the worker's pane (`herdr pane close`) | task → `failed`, `pane: none (last: …)` | **no `pane.exited` event**; task stayed `research`, `agent: working`, `pane: w5:p1` for 50 minutes | **FINDING F1** |
| … same, by exiting the shell (`/exit`, `exit`) | as above | `pane.exited` fired, `phase: failed`, `pane: none (last: w7:p1)` | PASS |
| `hpipe rewind … research --task t3` after `failed` | back as unstarted, not bound to the dead pane | `pane: none (last: w7:p1)` | PASS |
| … same after the `pane close` path | same | still bound to the closed `w5:p1` | FINDING F1 (consequence) |
| Bootstrap, path 1 (`hpipe task` header) | `bootstrap:` line; orchestrator runs it before `agent start` | `bootstrap: .claude/pipeline-bootstrap`; run in both checkouts, exit 0 (`No packages! Deleted empty lockfile`); no untracked files left | PASS |
| Bootstrap, path 2 (supervisor dispatch prompt, t4) | `bootstrap:` line in `Dispatch t4 …` prompt | present; orchestrator ran it | PASS, but see **F2** (stale base) |

### §2 Fan-out, digests, idle/uncommitted, last-mile probes

| Step | Expected | Observed | Result |
|---|---|---|---|
| Both workers at `spec` at once | each pane gets one prompt, its own issue and path; no cross-talk | both reached `spec` at 16:36 within seconds (research took ~1 min on these toy issues). The worker panes held only their own issue (#1 in w3, #2 in w4); no `---`-joined prompts, no foreign issue numbers in the captures. The first ~10 lines at the exact moment were not captured, because the capture loop started ~30s after | PASS (partial evidence) |
| Digest line shape | `tN branch (#n) [phase Nm]`/`[a → b]` + whose-move clause | e.g. `- t1 smoke/one (#1) [research → spec] agent:done — worker's move`; `[plan-review → blocked-on-files] … — nothing for you — the supervisor is driving` | PASS |
| **`→` arrow (#13)** | `[research → spec]`, not `[spec 0m]` | seen on every transition digest | PASS |
| `also waiting on you:` footer | lists silent tasks with the same clause as status | seen for t2/t1/t4 in `merge`, t3 unstarted; identical to status. For `merge` both render a bare `— YOUR move` with no clause | PASS, minor **F11** |
| Idle with uncommitted edit (t4 in implement) | status `YOUR move: worker idle with 1 uncommitted path (README.md) — have it commit and push`; gone once busy; no git-per-tick | exact text 16:58:08; gone after commit; 0 `git status` processes over 10 samples | PASS |
| Last-mile probe (#19), t4 parked in `merge` | probe every `TASK_STALL_MINUTES`, clause names what it waits for, never escalated | probes 17:22:49, (re-armed by a rewind) 17:34:48, 17:45:30, 17:55, 18:05 — text "waiting for you to merge PR #7 … This is a standing nudge — this phase is not escalated automatically"; never escalated | PASS |
| No `dropping prompt … no pane` | none | none | PASS |

### §3 `blocked-on-files`

| Step | Expected | Observed | Result |
|---|---|---|---|
| Exactly one leaves for `implement` | one, never both | t2 reached `blocked-on-files` first (16:39:4x) and went straight to `implement`; t1 arrived ~20s later, while t2 already held `src/lib/config.ts`, so `t1` never raced it. Runbook's "t1 should win" only applies when both wait on the same tick | PASS |
| Loser's status line | `⚠ t1 blocked on files held by t2 (implement) — waiting for it to finish` | exact; holder phase tracked `implement` → `pr-review-intent` → `merge` | PASS |
| Released only at `done` | not at merge | t2 `done` 16:44:0x → t1 `implement` the same tick; t1 was held through t2's `merge` and `close` | PASS |
| Times | — | t2 → implement 16:39:5x; t1 held ~4 min; t1 → implement 16:44:0x, while t2 was `done` | recorded |
| `plan widened files` | — | supervisor logged `t1 (smoke/one): plan widened files by test/greet.test.ts, docs/superpowers/`; every task's plan widens to `docs/superpowers/`, which would collide with any task declaring `docs` | **F12** |

### §4 Decisions, stall ladder, delivery

| Step | Expected | Observed | Result |
|---|---|---|---|
| 4a.1 `hpipe decide` from worker | task → `blocked-on-decision`, `decision_from` kept | d1 on t4 from `spec`, d2 from `plan`, d3 from `implement`, d4 from `pr-review-quality` | PASS |
| 4a.2 decision prompt + `also waiting on you:` footer in the same delivery | both | the decision prompt arrived **without** a footer; a separate digest followed with the task as an **event** line (`[blocked-on-decision 0m] agent:done — YOUR move`) | **FINDING F9** |
| 4a.3 status while open | `⚠ t4 blocked on an open decision (Nm): <question>` | exact | PASS |
| 4a.4 orchestrator answers from repo | `recorded answer … pending delivery`, still blocked | yes (`recorded answer to d1 on t4; pending delivery`) | PASS |
| 4a.5 ordering: pane shows answer before phase moves | phase reset is a consequence of the send | ledger: answer written 16:48:37.6, phase reset 16:48:39.1 ("decision d1 answered"); `# Decision answered — resume spec` block in the pane in the 16:48:40 capture. Too fast to sequence by eye with 4s captures; the ledger timing agrees with send-then-reset | PASS (timing evidence) |
| 4b escalation to the human, `--by human` | orchestrator brings a named recommendation to the human | **not exercised.** In all four decisions (including "which license, if any" in a repo with no LICENSE file) the orchestrator answered itself `--by orchestrator`, citing issue #4's scope ("No code changes", README-only). Its reasoning was defensible each time: it never handed over a bare question, and it named the license choice as the owner's call for a later issue. `--by human` never ran | NOT TESTED (see F13) |
| #26 verdict path survives decide→answer→resume and rewind | same reserved path before/after | `rewind … pr-review-quality --task t4` printed `next verdict → …/issue-4-pr-review-quality-1.md`; d4 decided, answered and resumed in that phase; path unchanged; the worker wrote quality-1 and the task cleared to `ci` → `merge` | PASS |
| 4c ladder cadence, escalation | probes every threshold; escalate after 3; `working` defers | t3 (dead pane): rungs 17:04:43, 17:14:44, 17:24:46, escalated at the 3rd; escalation prompt says "3 of them never reached the pane"; status `needs a human: <rewind research> resumes it, <rewind failed> abandons it` | PASS |
| 4c restart → no probe burst | one probe per record, not a burst | supervisor killed 17:37:42 and reopened; no probe for ~8 min until the next due rung | PASS |
| 4c probe-only rows never escalate | `merge` never escalated | see §2 last-mile | PASS |
| 4d.1 dead orchestrator, workers keep moving | task advances; log `delivery … failed (agent_not_found)` **once**; status `⚠ N prompts for the orchestrator undelivered` once a digest is owed | t4 went spec → spec-review → plan with the orchestrator dead (16:49–16:55); log line **once**; **no** `⚠ … undelivered` line at any point, even with decision d2 owed for 4+ min | **FINDING F5** |
| 4d.2 resume | held prompts arrive as one digest; `recovered`; status line gone | log `delivery to w2:p1 recovered after 7 failed attempt(s)` (5s…160s backoff, ~6.5 min: consistent). Only the **d2 decision prompt** arrived; the four transition events of the dead window were never delivered | **FINDING F6** |
| 4d.3 gone pane | log `pane <id> is gone; holding …` once; status names it; ladder climbs; nothing sent | log line once (16:54:42), and it says "`hpipe status` lists it", **but status never did**: t3 read `[research …] working` for 40 min. Ladder climbed and escalated on time; nothing sent | **FINDING F7** |
| 4d.4 stuck input box, worker | record | draft `human draft: do not send this yet` in t4's box; the 17:08:5x implement stall probe was submitted **with the draft prepended**; the worker read the whole message as an unsent draft and **ignored the probe**. No ctrl+c, as specified (no `agent_prompt_stalled`) | recorded, **F8** |
| 4d.4 draft in the orchestrator's box | draft left intact; status `stuck input in <pane>` | the d3 decision prompt was submitted with the draft prepended, the draft was consumed, and the orchestrator decided the decision was "a draft" and did not act until a later digest prompted it. No `stuck input` line. The send was never stalled, so the box check never ran | **FINDING F8** |
| 4d.4 "a rewind into its phase" triggers a prompt | prompt sent | `hpipe rewind … implement --task t4` (and later `… pr-review-quality`) sent **no** prompt to the worker. It sat idle until the next stall probe 10 min later | **FINDING F3** |
| 4d.5 usage limit | record code | the account reached 93% of its 5-hour limit, then the window reset mid-run. No limit was hit | NOT TESTED |

### §5 subagent / `agent_status`

| Step | Expected | Observed | Result |
|---|---|---|---|
| Pane status during review subagents | never `idle`/`done` while the verdict is missing | poll every 2s on t4 (`w6:p1`) through plan-review, pr-review-intent and pr-review-quality: `working` continuously until after each verdict file appeared (e.g. intent review working 17:10:34 → file 17:11:11 → `done` 17:11:35) | PASS (confirms 2026-09-16 result on Claude Code 2.1.281) |

### §6 Finish

| Step | Expected | Observed | Result |
|---|---|---|---|
| t1/t2/t4 through PR → ci → merge → close → teardown → done | all reach `done` | t2 16:44, t1 16:47, t4 (after the merge hold) — see teardown section | PASS |
| PR body `Closes #n` | real keyword | #5/#6/#7 carry `Closes #2/#1/#4`; issues auto-closed | PASS |
| teardown removes the worktree | removed | `smoke-two`, `smoke-one` gone after `done` | PASS |
| `plugin_command_limit_reached` | 0 | 0; no non-succeeded hook runs in `plugin log list` | PASS |
| Kill the supervisor | pane readable with `supervisor exited`; status `supervisor: none` | exactly; `hpipe status` gives the reopen command | PASS |
| Reopen via the plugin action | supervisor back | back (pid 59818) in a **new** pane `w1:p3`; the dead `w1:p2` stays, so there are now two "Pipeline supervisor" panes | minor **F14** |
| Run → `branch-review` → `done` | clears | t4 merged 18:07:04 → close 18:07:07 (issue #4 closed) → teardown → `done` 18:07:09 (worktree removed); run `execute → branch-review` 18:07:11 ("every task finished", t3 abandoned via `rewind … failed`); branch review written by the orchestrator, `VERDICT: CLEAR`; run `done` 18:08:22. The review file was left **untracked in the primary checkout**, which is harmless here | PASS |

### Resolver (#21)

| Step | Expected | Observed | Result |
|---|---|---|---|
| Ambiguity | fails, lists candidates | could not be reached: `hpipe start` refuses a second run for the same repo, and every command resolves by the cwd's repo. A second run in another repo resolved cleanly from its own cwd | NOT REACHABLE |
| Outside a repo | clear error | `hpipe: not inside a git repository — run it from the repo whose run you mean, or pass --run <run-id>` | PASS |
| `--run <id>` | works from anywhere | `hpipe show --task t1 --run <id>` from a non-repo dir worked | PASS |

## Findings

**F1 — `herdr pane close` on a worker pane never fails its task (no `pane.exited`).** *Severity: major.*
Repro: bind a worker (t3 → `w5:p1`, the workspace's only pane), then `herdr --session pipesmoke pane close w5:p1`.
Expected (§1): task → `failed`, `hpipe show` → `pane: none (last: w5:p1)`. Observed: `plugin log list` shows no
`pane.exited` hook run at all. herdr 0.9.0 does not emit it for an explicit close, even when the workspace closes with it.
The task stayed `research`, `agent: working` (stale), `pane: w5:p1` for 50 minutes. A later `rewind … research`
kept the dead binding. Exiting the pane's shell does emit `pane.exited`, and that path passed. Suspect: the plugin
subscribes only to `pane.exited` (`herdr-plugin.toml`, `src/hooks/pane-exited.ts`). Nothing reconciles bound panes
against `herdr pane list`, although the courier already knows the pane is gone (F7).

**F2 — The dispatch prompt cuts dependent tasks from a stale local `main`.** *Severity: major.*
`prompts/dispatch.md` and the supervisor's `Dispatch tN … worktree create --cwd <repo>` both say `--base main`. After
t1's PR merged on GitHub, t4 (`--depends-on t1`) was cut from the orchestrator's local `main`, still at the scaffold
commit `4123085` and missing t1's `farewell()`. The orchestrator caught it only because it happened to check. It
pulled, reset the branch to `1fb8a43` and re-ran the bootstrap. Its words: "any task that depends on something already
merged gets stale code unless someone pulls first". Suggested fix: `git fetch` plus `--base origin/<default>`, or have
the supervisor say so in the path-2 prompt.

**F3 — `hpipe rewind <run> <phase> --task <id>` does not prompt the worker.** *Severity: major.*
`rewind … implement --task t4` (16:58:55) printed `rewound t4 to implement; counters cleared` and sent nothing.
`rewind … pr-review-quality --task t4` (17:23:53) printed the fresh verdict path and also sent nothing. Phase prompts
are only produced by supervisor-made transitions (`advanceTasks`); a CLI rewind changes `phase` and `phase_entered_at`
without enqueueing. So "rewind resumes it" (escalation text, status' `needs a human:` clause, the recovery table) leaves
the worker idle until the next stall probe, a full `TASK_STALL_MINUTES` (45 by default). I prompted t4 by hand to
continue the review. Runbook §4d.4 assumes a rewind triggers a prompt.


**F4 — False `YOUR move: worker idle with nothing at <research path>` for every freshly started worker.** *Severity: minor, noisy.*
Between `herdr agent start` (agent idle) and `hpipe dispatch --task` (brief submitted), the supervisor sees an idle
worker in `research` with no note, and digests
`- t2 smoke/two (#2) [research 0m] agent:idle — YOUR move: worker idle with nothing at …/2026-09-24-issue-2-research.md (its branch added no document to adopt)`.
This was seen for t1 and t2 (16:35) and t4 (16:47). The orchestrator called them "false worker idle alerts" each time. For
t3 (16:44) the same gap produced a bare `[research 9m] agent:idle — worker's move`, the shape §2 calls a finding. Suspect:
the #23 predicate needs a "never briefed / not yet dispatched" guard; a dispatch timestamp would do.

**F5 — A dead orchestrator produces no `⚠ … undelivered` line in `hpipe status`.** *Severity: major (the human loses visibility).*
With the orchestrator's Claude `/exit`ed (16:49:15–16:55:51), status never showed an undelivered or orchestrator-gone
warning. That held even when decision d2 (asked 16:51:15) sat unannounced for 4½ minutes. `run.outbox` stayed `[]`
throughout, because digests are ephemeral by design (`queuePending`, `src/supervisor/courier.ts`) and decision prompts
use their own `prompted_at` retry, not the outbox. So `outboxWarnings` (`src/lib/outbox.ts`) has nothing to count.
§4d.1's assertion cannot pass as the code stands. Status also cannot tell a pane with a dead agent from a live one: the
`⚠ orchestrator pane … is gone` check needs the pane itself to vanish.

**F6 — Digest events from the orchestrator's dead window are lost, not "held and delivered as one digest".** *Severity: medium.*
On resume only the d2 decision prompt arrived. The events `t4 [spec → spec-review]`, `[spec-review → plan]` and
`[plan → blocked-on-decision]` were never shown to the new orchestrator. This is by design in the code ("event lines …
are rebuilt from the ledger on the next wake rather than replayed stale"), but it contradicts runbook §4d.2 ("the held
prompts arrive as one digest"). Either the runbook or the design should change. A catch-up digest on recovery would help
a replacement orchestrator that has no context.

**F7 — `pane <id> is gone; holding … — \`hpipe status\` lists it`, but status does not.** *Severity: medium.*
Supervisor log 16:54:42: `[pipeline] pane w5:p1 is gone; holding what is addressed to it — \`hpipe status\` lists it`.
For the next 40 minutes `hpipe status` showed t3 as `[research Nm] working`, with no `(pane w5:p1 is gone)`. The held
item was a stall probe, which is tracked in `task.stall.undeliverable_since` and not in the outbox, so `outboxWarnings`
never sees it. The `working` agent status also went stale once the pane was gone.

**F8 — Supervisor prompts are submitted on top of a human's draft, and agents then ignore them.** *Severity: medium.*
Worker: draft `human draft: do not send this yet` left in t4's box. The implement stall probe was submitted as one
message with the draft first, and the worker replied "I won't act on this probe, since you've marked it as a draft".
Orchestrator: draft `orchestrator draft by human, not for sending`. The d3 decision prompt was submitted with it,
the orchestrator replied "You marked this as a draft, so I haven't recorded anything for d3", and it acted only on a
later digest. In both cases `herdr agent prompt` did not stall, so the box check and `stuck input` line (courier) never
ran. The runbook's orchestrator check ("leaves the draft intact and produces that status line") fails. That check only
exists after an `agent_prompt_stalled`, and a non-empty box does not stall. Suggest reading the box before every send,
not only after a stall.

**F9 — The decision prompt is not accompanied by the `also waiting on you:` footer.** *Severity: minor / doc.*
Runbook §4a.2 says the decision delivery carries a footer line for the task. Observed: the decision prompt alone, then a
separate digest where the task appears as an event (`[blocked-on-decision 0m] agent:done — YOUR move`), because the
worker going idle after `hpipe decide` is a pane event. Either the runbook text or the delivery should change.

**F10 — A rewound task with no worktree is invisible, and its probe gives wrong advice.** *Severity: minor.*
After `pane.exited` → `failed` → `rewind … research`, t3 had `workspace: none, pane: none`. `hpipe status` listed nothing
under `waiting on you:`, since #12 only flags a bound worktree with no agent. At +10 min the orchestrator got
`Still working? … phase research (t3)` saying "Nothing has appeared at …/issue-3-research.md — if you finished but wrote it
elsewhere, move it", which is worker advice sent to the orchestrator, about a task that has no worker. It should say that
the task needs a worktree and agent (`worktree create`/`open`, `agent start`, `dispatch --task`).

**F11 — Last-mile rows render a bare `— YOUR move` in status and the footer.** *Severity: minor, DX.*
`t4 smoke/four (#4) [merge 20m] — YOUR move` names neither the PR nor the action, while the stall probe for the same row
names it well ("waiting for you to merge PR #7"). Reusing the probe's `awaiting` clause in `actionFor` would help.

**F12 — Every plan widens `files` to `docs/superpowers/`.** *Severity: minor.*
Supervisor: `t1 (smoke/one): plan widened files by test/greet.test.ts, docs/superpowers/` (same for t4). Every worker writes
its artifacts under `docs/superpowers/`, so any task that declares `docs` (t3 here) overlaps every other task at
`blocked-on-files`, and the whole batch would serialize. The widening probably should ignore the pipeline's own artifact
directory.

**F13 — The orchestrator never escalated a decision to the human (prompt quality, record only).** Four decisions, four
`--by orchestrator` answers. For d3 ("add a License section, and which license?") it answered "none in this PR", which is
scope-correct, and it flagged the license itself as an owner's call for a later issue. This is not a clear
under-escalation, but §4b and `--by human` stayed untested. A future run needs a decision that no issue scope can settle.

**F14 — Reopening the supervisor leaves the dead pane beside the new one.** *Severity: cosmetic.* After `kill` and
`plugin action invoke stein.pipeline.supervisor`, the session has two "Pipeline supervisor" panes (`w1:p2` dead shell,
`w1:p3` live). This conflicts with the setup check "exactly ONE Pipeline supervisor pane" on any later reconciliation.

### Observations (not findings)

- Supervisor log lines carry no timestamps, so "once, not every tick" and backoff spacing have to be inferred from pane
  captures. Timestamps would make §4d checkable directly.
- `[pipeline] run …: this tick not saved (run … changed on disk since it was read); its prompts are dropped and it is
  re-read next tick` was logged 24 times, each time a CLI write (`answer`, `rewind`, `decide`) raced a tick. No lost
  prompt was traced to it, but it is noisy.
- Workers on toy issues move fast: research→spec→spec-review→plan→plan-review took ~4 min per task. That makes the
  §2 simultaneity window and the §4a ordering sub-second to seconds; 4-second pane captures cannot sequence them by eye.
- Environment: herdr inherited `CLAUDE_CODE_CHILD_SESSION` from the launching shell, so every agent showed "Transcript
  saving is off". That made `--resume` impossible for the replacement orchestrator. Not a plugin bug.
- Long multi-line `pane send-text` into Claude arrived truncated to its tail (bracketed-paste). The harness worked
  around it by pointing the orchestrator at a file. Not a plugin bug, but `dispatch.md`'s warning about paste is right.

## Filed

| Finding | Issue |
|---|---|
| F1 | #86 |
| F2 | #87 |
| F3 | #88 |
| F4 | #89 |
| F5, F7 | #90 |
| F6 | #91 |
| F8 | #92 |
| F9 | #93 |
| F10 | #94 |
| F11 | #95 |
| F12 | #96 |
| F14 | #97 |
| F13 | not filed — record only; the next run needs a decision no issue scope can settle, to exercise §4b and `--by human` |
