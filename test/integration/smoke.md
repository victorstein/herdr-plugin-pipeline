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

Now let the orchestrator do intake for real: two tasks, each backed by a GitHub issue. The first is
filed with `gh issue create` and registered with `--issue`; the second is filed *by* `hpipe task
--title … --body-file …`, which is the only live check of that path. The registration must give the two tasks **overlapping `--files`** — that is the
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

Second, a `--title` registration that fails validation, also typed by hand — it must file nothing:

```bash
printf 'Smoke: must never be filed.\n' > /tmp/smoke-orphan.md
hpipe task --branch smoke/orphan --title "smoke orphan" --body-file /tmp/smoke-orphan.md --surface nope
gh issue list --search "smoke orphan in:title" --state all   # assert: empty
```

**Expect:** exit 1, `no agent definition at …/nope-dev.md`, and no issue. **Failure looks like:** an
issue titled `smoke orphan` exists — the gh call ran before validation. Close it and report it.

Now the two real registrations, which the orchestrator runs. The second files its own issue from a
body file written like any issue body:

```bash
hpipe task --branch smoke/one --issue <n1> --surface <surface> --files src/lib --tier heavy
hpipe task --branch smoke/two --title "<title>" --body-file <brief.md> --surface <surface> \
           --files src/lib/config.ts --tier heavy
```

Both are pinned to `--tier heavy`, the tier that runs every review row, so §3–§6 exercise the same
route every task took before tiers existed. The lighter tiers have their own section, §7. `<n1>` must
carry no `pipeline:tier-*` label: a tier label on the issue overrides `--tier`.

**Observe on the second:** a line `issue: #<n2> (filed)` right after `task_id: t2` and its `tier:`
line, a real issue
`#<n2>` in the target repo (`gh issue view <n2>` shows the body file's text), exactly one such issue
(a retried registration must never file twice), and a brief headed `smoke/two — issue #<n2>`. If gh
fails — no auth, or a fork with several remotes and no `gh repo set-default` — the command must exit 1
with `gh issue create failed in <repo>` and register nothing. If registration fails *after* filing,
the output must name the filed issue and say `register it with --issue <n2>`; do exactly that.

`src/lib/config.ts` starts with `src/lib`, so `filesOverlap` is true in both directions. Any
prefix-overlapping pair works; do not use `--depends-on` here, which would serialize the tasks for
a different reason and hide the collision you are here to see.

**Observe:** each `hpipe task` prints `task_id: t1` / `task_id: t2`, then `tier: heavy (--tier)`, then
a `files:` line echoing what it recorded — `files: src/lib` and `files: src/lib/config.ts` — and then
the rendered worker brief.
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
herdr worktree create --cwd <repo> --branch smoke/one --base <commit>   # the commit on the base: line
# capture .result.root_pane.pane_id
herdr agent start smoke-one --kind claude --pane <root_pane_id> -- --dangerously-skip-permissions
hpipe dispatch --task t1 --pane <root_pane_id>
```

**Observe:** `pane list --workspace <ws>` shows exactly ONE pane for that workspace before and
after `agent start` — it adopts the existing root pane and creates no orphan. `hpipe dispatch --task`
exits 0 with `brief for t1 delivered`, and the worker pane shows the brief submitted and the agent
working on it — not text sitting in the input box. `hpipe show --task t1` prints the recorded task. Both
`hpipe task` (dispatching at registration) and the supervisor's `Dispatch tN …` prompt carry a
`base: <commit> (origin/<default> as just fetched)` header line; a `--depends-on` task dispatched after its dependency merged on GitHub is cut from a commit containing
that merge even though nobody pulled local `main` (`git -C <worktree> merge-base --is-ancestor
<merge sha> HEAD` exits 0), and its branch tracks nothing (`git -C <worktree> rev-parse
--abbrev-ref @{u}` fails with `no upstream configured`). Under that line both print the same
`dispatch, in order:` block — `worktree create … --base <that commit>`, the bootstrap when the repo
declares one, `agent start … -- --dangerously-skip-permissions`, `dispatch --task` — so a worker
dispatched at registration is started with the flag too (#118). Until its agent is detected, for up
to five minutes from the dispatch (or from `worktree create`, once that binds), the task's own line
in `hpipe status` ends ``… unknown — dispatch under way — see `hpipe show --task <id>` ``, and nothing
is listed under `waiting on you:` (#120, #135). A digest sent in the grace carries the rest of the
dispatch in full, starting at `worktree create` while the task has no worktree. Every task line that is
not waiting on you ends with its move clause the same way (`— worker's move: waiting for …`,
`— nothing for you …`); a task waiting on you carries its clause under `waiting on you:` instead,
never on both.
Within a tick or two `hpipe status` shows the task bound: its `agent_status` stops being `unknown`.

