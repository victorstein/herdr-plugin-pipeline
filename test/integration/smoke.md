# Live smoke runbook — worker-owned pipeline

One real herdr session, one real repo, two real GitHub issues, two real worker agents. Budget
45–90 minutes: the workers do actual research/spec/plan work and you wait on them.

> **A step whose observed behaviour differs from what is written here is a FINDING to bring back,
> not a test to make pass.** Do not edit the plugin mid-run to make an assertion go green. Write
> down what you saw — the phase, the pane, the `hpipe status` output, the timestamps — and stop.
> Everything the plugin owns is bookkeeping; abandoning a run costs nothing.

The unit suite is 327 green and proves none of what follows. The first live run of the previous
design found two startup/gating defects that dependency-injected fakes had passed cleanly, and
§5 below is an open question three adversarial review rounds could not settle statically.

## What you need

- herdr 0.9.0+, `bun`, `gh` authenticated against a repo you may open and close throwaway issues in.
- A target repo with at least one `.claude/agents/<surface>-dev.md`. `hpipe task --surface <s>`
  is rejected when `.claude/agents/<s>-dev.md` does not exist, so check first:
  `ls <repo>/.claude/agents/`.
- Two branch names and two issues you are happy to throw away.

## The one gotcha that invalidates the whole run

`hpipe` derives its session key from `HERDR_SESSION`, else from `HERDR_SOCKET_PATH`, else falls
back to the literal string `default`. **Run every `hpipe` command from inside a pane of the smoke
session.** From an ordinary terminal it silently reads and writes the `default` session's ledger
and you will be debugging the wrong file. Sanity-check once, inside the orchestrator pane:

```bash
echo "$HERDR_SESSION / $HERDR_SOCKET_PATH"
```

Both empty means you are not in a herdr pane. Stop and open one.

## Setup

```bash
export SMOKE=pipesmoke
export STATE=~/.local/state/herdr/plugins/stein.pipeline

herdr plugin link "$PWD"        # link BEFORE the session first boots
herdr plugin list               # assert: stein.pipeline present, warnings empty
herdr --session "$SMOKE" server &
sleep 2
```

**Order matters.** `plugin link` registers the plugin but does not run its startup hook against a
server that is already up — verified live, including after `server reload-config`. Link first, or
restart the session afterwards. Otherwise reconciliation never runs, no `pipeline` workspace
appears, and every step below fails for the same uninteresting reason.

Then confirm the floor:

```bash
herdr --session "$SMOKE" workspace list   # assert: a workspace labelled "pipeline"
herdr --session "$SMOKE" pane list        # assert: exactly ONE "Pipeline supervisor" pane
```

Open a second pane in the smoke session, `cd` it to the target repo, and start a Claude agent in
it. That pane is **the orchestrator**. Keep the supervisor pane visible the whole run — its stdout
is the only place tick-level errors surface (`[pipeline] run <id> failed this tick:`,
`dropping prompt for … — no pane`, `giving up on delivery to …`).

Leave a third, plain shell pane open for observation commands. Nothing below should ever be typed
into a worker's pane.

---

## 1. Start, intake, dispatch

In the orchestrator pane:

```bash
hpipe start "smoke batch"
```

**Observe:** the intake prompt is printed into that pane, and

```bash
hpipe status
```

shows `supervisor: live (pid N)`, one run in `[intake]`, and an `orchestrator:` line naming this
pane.

Now let the orchestrator do intake for real: it files **two** GitHub issues, one per task, and
registers both. The registration must give the two tasks **overlapping `--files`** — that is the
setup for §3 and the whole reason this run uses two tasks.

First, one deliberately malformed registration, **typed by hand, before the orchestrator registers
anything** — this is the check that `--files` is validated at all, and it is supposed to fail:

```bash
hpipe task --branch smoke/bad --issue 999 --surface <surface> --files "src/lib src/lib/config.ts"
```

`--issue 999` never reaches GitHub — `hpipe task` only requires a positive integer — so this step needs
no issue of its own and must not borrow one of the two below.

**Expect:** exit 1, `--files is comma-separated; this entry contains whitespace: "src/lib
src/lib/config.ts"`, and a `→ --files src/lib,src/lib/config.ts` suggestion. Nothing is registered.