**Failure looks like (handoff):** `dispatch --task` exits 1 naming a herdr code. `agent_prompt_stalled`
means herdr saw no working state within 5s of submitting — `herdr pane read` the pane to tell a
brief left unsubmitted from one that never arrived. Passing the brief on the `agent start` line instead
fails every task with `invalid_agent_argument`; that is the defect this step replaced (#11).

**Failure looks like:** the task still shows `unknown` and `hpipe status` never names a pane. The
binding comes from two separate events — `worktree.created` (matched on `branch`, sets
`workspace_id`/`checkout_path`) and `pane.agent_detected` (sets `pane_id`); a confirmed `dispatch
--task` also sets `pane_id`, so a lost detection event cannot unbind a briefed worker. If the worktree bound
but the pane did not, the agent was started somewhere the plugin did not see. `hpipe forget
<workspace_id>` unbinds so you can retry.

**Between `agent start` and `dispatch --task` (#89).** Pause for a tick after `agent start` and run
`hpipe status` before dispatching: the task is listed under `waiting on you:` as `YOUR move: its
agent in <pane> has not been handed the brief — <hpipe> dispatch --task <id> --pane <pane>`. It must
**not** read `worker idle with nothing at <research path>` — that was the false alert every freshly
started worker produced — nor a bare `worker's move`. Once `dispatch --task` confirms, the entry
goes and the line reads `worker's move: waiting for its research artifact`. An old run whose tasks
were registered before this change never shows the "not handed the brief" line. While paused,
`herdr agent get <pane>` must **never** read `working` before `dispatch --task`: a positive
`working` is what the supervisor takes as proof the brief arrived, so a boot-time `working` would
bring the false alert back — record it as a finding. Leave one agent unbriefed past
`STALL_MINUTES` (15) after the bind: its probe must arrive in the **orchestrator's** pane with the
`dispatch --task` advice, never in the worker's pane.

Once **both** tasks are bound, the run reads `[execute]` within a tick or two — even when the
orchestrator dispatched them straight after registering them, before the run itself had entered
`dispatch`. That ordering is the normal one, and it is what #22 deadlocked on.

**Failure looks like (dispatch → execute):** the run sitting in `[dispatch]` with both tasks bound
and advancing past `research`. That is the #22 deadlock back; the ledger will show both tasks'
`adopted_at` older than the run's `phase_entered_at`.

**The unstarted-worker check (#12).** For one extra task, run `worktree create` and stop — no
`agent start`. `herdr agent get <root_pane_id>` answers `agent_not_found`, and `pane list` shows the
pane with no `agent` field. For the first five minutes nothing flags it (the bootstrap grace). After
that, `hpipe status` lists the task under `waiting on you:` and the next digest's `also waiting on
you:` footer lists it too, both as `YOUR move: no agent detected in its worktree`, telling you to
check `herdr pane list --workspace <ws>` before `agent start` + `dispatch --task`. `STALL_MINUTES`
(15) after phase entry the **orchestrator** is probed with that same advice rather than "nothing has
appeared at <path>". Then start the agent and dispatch: all three go quiet within a tick of
`pane.agent_detected` or the confirmed `dispatch --task`, and the stall ladder **re-arms**:
`hpipe show --task <id>` lists the pane, and the worker's first probe comes a full
`TASK_STALL_MINUTES` (45) after the bind, as probe 1 — the orchestrator's probes do not count toward
its escalation. If the task is still flagged once its agent is working, the pane never bound, which
is the failure above, not this one.

Kill that worker's pane (`herdr pane close`): the task goes to `failed`, `hpipe show` reports
`pane: none (last: <pane>)` and `agent: unknown`. herdr 0.9.0 sends `pane.closed {pane_id, workspace_id}`
for `pane close`, including a workspace's last pane (measured over the socket, #103 review), so
`plugin log list` should show a `pane.closed` hook run; if it does not, the plugin hook is not being
dispatched and the supervisor's `pane list` reconciliation failed the task within two ticks instead.
`herdr workspace close` sends only `workspace.closed`, never `pane.closed`, so reconciliation is the
only path there. Closing a workspace's last pane, or moving it out, closes the workspace too: `hpipe show`
must then read `workspace: none` within two ticks (the `workspace.closed` hook, or the supervisor's
`workspace list` reconciliation), never the dead id (#116). `hpipe rewind <run> research --task <id>` then brings the task back as unstarted,
not as bound to the dead pane. If its workspace went too (`workspace: none`), `hpipe status` lists it under
`waiting on you:` at once as `YOUR move: no worktree and no agent — herdr worktree open --cwd … --branch …`
(its checkout survived, so `open`, with `create` only on `worktree_not_found`), ending in `dispatch --task`, and
its stall probe to the orchestrator says the same rather than naming the research path. Follow it: `worktree open`
must bind the task (`hpipe show` → `workspace: w<n>`) through the `worktree.opened` hook. Repeat with a rewind
into `implement` instead: after `agent start` one message arrives on its own — the brief without its research
section, then the implement prompt — and the advice never also asks for `hpipe brief`.

Move a bound worker's pane to another workspace (`herdr pane move <pane> --new-tab --workspace <w>`):
herdr renames it (`w3:p2` → `w5:p2`) and keeps its terminal. The task must stay in its phase and
`hpipe show` must name the new pane id, never `failed` (#86).

Close a worker's pane while its task is in `merge` or `close`: the task keeps its phase, its pane is
released (`pane: none (last: …)`), and a dependent is not `blocked-on-failure` (#86). Do it once with
`pane close` and once with `workspace close`, then merge both PRs: each must end `teardown→done worktree
removed`, never `orphaned`, its checkout directory must be gone (`git worktree list` no longer shows it),
and `hpipe status` must not call it a dead end (#116). Its local branch goes only if `git branch -d` accepts it.
Repeat once with an untracked file left in the closed task's checkout. The task still ends `done`, now
`worktree kept: <path> (modified or untracked files)`, and the file is still there.

---

## 2. Two workers at `spec` simultaneously — the fan-out check

**This is the assertion no unit test can make.** A single supervisor tick can produce prompts for
several panes at once. The previous design returned one delivery per tick and dropped the rest,
which was only safe because every prompt-producing row had the same recipient. With nine
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
  whose move it is: `YOUR move: …`, `worker's move: waiting for …`, `needs a human: <rewind cmd>`,
  `dead end`, or `nothing for you …`. A move clause always names what it waits for — `YOUR move:
  waiting for PR #7 to be merged`, `worker's move: waiting for its spec artifact` — and the noun
  phrase after `waiting for` is the one the stall probe for that row uses. A bare `YOUR move` or a
  bare `worker's move` is a **finding** (#95). A line of the old shape — `branch (#n, tN) done`,
  carrying herdr's agent status and nothing else — is a **finding**: that form is what issue #13 was filed over, because
  `done` there means "the agent stopped typing", not "the phase completed".
- **Confirm the `→` arrow specifically.** #13 shipped without ever being observed live: the
  supervisor that drove its own run was the released plugin, so the transition box has only ever
  been exercised by unit tests. Watch for one digest where a phase advances and record whether the
  box reads `[research → spec]` rather than `[spec 0m]`.
- **An idle worker in `research`, `spec` or `plan` with nothing at its artifact path** (#23) must
  not read as `worker's move: waiting for …`: its line reads `YOUR move: worker idle with nothing at
  <path>` followed by what the adoption scan found — `its branch added no document to adopt` or
  `N candidates, too many to adopt: …` — and `hpipe status` lists the same clause under
  `waiting on you:`. To provoke it, answer a worker's research prompt without writing the note. A
  line that says `worker's move` for that pane is a **finding**; so is the entry surviving once
  the worker is busy again. A worker that was never handed its brief is the exception — see #89
  above. So is a worker whose prompt for this phase has not reached it (#136): while that prompt
  is held by stuck input its line reads `YOUR move: its <phase> prompt is held by text in the input
  box of <pane> — …` beside the `⚠ stuck input in <pane>` line, while it fails to reach the pane
  `YOUR move: its <phase> prompt has not reached <pane> — …`, and while it is merely queued
  `nothing for you — its <phase> prompt is queued for <pane>`. `worker idle with nothing at` for
  a worker owed its phase prompt is a **finding**.
- **A digest may end with an `also waiting on you:` footer** listing tasks that produced no event at
  all — a task parked in `merge`, `close` or `blocked-on-decision` emits nothing, so on a tick that
  is already sending a digest the footer is what reports it. Every task it names should also appear,
  with the same clause, under `hpipe status`'s `waiting on you:` section (status also lists dead
  ends, which the footer leaves out) — both use one predicate and render `actionFor`, so a
  different recovery command between the two is a finding. Every `hpipe status` task line should
  read `[<phase> Nm]`, and the minutes should match the digest's box for the same task.
- **Leave one worker idle with an uncommitted edit** in `implement` (or either PR review): within a
  tick of it going idle, `hpipe status` should list it under `waiting on you:` as `YOUR move:
  worker idle with N uncommitted path(s) (…) — have it commit and push`, and the entry should
  vanish the moment the worker goes busy. The supervisor runs one `git status` per idle spell, not
  per tick; a git process per second in `ps` while it sits idle is a finding. So is a checkout
  whose bootstrap leaves untracked, un-ignored files, which would flag every idle worker.
- **Independently of any digest, a task parked in `ci`, `merge`, `close`, `teardown` or `escalated`
  is probed in the orchestrator's pane every `TASK_STALL_MINUTES`** (#19). In a genuinely quiet
  window that probe is the only thing that speaks. Confirm one arrives; that its clause names what
  the row is waiting for rather than `whatever clears <phase>`; and that the task is **never**
  escalated by it, however long it sits — those five rows are probe-only for ever (§4c).
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

Both tasks share a file prefix, so after `plan-review` clears, each enters `blocked-on-files`. Every
tier passes through it on the way to `implement`: a heavy or standard task enters it from
`plan-review`, and a light task, which skips `plan-review`, enters it straight from `plan`.
`releasableFromFiles` then makes **one pass in `task_id` order and releases at most one task per overlapping group per tick**.

**Assert:**

1. Exactly one of `t1`/`t2` leaves `blocked-on-files` for `implement`. Never both, not even one
   tick apart. Because the sort is `task_id.localeCompare`, `t1` should win — record which
   actually did.
2. The loser stays in `blocked-on-files` and `hpipe status` prints, every time you run it:

   ```
     ⚠ t2 blocked on files held by t1 (implement) — waiting for it to finish
   ```

   Only a holder that has stopped moving (`failed`, `escalated`, …) reads `— it has stopped
   moving, so only a release clears it` instead, and then `t2` also appears under `waiting on
   you:` carrying the rendered `<hpipe> release --task t1` — once, not on both lines.

   The holder phase in that line should track `t1` as it moves: `implement`, `pr-review` (light and
   standard), `pr-review-intent` and `pr-review-quality` (heavy), `ci`, `merge`, `close`, `teardown`
   all hold files. Pinned heavy, `t1` passes through the heavy pair.
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
   worker's recommendation, and the exact `hpipe answer` line to run. The prompt arrives **on its
   own**, with no `also waiting on you:` footer: it is sent directly, outside the digest courier
   that renders footers, and a footer line about the very task the prompt is about would say less
   than the prompt does (#93). The task then reaches the next digest anyway, because the worker
   ends its turn after `hpipe decide` and that idle is a pane event: an event line
   `- tN <branch> (#n) [blocked-on-decision 0m] agent:done — YOUR move: waiting for an answer to
   the open decision`. If the worker's idle was missed, the same clause appears in that digest's
   `also waiting on you:` footer instead. Either way, a `YOUR move` with nothing after it is a
   finding (#95).
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
   consequence of a successful send, never of the write — and successful means **submitted**: a
   long answer can sit in the box as `❯ [Pasted text #N +M lines]` after herdr already reads the
   agent `working`, and the phase must not move while it does (#117). The supervisor sees it
   submitted on a later tick, so a slow submission never holds other deliveries. Typing beside the
   held paste must hold the answer as `⚠ stuck input`, not resume the task.

   Do it in this order so you can see it: `hpipe status`, then read the pane, then `hpipe status`
   again.
6. **A decision asked after the phase's artifact is written** (#115). Have a reviewer write its
   verdict and then `hpipe decide` before the supervisor clears the phase. Once the answer lands and
   the worker goes idle again, the phase clears on that verdict (or on the one it rewrote) within a
   tick or two — it must not sit `[<phase> Nm] done` until a stall probe. The older verdict counts
   only once herdr has reported the worker `working` after the answer was sent; if the worker idles
   without that report, the phase waits for a newer verdict or the stall probe, which is a finding.

**Failure looks like:** the phase moving while the pane still shows the old prompt (the worker
would resume having never read the answer, with `run.history` asserting otherwise — a serious
finding), or `hpipe status` reporting

```
  ⚠ t1 decision <id> answered but undelivered (N delivery attempts) — a fresh `hpipe answer` re-arms delivery
```

with N climbing. That means the send is failing; check the supervisor pane and whether the worker's
pane is alive. After `PROMPT_RETRY_MAX` (5) attempts delivery stops being retried and a fresh
`hpipe answer` is the only way to re-arm it. A send held because the pane is gone or backing off
(§4d) is not an attempt and does not move N.

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
row whose signal the probed actor produces itself (`research`, `spec`, `plan`, the five review
rows, `implement`, and the run's `branch-review` — ten in all) is moved to `escalated` and reported
by `hpipe status`.

Nine rows are probed but **never** escalated: `blocked-on-files`, `blocked-on-decision`, the last
mile (`ci`, `merge`, `close`, `teardown`), a task already in `escalated`, and the run's `dispatch`
and `execute`. They are waiting correctly — on a sibling task, on GitHub, or on you — and escalating
them would cascade their dependents to `blocked-on-failure`. Their probe says so, and names what it
is waiting for: the PR to merge, the issue to close, `gh pr checks <pr>`, or the `rewind` that
resumes an escalated task.

If the actor's pane reports `working` when escalation comes due, it is deferred one interval, up to
`STALL_PROBE_MAX` times, then escalated anyway. Nothing waits forever.

### 4d. Delivery to a pane that cannot answer

Every supervisor prompt is sent with `herdr agent prompt --wait --until working --until blocked` and
counts as delivered only once herdr sees the agent take it up. A phase prompt, run prompt or
escalation is written to the run's `outbox` in the ledger **before** it is sent and removed only
when it lands; digest event lines are not kept. Sends are gated per pane: a pane missing from
`herdr pane list` gets nothing, a pane that fails is retried at 5s, 10s, 20s… up to
`DELIVERY_BACKOFF_MAX_SECONDS` (300), and no tick sends more than `DELIVERY_SENDS_PER_TICK` (8).

1. **Dead orchestrator, workers keep moving.** With a task mid-`spec`, `/exit` the orchestrator's
   Claude (leave the pane as a shell). Let the worker finish `spec`, and have it `hpipe decide` once
   the orchestrator is dead. **Pass:** the task still advances to `spec-review` and its prompt lands
   in the worker pane; the supervisor pane logs `delivery to <orchestrator pane> failed
   (agent_not_found)` **once**, not every tick; and `hpipe status` shows `⚠ orchestrator pane <id>
   has no live agent` at once, and `⚠ 1 decision for the orchestrator undelivered for Xm (pane <id>
   has no live agent; N failed attempts, last agent_not_found)` once the decision is owed. Decisions,
   answers and held stall probes are counted there as well as outbox prompts; the reason comes from
   the live supervisor's `delivery.<session>.json` in the state dir. Count sends in the supervisor
   log: no more than one attempt per backoff interval.
2. **Resume.** Restart Claude in that pane (`herdr agent start …`) or `claim` a new one. **Pass:**
   within a tick of the agent reporting idle, the held decision prompt and outbox prompts arrive, and
   the digests the dead window lost are replaced by **one catch-up digest** — `[pipeline] run <id> —
   catch-up` naming every task's phase, age and whose move it is, from the ledger — not by a replay
   of their stale event lines. It goes to whichever pane now drives the run, a claimed one included.
   The log says `delivery to <pane> recovered`, and the `hpipe status` lines are gone.
3. **Gone pane.** Close a worker's pane outright while its task waits on a prompt. **Pass:** the log
   says `pane <id> is gone; holding …` once, `hpipe status` names what is held for it — `⚠ 1 stall
   probe for tN's worker undelivered for Xm (pane <id> is gone)` once its probe comes due — the
   task's stall ladder still climbs and escalates on time, and nothing is sent to the missing id.
4. **Stuck input box.** In an idle worker pane, type text without submitting it, then trigger a
   prompt to that worker (a rewind into its phase, or a stall probe). herdr's `agent prompt` does not
   clear the box, so a send there would be submitted with your text prepended — measured with Claude
   Code 2.1 in an isolated herdr 0.9.0 session, and the agent then ignored the prompt as a draft. The
   supervisor therefore reads the box (`pane read --source visible --format ansi`) before **every**
   send, dropping faint text, which is how Claude draws its prompt suggestion. Text between the two
   rules framing the `❯` box that is not the send's own holds the send: the log and `hpipe status`
   say `stuck input in <pane>`, and nothing is sent there until the box is empty. The box is read
   once per tick while it stays stuck. On the orchestrator's pane, where you type, any text holds
   the send and nothing is ever pressed. On a worker pane the only text it clears is a send the supervisor saw stall on that pane since its
   last confirmed delivery, and a box holding nothing else: one `ctrl+c`, only if the agent reads idle both before the box is read
   and again immediately before the press, only if every line of the box is a `[Pasted text #N…]`
   placeholder or a piece of that prompt, and never twice to one pane within 10s — a second press
   inside Claude's "again to exit" window quits the agent. **Check** that a draft typed into the
   orchestrator's box before a decision prompt leaves the draft intact, holds the prompt, and
   produces that status line; that submitting or clearing the draft releases it within a tick; that a
   box showing only Claude's greyed suggestion does **not** hold anything; that no clear ever hit an
   empty box or a working agent; and that the box parser still recognises the Claude version in use
   (a changed layout makes it read no box and send as before, which is the pre-#92 behaviour). **Record** how the box renders, with
   `herdr pane read <pane> --source visible --format ansi | cat -v`: a typed draft must carry no
   `^[[2m` (faint) before it, or it would be dropped as a suggestion and sent over; a pasted draft
   must show its `[Pasted text #N…]` placeholder (kept even if faint); and a named session's top
   rule must still show at least two `─` before its name in the narrowest pane you use. When the
   held send is a worker's phase prompt, also check that the task names the held prompt rather
   than `worker idle with nothing at …` (#136; see §2).
5. **Usage limit.** If a session hits its limit during the run, record the code the supervisor logs
   for sends to it. `agent_prompt_stalled` or `agent_not_ready` means the gate backs it off and holds
   its prompts; a success means a limited Claude still takes prompts up, and the outbox cannot see
   the limit — a finding.

## 5. The subagent / `agent_status` question — OPEN, record the answer here

**The question.** During `spec-review`, `plan-review`, `pr-review`, `pr-review-intent` and
`pr-review-quality`, the worker dispatches a *review subagent*, and during `implement` the Sonnet
subagent that writes the code; either way it is told to wait for it within its own turn. The
supervisor gates every artifact-and-verdict row, and `implement`, on the worker pane reading `idle`
or `done` (via `herdr agent get`, double-checked after `ACTOR_SETTLE_MS`). Three adversarial rounds could not
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

Let `t1` go all the way. The route after `implement` follows the tier: pinned heavy, it is
`implement` → PR → `pr-review-intent` → `pr-review-quality` → `ci` → `merge` → `close` → `teardown` →
`done`; a task on the `standard` default goes `implement` → PR → `pr-review` → `ci` → … instead. Then
`t2` releases and follows. When both are `done` and
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
  assert: the new supervisor logs `closed dead supervisor panes: <supervisor_pane_id>; their last
  output is in …/supervisor.<session>.crash.log`, that file holds the dead pane's `supervisor exited`
  tail, and
  `pane list --workspace <pipeline workspace>` shows exactly one "Pipeline supervisor" pane (#97).
  Invoking the action again while it runs prints `already running` and opens nothing.

---

## 7. Review tiers — two batches

Every task carries a tier, `light`, `standard` (the default) or `heavy`, and the tier decides which
review rows it visits:

| Tier | After `plan` | After `implement` |
| --- | --- | --- |
| `light` | `blocked-on-files` — no `plan-review` | `pr-review` → `ci` |
| `standard` | `plan-review` → `blocked-on-files` | `pr-review` → `ci` |
| `heavy` | `plan-review` → `blocked-on-files` | `pr-review-intent` → `pr-review-quality` → `ci` |

§1–§6 pin both tasks heavy, so none of that routing is exercised there. These two batches are its only
live check. Run them against `victorstein/hpipe-smoke`, each in a fresh session: repeat Setup with
`export SMOKE=pipesmoke<N>` and the next unused `N`, so neither batch's ledger mixes with another's.

**Upgrade first.** The supervisor is long-lived and keeps the code it started with. If any session
that will drive these batches was up before this build was installed or linked, close its `Pipeline
supervisor` pane and run the plugin's `supervisor` action (or restart the session), then check that
`hpipe status` reads `supervisor: live (pid N)` with a new pid. A supervisor still on the old phase
table routes every task as heavy while the CLI briefs it for its tier: a `light` or `standard` task
reaching `pr-review-intent` is that, not a routing bug.

### 7a. Batch A — one task per tier

Three throwaway issues, with **disjoint** `--files` and no `--depends-on`, so no collision or gate
staggers them. File the light one with a tier label; it is the only live check of the label read:

```bash
gh label create pipeline:tier-light 2>/dev/null   # once per repo
gh issue create --title "smoke tier light" --body "…" --label pipeline:tier-light   # <a1>
hpipe task --branch smoke/tier-light    --issue <a1> --surface <surface> --files <p1> --tier standard --keep-worktree
hpipe task --branch smoke/tier-standard --issue <a2> --surface <surface> --files <p2> --keep-worktree
hpipe task --branch smoke/tier-heavy    --issue <a3> --surface <surface> --files <p3> --tier heavy --keep-worktree
```

`--keep-worktree` is there because each task's verdict files live in its checkout, which `teardown`
otherwise removes before you can read them.

**Observe at registration:** the line after `task_id:` reads, in order,
`tier: light (label pipeline:tier-light; --tier said standard)`, `tier: standard (default)` and
`tier: heavy (--tier)`. Every `hpipe status` task line carries the tier after its phase box —
`[research 2m] light …`.

**Assert, for each task once it reaches `done`:**

1. `hpipe show --task <id>` prints `tier:` with the task's tier, a `tier log:` holding only its
   registration entry (`<time> — → light (label pipeline:tier-light; --tier said standard)`), and a
   `visited:` line that walks the table above:

   ```
   light     research → spec → spec-review → plan → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done
   standard  research → spec → spec-review → plan → plan-review → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done
   heavy     research → spec → spec-review → plan → plan-review → blocked-on-files → implement → pr-review-intent → pr-review-quality → ci → merge → close → teardown → done
   ```

   A returned review shows as a repeat (`… → spec-review → spec → spec-review → …`) and a decision as
   `blocked-on-decision` between two entries of the same phase; both are fine. A row the tier skips
   appearing, or one it runs missing, is a finding.
2. **The implement subagent ran on Sonnet.** While a task is in `implement`, read its pane
   (`herdr --session "$SMOKE" pane read <worker_pane> --source visible --lines 60`) and record the
   subagent dispatch. Then confirm from the transcripts, which name the model on every message:

   ```bash
   grep -rhoE '"model":"[^"]+"' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*<worktree dir name>*/ | sort | uniq -c
   ```

   **Expect:** the worker's own default model (Opus) and a Sonnet model, with Sonnet only in a
   subagent started during `implement` (or `ci` red, which delegates the same way) — never in a
   review subagent, whose prompts pin no model. A PR body saying the model was rejected and the
   subagent ran unpinned is the prompt's fallback; record it as a finding. So is a worker writing the
   code itself with no subagent at all.
3. **`Tier:` atop each verdict.** For every path under `verdicts:` in `hpipe show --task <id>`,
   `head -1 <checkout>/<path>` reads `Tier: <the task's tier>`.
4. **`branch-review` runs.** Three tasks landed, so once the last is `done` the run goes `execute →
   branch-review`, the orchestrator's pane gets the final-review prompt, and its verdict opens
   `Tiers: t1 light, t2 standard, t3 heavy`. It clears to `done`.

**Record:** each task's `visited:` line, the transcript counts from 2, and the wall-clock time each
task spent from `implement` to `ci`.

### 7b. Batch B — a raise mid-run, and one task landing

One throwaway issue, registered light:

```bash
hpipe task --branch smoke/tier-raise --issue <b1> --surface <surface> --files <p1> --tier light
```

Once `research` has cleared and the task reads `[spec …]`, raise it from your own pane, inside the
smoke session and the repo — the same move `prompts/research.md` tells a worker to make when research
shows the task is bigger than its tier:

```bash
hpipe tier --task t1 standard --why "smoke: research found it touches a contract"
```

**Expect:** `t1: light → standard. spec completes as it is; the next step follows standard.`

**Assert:**

1. `hpipe show --task t1` reads `tier:       standard`, and its `tier log:` records both entries —
   `<time> — → light (--tier) · <time> light → standard (hpipe-tier, pane <your pane>): smoke: research
   found it touches a contract`. The raise must not appear in the ledger's `run.history`; tier changes
   are kept out of it on purpose.
2. Once `done`, `visited:` includes `plan-review` after `plan`, which the light route skips, and still
   runs one `pr-review`, never the heavy pair:
   `research → spec → spec-review → plan → plan-review → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done`.
3. **`branch-review` is skipped.** One task landed, so the run goes straight from `execute` to `done`:
   the orchestrator never receives a final-review prompt, and the ledger's last run entry reads
   `execute → done` with why `one task landed; branch-review skipped`:

   ```bash
   jq '.history | map(select(.task_id == null)) | last' "$STATE/runs/$SMOKE/<run_id>.json"
   ```

4. **Record whether the orchestrator heard that the run ended.** An open question: nothing is known to
   prompt the orchestrator on `execute → done`, so it may be silent. Read the orchestrator's pane
   (`pane read … --lines 40`) a tick or two after the run reads `done` and write down the last thing
   the pipeline sent it — a digest naming the run's end, the task's `teardown → done` line alone, or
   nothing — and whether `hpipe status` then shows the run as ended. A silent end is data for that
   question, not a failure of this step.

`hpipe tier` never lowers from a pipeline pane: `lowering a tier needs a human; run this from your own
pane`. If you want the live check of that guard, have the orchestrator run `hpipe tier --task t1 light
--why test` from its pane before `plan` clears; it must exit 1 and add nothing to `tier log:`.

---

## What to do when a step fails

The ledger is at `$STATE/runs/$SMOKE/<run_id>.json` — read it, never hand-edit it. All of these run
from the orchestrator pane.

| Symptom | Recovery |
| --- | --- |
| A phase advanced early, or on the wrong file | `hpipe rewind <run_id> <phase> [--task <task_id>]` — resets the phase, clears review-pass counters and `delivery_attempts`, discards an undelivered answer (recorded in history), and clears `escalated_from`. Rewinding a *run* to `dispatch` leaves every worktree bound; the run returns to `execute` on the next tick unless a dispatched task still has no worktree. Rewinding a *task* to `implement` or earlier forgets its recorded PR and CI state, so `hpipe status` shows neither until `implement` rediscovers the open PR. Rewinding *onto* a review phase also reserves a fresh verdict path and prints it; write the next review there. The rewind queues the new phase's prompt, naming that same path, for whoever owns the phase — the worker, or the orchestrator for `merge`, `close` and the run's own phases — and says so; the supervisor sends it on its next tick. A task rewound into `research` with no worker bound gets nothing queued: `dispatch --task` delivers that prompt inside the brief. |
| A task is stuck in `blocked-on-files` behind a holder that will never finish | Get the holder terminal first (`hpipe rewind … --task <holder>` to a phase it can finish, or let it fail), then `hpipe release --task <holder>`. `release` refuses while the holder is in flight, and only accepts a terminal or `escalated` task. |
| A decision is open and the worker is stopped | `hpipe answer --task <t> --decision <id> --answer "…" --by orchestrator\|human`. If status shows "answered but undelivered" with attempts climbing, a fresh `hpipe answer` re-arms delivery. |
| A phase burned through `MAX_PASSES` (2) and escalated | Settle the dispute with the human, then `hpipe rewind <run_id> <phase> [--task <id>]`, which clears every pass counter on that record and, for a review phase, prints the fresh verdict path it reserved. |
| A phase was escalated by the stall ladder | `hpipe status` lists the task under `waiting on you:` as `tN <branch> (#n) [escalated Nm] — needs a human: <rewind command> resumes it, <rewind … failed command> abandons it` (a run shows `⚠ run escalated from <phase> … needs a human`). Deal with whatever it was waiting for, then `hpipe rewind <run_id> <phase> [--task <id>]`, which re-arms the ladder from zero. To drop an escalated task instead, `hpipe rewind <run_id> failed --task <id>`: until one of the two is run the run stays in `execute`, the task's dependents stay `queued`, and the run gives up its orchestrator pane to any other run driven from it. |
| The whole run is wrong and you want out | `hpipe abort <run_id>` — leaves worktrees and branches alone, releases the repo for a new `hpipe start`. Undo with `hpipe resume <run_id>`, which puts it back where it was. |
| The orchestrator pane died or changed id | `hpipe status` flags it (`⚠ orchestrator pane … is gone`). Run the plugin's `claim` action from the pane that should drive the run. |
| The supervisor died | `hpipe status` reports `supervisor: none\|stale`. Reopen with `herdr plugin action invoke stein.pipeline.supervisor`. Nothing advances until it is back; no state is lost. |
| A task is bound to the wrong workspace | `hpipe forget <workspace_id>` clears `workspace_id` and `pane_id` so the binding can be re-made. It does not hand the checkout back: once the task merges, teardown still removes it by path when it is clean, on the task's branch and pushed. Register the task with `--keep-worktree` to keep it. |
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

Close the two throwaway GitHub issues (`<n1>`, and `<n2>` filed by `--title`) and delete the smoke branches and PRs. If the run merged
anything into `main` of a real repo, revert it — nothing in this runbook is work you want to keep.