**Failure looks like:** the command succeeding and printing `task_id: t1`. That is the finding, and it
cannot be repaired in place — no command removes a task, so this ghost takes `t1` and pushes the two
real tasks below to `t2`/`t3`, breaking §3's assertions, which name `t1` and `t2` literally. Run
`hpipe abort <run_id>`, restart this section from `hpipe start`, and report it — the abort leaves the
run in `done`, so nothing can be registered into it afterwards.

Now the two real registrations, which the orchestrator runs:

```bash
hpipe task --branch smoke/one --issue <n1> --surface <surface> --files src/lib
hpipe task --branch smoke/two --issue <n2> --surface <surface> --files src/lib/config.ts
```

`src/lib/config.ts` starts with `src/lib`, so `filesOverlap` is true in both directions. Any
prefix-overlapping pair works; do not use `--depends-on` here, which would serialize the tasks for
a different reason and hide the collision you are here to see.

**Observe:** each `hpipe task` prints `task_id: t1` / `task_id: t2`, then a `files:` line echoing what
it recorded — `files: src/lib` and `files: src/lib/config.ts` — and then the rendered worker brief.
Both should print a brief, not `queued: waiting on …` — with no `--depends-on` the dependency gate is
open for both, and the file collision is resolved much later, at `blocked-on-files`, not at
registration. The two tasks must come out as `t1` and `t2`; §3 names those ids literally.

Then close intake:

```bash
hpipe dispatch --done
hpipe status      # assert: run phase is no longer [intake]
```

**Failure looks like:** `found no run in intake, dispatch or execute for <repo> in session <session>`
from `hpipe task` (you are in the wrong repo or session — the message names both), or `no agent
definition at …-dev.md` (wrong `--surface`).

The orchestrator now creates a worktree per task and adopts its root pane:

```bash
herdr worktree create --branch smoke/one --base main
# capture .result.root_pane.pane_id
herdr agent start smoke-one --kind claude --pane <root_pane_id> -- \
  --dangerously-skip-permissions "<the brief hpipe task printed>"
```

**Observe:** `pane list --workspace <ws>` shows exactly ONE pane for that workspace before and
after `agent start` — it adopts the existing root pane and creates no orphan. Within a tick or two
`hpipe status` shows the task bound: its `agent_status` stops being `unknown`.

**Failure looks like:** the task still shows `unknown` and `hpipe status` never names a pane. The
binding comes from two separate events — `worktree.created` (matched on `branch`, sets
`workspace_id`/`checkout_path`) and `pane.agent_detected` (sets `pane_id`). If the worktree bound
but the pane did not, the agent was started somewhere the plugin did not see. `hpipe forget
<workspace_id>` unbinds so you can retry.

---

## 2. Two workers at `spec` simultaneously — the fan-out check

**This is the assertion no unit test can make.** A single supervisor tick can produce prompts for
several panes at once. The previous design returned one delivery per tick and dropped the rest,
which was only safe because every prompt-producing row had the same recipient. With eight
worker-owned rows that is no longer true, and the failure mode is not a crash: it is one pane
receiving *both* prompts concatenated while the other silently receives nothing and stalls until
`TASK_STALL_MINUTES` (45) later.

Drive both tasks to the same phase. The cleanest window is `spec`: both workers finish `research`
within a few minutes of each other, and `research → spec` fires off a file that you can force.

Watch for it:

```bash
watch -n 2 'hpipe status'
```

**What to look for, at the moment both tasks read `[spec]`:**

- In **worker one's pane**: exactly one prompt, headed for *its* branch and *its* issue number,
  naming *its* spec path (`docs/superpowers/specs/<date>-issue-<n1>-design.md`).
- In **worker two's pane**: exactly one prompt, naming `<n2>` and its own spec path.
- In **neither pane**: a prompt containing the *other* task's issue number, or two prompts
  separated by a `---` rule. `deliveriesFor` joins same-pane prompts with `\n\n---\n\n`; that rule
  is correct when both fragments belong to that pane, and is the signature of the bug when the
  fragments name two different branches.
- In the **orchestrator's pane**: a digest, not a worker prompt. Worker prompts go to worker panes;
  the orchestrator only gets `[pipeline] run <id> …` digests and the dispatch/merge/close/decision
  prompts that are its own. Every event line in that digest must carry, in this order, the task id,
  the branch and issue, a bracketed phase box with the age in that phase — `[spec 12m]`, or a
  transition box `[research → spec]` on the tick a phase advances — and an action clause naming
  whose move it is: `YOUR move`, `worker's move`, `needs a human: <rewind cmd>`, `dead end`, or
  `nothing for you …`. A line of the old shape — `branch (#n, tN) done`, carrying herdr's agent
  status and nothing else — is a **finding**: that form is what issue #13 was filed over, because
  `done` there means "the agent stopped typing", not "the phase completed".
- **Confirm the `→` arrow specifically.** #13 shipped without ever being observed live: the
  supervisor that drove its own run was the released plugin, so the transition box has only ever
  been exercised by unit tests. Watch for one digest where a phase advances and record whether the
  box reads `[research → spec]` rather than `[spec 0m]`.
- **A digest may end with an `also waiting on you:` footer** listing tasks that produced no event at
  all — a task parked in `merge`, `close` or `blocked-on-decision` emits nothing, so the footer is
  the only thing that reports it. Expect it to name the same tasks `hpipe status` flags, and note
  that a task parked in an orchestrator-owned row is reported **only** on ticks that already produce
  a digest; a genuinely quiet window shows nothing. That residual gap is issue #19, not a defect
  here.
- In the **supervisor pane**: no `dropping prompt for task tN — no pane`. That line means a prompt
  was generated for a task whose `pane_id` is null and thrown away; the task will sit until the
  stall probe.

**Record:** paste the first ~10 lines of each worker pane at that moment into your findings. Both
correct and both wrong are useful data; "it looked fine" is not.

A cheap way to read the panes without touching them:

```bash
herdr --session "$SMOKE" pane read <worker_one_pane> --source visible --lines 30
herdr --session "$SMOKE" pane read <worker_two_pane> --source visible --lines 30
```

---

## 3. The `blocked-on-files` collision

Both tasks share a file prefix, so after `plan-review` clears, each enters `blocked-on-files` —
that is `plan-review`'s `onClear`, unconditionally, for every task. `releasableFromFiles` then
makes **one pass in `task_id` order and releases at most one task per overlapping group per tick**.

**Assert:**

1. Exactly one of `t1`/`t2` leaves `blocked-on-files` for `implement`. Never both, not even one
   tick apart. Because the sort is `task_id.localeCompare`, `t1` should win — record which
   actually did.
2. The loser stays in `blocked-on-files` and `hpipe status` prints, every time you run it:

   ```
     ⚠ t2 blocked on files held by t1 (implement) — `hpipe release --task t1` is the only way out
   ```

   The holder phase in that line should track `t1` as it moves: `implement`, `pr-review-intent`,
   `pr-review-quality`, `ci`, `merge`, `close`, `teardown` all hold files.
3. `t2` is released only once `t1` reaches a **non-holding** phase. In practice that is `done`
   (after `teardown`), because every phase from `implement` through `teardown` holds. It is *not*
   released when `t1`'s PR merges — `merge` and `close` still hold.

**Record:** the wall-clock time `t1` entered `implement`, the phase `t1` was in when `t2` moved,
and the time `t2` entered `implement`.

**Failure looks like:** both tasks in `implement` at once (the release set is not being recomputed
per tick, or `isInFlight` is reading the wrong row), or `t2` never releasing after `t1` reaches
`done` (something is still holding — check whether `t1` actually reached `done` or stopped at
`failed`/`escalated`, both of which hold files deliberately and forever).

`hpipe release --task t1` clears a holder's `files` reservation by hand, but it **refuses while
that task is still in flight** — it only accepts a terminal task, or an `escalated` one. If you
need it mid-run, that itself is a finding.

---

## 4. Decisions — one answered, one escalated

You need two surfaced decisions. Real ones are better than manufactured ones, but if neither worker
surfaces one on its own, you can prompt a worker to call `hpipe decide` for a genuine question it
already faced. **Do not run `hpipe decide` yourself from the orchestrator pane** — the point is to
exercise the worker → supervisor → orchestrator → worker round trip.

From the worker's pane:

```bash
hpipe decide --task t1 \
  --question "<what must be decided and why it cannot be settled here>" \
  --recommend "<the path the worker would take, and why>"
```

`hpipe decide` resolves against the repo you are standing in, and a worktree resolves to the repo it
was cut from — so running it in the worker's pane reaches that worker's run. If it ever reports more
than one candidate, pass `--run <run-id>`; the brief names the run in its first paragraph.

`--recommend` is mandatory; a call without it is rejected on purpose.

### 4a. Answered by the orchestrator, without the human

**Observe, in order:**

1. The worker's task goes to `[blocked-on-decision]`, and `decision_from` remembers the phase it
   was in.
2. Within a tick, the **orchestrator's pane** receives the `decision` prompt: the question, the
   worker's recommendation, and the exact `hpipe answer` line to run. That same delivery will also
   carry an `also waiting on you:` footer line for this task — `- tN <branch> (#n)
   [blocked-on-decision 0m] — YOUR move`. `hpipe decide` is not a pane event, so the task produces
   no wake line of its own and the footer is what reports it; seeing both the prompt and the footer
   line for one task is correct, not a duplicate.
3. **While the question is open**, `hpipe status` prints:

   ```
     ⚠ t1 blocked on an open decision (Nm): <question>
   ```

   Check this *before* answering. If `hpipe status` does not show it, the question is invisible to
   the human and that is a finding on its own.
4. The orchestrator answers it from the repo — issue, `CLAUDE.md`, the surface agent file, an
   existing call site — without asking you:

   ```bash
   hpipe answer --task t1 --decision <decision_id> --answer "<the call and the reason>" --by orchestrator
   ```

   Run this from the orchestrator's pane, inside the repo. From anywhere else it needs
   `--run <run-id>`, and a run that has already finished needs it too.

   Output: `recorded answer to <id> on t1; pending delivery`. **The task is still
   `blocked-on-decision` at this point.** Writing the answer deliberately does not resume the
   worker; delivery is a separate step.
5. **The ordering assertion.** Watch the worker's pane and `hpipe status` together. The worker's
   phase must move back to `decision_from` **only after the answer text lands in its pane** — you
   should be able to see the `# Decision answered — resume <phase>` block, with the Q and A in it,
   in the pane *before* `hpipe status` stops saying `blocked-on-decision`. The phase reset is a
   consequence of a successful send, never of the write.

   Do it in this order so you can see it: `hpipe status`, then read the pane, then `hpipe status`
   again.

**Failure looks like:** the phase moving while the pane still shows the old prompt (the worker
would resume having never read the answer, with `run.history` asserting otherwise — a serious
finding), or `hpipe status` reporting

```
  ⚠ t1 decision <id> answered but undelivered (N delivery attempts) — a fresh `hpipe answer` re-arms delivery
```

with N climbing. That means the send is failing; check the supervisor pane and whether the worker's
pane is alive. After `PROMPT_RETRY_MAX` (5) attempts delivery stops being retried and a fresh
`hpipe answer` is the only way to re-arm it.

### 4b. Escalated to the human

Surface a second decision — on `t2`, or on `t1` after it resumes — that the repo genuinely does not
answer. This time the orchestrator brings it to **you**: the question, the worker's recommendation,
its own read, and a named recommended option. Answer it out loud, and have the orchestrator record
it:

```bash
hpipe answer --task t2 --decision <decision_id> --answer "<what you decided and why>" --by human
```

**Assert:** same delivery ordering as 4a, and `--by human` in the recorded answer — that flag is
the audit trail and only the orchestrator knows which it was.

**Record:** whether the orchestrator escalated a question the repo already answered (over-
escalation — a prompt-quality finding), or answered one it should have escalated (under-escalation
— a worse one). Also record whether it ever handed you a bare question with no recommendation; the
`decision` prompt forbids that explicitly.

Only one decision may be open per task at a time. A second `hpipe decide` while
`blocked-on-decision` is rejected with the open decision's id — that is correct behaviour, not a
bug.

---

### 4c. The stall ladder

A phase that goes quiet is probed every `TASK_STALL_MINUTES` (45) for a task, `STALL_MINUTES` (15)
for a run, measured from the **last probe** rather than from phase entry — so a supervisor restart
produces one probe per stalled record, not a burst. After `STALL_PROBE_MAX` (3) unanswered probes a
row whose signal the probed actor produces itself (`research`, `spec`, the four review rows,
`implement`, and the run's `branch-review`) is moved to `escalated` and reported by `hpipe status`.

`blocked-on-files`, `blocked-on-decision`, and the run's `dispatch` and `execute` are probed but
**never** escalated — they are waiting correctly, on a sibling task or on you, and escalating them
would cascade their dependents to `blocked-on-failure`. Their probe says so.

If the actor's pane reports `working` when escalation comes due, it is deferred one interval, up to
`STALL_PROBE_MAX` times, then escalated anyway. Nothing waits forever.

## 5. The subagent / `agent_status` question — OPEN, record the answer here

**The question.** During `spec-review`, `plan-review`, `pr-review-intent` and `pr-review-quality`,
the worker dispatches a *review subagent* and is told to wait for it within its own turn. The
supervisor gates every artifact-and-verdict row on the worker pane reading `idle` or `done` (via
`herdr agent get`, double-checked after `ACTOR_SETTLE_MS`). Three adversarial rounds could not
settle statically whether a Claude Code subagent running inside a pane perturbs that pane's
reported `agent_status` — herdr's authority for it is the screen manifest, and unmatched prompts
fall back to `idle`.

If a pane running a subagent can read `idle` while the verdict file does not yet exist, the
supervisor sees a healthy worker as a stalled one and probes it. Worse, if the pane reads `idle`
*after* a stale verdict file from a previous pass is on disk, a phase could clear on the wrong
file — though `isFresh` against `phase_entered_at` is the guard for that.

**The measurement.** Pick one review phase — `spec-review` on `t1` is the earliest and cheapest.
The moment the worker's pane shows the `Adversarial review of your spec` prompt, start this in your
observation pane, with `VERDICT` set to the `verdict_path` that prompt printed:

```bash
WORKER=<worker_pane_id>
VERDICT=<the verdict_path from the prompt>
while true; do
  printf '%s  status=%s  verdict_exists=%s\n' \
    "$(date +%H:%M:%S)" \
    "$(herdr --session "$SMOKE" agent get "$WORKER" | jq -r .result.agent.agent_status)" \
    "$([ -f "$VERDICT" ] && echo yes || echo no)"
  sleep 5
done | tee /tmp/subagent-status.log
```

Stop it once `verdict_exists=yes` and the task has left `spec-review`.

**What the log must answer:** did `status` ever read `idle` or `done` on a line where
`verdict_exists=no`, while the subagent was demonstrably running? Note `done` counts — `isAgentReady`
accepts `idle` *and* `done`.

### Findings — fill this in during the run

**Run of 2026-09-15/16, herdr 0.9.0, commit `98044d4`. Result: the pipeline completed end to end** —
two issues, two workers, two merged PRs, both issues closed, both worktrees torn down, branch-review
`CLEAR`, run `done`. Wall clock 22:29 → 00:30, of which ~70 min was unattended task work; the rest was
diagnosing the four bugs below.

#### Bugs the run found (all fixed, each with a regression test)

| # | What | Severity |
| --- | --- | --- |
| 1 | **herdr wraps every event as `{event, data:{…}}`** and `toQueuedEvent` read the fields off the outer object. Every hook enqueued a bare `{kind, session, at}`, so **no task ever bound its workspace, pane or checkout path**, agent status never updated, and a pane exit never failed a task. Observed with two workers dispatched and running while both tasks read `[research] unknown`. `test/hook.test.ts` fed the *inner* object, encoding the same wrong assumption, so all 331 tests passed. | **Critical** |
| 2 | `dispatch.md` ran `herdr worktree create` with no `--cwd`, so herdr resolved the repo from the **focused** workspace — the supervisor's own on a cold start. The first dispatch created the worktree in the plugin's own repo and would have run the worker against a different repo's issues. | **Critical** |
| 3 | `hpipe task` validated only `--surface`; a missing `--issue` became `Number('0')` and minted a ghost task with no branch into a live run, unremovable by any command. | Major |
| 4 | No read-only way to obtain a worker brief — the only source was `hpipe task`'s output, which registers a task. An orchestrator that lost its context could not recover the text without corrupting the run. Added `hpipe brief --task <id>`. | Major |

#### Verified working, live

Startup reconciliation on cold **and** warm restart (exactly one supervisor pane, no ghost duplicate);
supervisor death leaving a readable pane; run state surviving a full server restart; the
`intake → dispatch` edge predicate; `queued → research` routing; both tasks in design phases
concurrently despite overlapping `--files`; a genuine `plan-review → plan (returned, pass 1)` retry
with the monotone counter; both decisions surfaced, announced to the orchestrator with `prompted_at`
stamped, answered, and resumed to the correct `decision_from`; `close → teardown` on an auto-closed
issue — the deadlock this repo's memory records as live; `hpipe status` surfacing an open decision
with its age.

#### §3 `blocked-on-files` — exercised and PASSED (forced)

It did not occur naturally: t1 passed through in 1s and t2 in 2s, because t1 reached `done` at
23:23:19 while t2 only arrived at 23:27:02 — t2's extra plan-review pass staggered them by nine
minutes. Two tasks of similar design length would collide; these did not.

Forced afterwards with a seeded run (`collide-probe`), driving the real supervisor:

| Observation | Result |
| --- | --- |
| t1 `implement` holding `src/lib/config.ts`, t2 `blocked-on-files` wanting `src/lib/` | t2 held for 6 consecutive ticks |
| `hpipe status` during the hold | `⚠ t2 blocked on files held by t1 (implement)` |
| t1 → `done`, with **two** waiters (t2 `src/lib/`, t3 `src/lib/config.ts`) | **t2 advanced, t3 did not** |
| t3 after t2 became the holder | held for 8 further ticks, `status` renaming the holder as t2 |

So: a waiter is held while a sibling holds an overlapping prefix; **exactly one task leaves an
overlapping group per tick**, chosen by `task_id` order; and the released task immediately becomes the
new holder for the rest of the group. The invariant `releasableFromFiles`' running set exists to
enforce holds live.

One bug found doing it: `status` advised ``hpipe release --task <holder>`` unconditionally, but
`cmdRelease` refuses an in-flight holder — so against a healthy one it sent the human at a command
that bounces. Release is the escape only when the holder is terminal or escalated; otherwise the
line now reads "waiting for it to finish".

#### §5 subagent / `agent_status` — MEASURED. The pane does NOT read idle.

**Answer: a backgrounded subagent keeps the parent pane reading `working`.** The four worker rows that
gate on actor idleness are safe even when a worker ignores the await instruction.

Measured directly. A Claude agent in a herdr pane was told to dispatch a subagent **in the background**
and end its turn immediately — confirmed from the pane: *"Backgrounded agent"*, then *"Subagent
dispatched in the background. It's still running — ending my turn now."* Polling
`herdr agent get <pane>` every 2s for the full 78s the subagent ran:

```
00:38:25 status=idle     verdict_exists=no     <- before dispatch
00:38:27 status=working  verdict_exists=no     <- dispatched, turn ended
   … 38 consecutive samples, all status=working, verdict_exists=no …
00:39:45 status=working  verdict_exists=yes    <- subagent finished
```

Never once `idle`. The mechanism is herdr's own detection manifest: the parent pane displays
`✻ Waiting for 1 background agent to finish`, which matches the dedicated `background_agents_working`
rule (priority 965) and classifies as `working`.

**Caveat on the scope of this result.** It holds while Claude Code prints that specific waiting line.
If that text changes, or if a future version returns the parent to a bare prompt while children run,
the rule stops matching and the question reopens. The await-and-do-not-end-your-turn instruction in the
four review prompts is therefore worth keeping as defence in depth, but it is not load-bearing today —
and the verdict-file predicate remains an independent guard regardless.

#### Environment note

`herdr agent start` returns `agent_not_ready` when Claude Code shows its folder-trust dialog on a
path it has not seen. Trust is per-path: the orchestrator blocked on a brand-new repo, the workers did
not, because `~/.herdr/worktrees/` was already trusted on this machine. On a fresh machine every
worker would block once. Not a plugin bug, but it will stall a first run.

## 6. Finish the run

Let `t1` go all the way: `implement` → PR → `pr-review-intent` → `pr-review-quality` → `ci` →
`merge` → `close` → `teardown` → `done`. Then `t2` releases and follows. When both are `done` and
intake is closed, the run advances to `branch-review`, whose prompt goes to the orchestrator; it
clears to `done`.

**Along the way, assert:**

- The PR body ends with a real `Closes #<n>` keyword. `close` waits on `gh issue view --json
  closed`, and "Implements #n" does not auto-close.
- `teardown` removes the worktree unless the task was registered `--keep-worktree`.
- No plugin commands were dropped:

  ```bash
  herdr plugin log list --plugin stein.pipeline | grep -c plugin_command_limit_reached
  ```

  assert `0`. Nonzero means a hook has started blocking — herdr caps at 32 concurrent plugin
  commands and drops the event over the cap. This is the assertion that catches a regression back
  into blocking hooks, and it matters more with two workers than it ever did with one.

- A dead supervisor still leaves a readable pane:

  ```bash
  kill "$(jq -r .pid "$STATE/supervisor.$SMOKE.pid")"
  herdr --session "$SMOKE" pane read <supervisor_pane_id> --source visible --lines 5
  ```

  assert: contains `supervisor exited`, and the pane still exists. Reopen it with the plugin's
  `supervisor` action before continuing.

---

## What to do when a step fails

The ledger is at `$STATE/runs/$SMOKE/<run_id>.json` — read it, never hand-edit it. All of these run
from the orchestrator pane.

| Symptom | Recovery |
| --- | --- |
| A phase advanced early, or on the wrong file | `hpipe rewind <run_id> <phase> [--task <task_id>]` — resets the phase, clears review-pass counters and `delivery_attempts`, discards an undelivered answer (recorded in history), and clears `escalated_from`. Rewinding a *run* to `dispatch` also clears `adopted_at` on bound tasks so worktree binding can re-fire. |
| A task is stuck in `blocked-on-files` behind a holder that will never finish | Get the holder terminal first (`hpipe rewind … --task <holder>` to a phase it can finish, or let it fail), then `hpipe release --task <holder>`. `release` refuses while the holder is in flight, and only accepts a terminal or `escalated` task. |
| A decision is open and the worker is stopped | `hpipe answer --task <t> --decision <id> --answer "…" --by orchestrator\|human`. If status shows "answered but undelivered" with attempts climbing, a fresh `hpipe answer` re-arms delivery. |
| A phase burned through `MAX_PASSES` (2) and escalated | Settle the dispute with the human, then `hpipe rewind <run_id> <phase> [--task <id>]`, which resets that phase's pass count. |
| A phase was escalated by the stall ladder | `hpipe status` shows `⚠ … escalated from <phase> … needs a human`. Deal with whatever it was waiting for, then `hpipe rewind <run_id> <phase> [--task <id>]`, which re-arms the ladder from zero. |
| The whole run is wrong and you want out | `hpipe abort <run_id>` — leaves worktrees and branches alone, releases the repo for a new `hpipe start`. Undo with `hpipe resume <run_id>`, which puts it back where it was. |
| The orchestrator pane died or changed id | `hpipe status` flags it (`⚠ orchestrator pane … is gone`). Run the plugin's `claim` action from the pane that should drive the run. |
| The supervisor died | `hpipe status` reports `supervisor: none\|stale`. Reopen with `herdr plugin action invoke stein.pipeline.supervisor`. Nothing advances until it is back; no state is lost. |
| A task is bound to the wrong workspace | `hpipe forget <workspace_id>` clears `workspace_id` and `pane_id` so the binding can be re-made. |
| Events look stuck | `hpipe drain` prints and consumes the queue at `$STATE/queue/$SMOKE/`. It is destructive — it unlinks as it reads — so only use it when the supervisor is down. |
| The plugin itself is misbehaving | `herdr plugin disable stein.pipeline` |

`hpipe rewind` validates its phase argument against the phase table and refuses one that is in no
row, naming the valid phases. Rewinding a task to a terminal phase (`done`, `failed`, `orphaned`,
`blocked-on-failure`) also abandons any decision still open on it, so `hpipe status` stops reporting
a question whose pane is gone.

---

## Teardown — mandatory

```bash
herdr plugin unlink stein.pipeline
herdr --session "$SMOKE" worktree remove --workspace <ws> --force   # once per worker workspace
herdr --session "$SMOKE" server stop
herdr session delete "$SMOKE"
rm -f ~/.local/bin/hpipe
rm -rf "$STATE/runs/$SMOKE" "$STATE/queue/$SMOKE" "$STATE/orchestrators/$SMOKE"

herdr plugin list          # assert: back to empty
herdr session list         # assert: only the sessions that were there before
```

Close the two throwaway GitHub issues and delete the smoke branches and PRs. If the run merged
anything into `main` of a real repo, revert it — nothing in this runbook is work you want to keep.
