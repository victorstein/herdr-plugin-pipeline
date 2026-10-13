# Live smoke runbook — worker-owned pipeline

One real herdr session, one real repo, two real Beads beads, two real worker agents. Budget
45–90 minutes: the workers do actual research/spec/plan work and you wait on them.

> **A step whose observed behaviour differs from what is written here is a FINDING to bring back,
> not a test to make pass.** Do not edit the plugin mid-run to make an assertion go green. Write
> down what you saw — the phase, the pane, the `hpipe status` output, the timestamps — and stop.
> Everything the plugin owns is bookkeeping; abandoning a run costs nothing.

The unit suite is 327 green and proves none of what follows. The first live run of the previous
design found two startup/gating defects that dependency-injected fakes had passed cleanly, and
§5 below is an open question three adversarial review rounds could not settle statically.

## What you need

- herdr 0.9.0+, `bun`, `bd` 1.3.1+ (`brew install beads`), and `gh` authenticated against a repo you may
  open and close throwaway PRs in. `bv` 0.25.2+ is needed only for §8; you install and run it yourself.
- A target repo with at least one `.claude/agents/<surface>-dev.md`. `hpipe task --surface <s>`
  is rejected when `.claude/agents/<s>-dev.md` does not exist, so check first:
  `ls <repo>/.claude/agents/`.
- Two branch names you are happy to throw away. The beads are filed by `hpipe task --title`; they live in
  the plugin's state dir, not in the repo.

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

Now let the orchestrator do intake for real: two tasks, each backed by a bead. The first is filed up
front and adopted with `--bead`; the second is filed *by* `hpipe task --title … --body-file …`, which is
the only live check of that path. The registration must give the two tasks **overlapping `--files`** —
that is the setup for §3 and the whole reason this run uses two tasks.

First, one deliberately malformed registration, **typed by hand, before the orchestrator registers
anything** — this is the check that `--files` is validated at all, and it is supposed to fail:

```bash
hpipe task --branch smoke/bad --bead nobead-999 --surface <surface> --files "src/lib src/lib/config.ts"
```

`--files` is validated before `bd` is asked about the bead, so `nobead-999` is never looked up and this
step needs no bead of its own.

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
grep -c "smoke orphan" "$STATE"/beads/*/.beads/issues.jsonl   # assert: 0 for the repo's store
```

**Expect:** exit 1, `no agent definition at …/nope-dev.md`, and no bead (the grep counts `0`).
**Failure looks like:** a bead titled `smoke orphan` exists — `bd create` ran before validation. Report
it; the bead can stay, the run is not affected.

Now the two real registrations, which the orchestrator runs. Both file their own bead: `hpipe` is the
store's only writer, so no bead exists before a first task files one. `--bead` (adoption) is exercised in §8.

```bash
hpipe task --branch smoke/one --title "<title one>" --body-file <brief1.md> --surface <surface> \
           --files src/lib --tier heavy
hpipe task --branch smoke/two --title "<title two>" --body-file <brief2.md> --surface <surface> \
           --files src/lib/config.ts --tier heavy
```

Both are pinned to `--tier heavy`, the tier that runs every review row, so §3–§6 exercise the same
route every task took before tiers existed. The lighter tiers have their own section, §7.

**Observe on each:** `task_id: tN`, then its `tier: heavy (--tier)` line, then `bead: <prefix>-<n>
(filed)`, exactly one bead per registration (a retried registration must never file twice — `grep -c
"<title one>" "$STATE"/beads/*/.beads/issues.jsonl` counts `1`), and `hpipe brief --task tN` printing the
title, body and `**Acceptance**` you wrote. `hpipe bead show <bead>` shows it `[open]`. If `bd` fails the
command must exit 1 with `bd create failed; nothing was filed or registered` and register nothing. If
registration fails *after* filing, the output must name the filed bead and say `register it with --bead
<id>`; do exactly that.

Write down both bead ids as `<b1>` and `<b2>`.

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

Once you go idle the run moves to `dispatch`. When you have already run every printed block, its
prompt is one line — `Every task that can start has its worktree and its brief: nothing to dispatch
now.`, naming any task still `queued` as arriving later as its own `Dispatch tN` prompt — or nothing
at all when no task is queued and intake is closed. The full dispatch walkthrough arriving after
every block has run is a **finding**.

**Failure looks like:** `found no run in intake, dispatch or execute for <repo> in session <session>`
from `hpipe task` (you are in the wrong repo or session — the message names both), or `no agent
definition at …-dev.md` (wrong `--surface`).

The orchestrator now creates a worktree per task and adopts its root pane:

```bash
herdr worktree create --cwd <repo> --branch smoke/one --base <commit>   # the commit on the base: line
# capture .result.root_pane.pane_id
herdr agent start smoke-one --kind claude --pane <root_pane_id> -- --dangerously-skip-permissions --effort high
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
`dispatch, in order:` block — `worktree create … --base <that commit>`, a `#` line saying the create
JSON gives the checkout as `.result.worktree.path` and its pane as `.result.root_pane.pane_id`, the
bootstrap when the repo declares one (an `# optional:` step running `./bin/bootstrap` or the like when
the repo has one it never wired in), `agent start <bead> … -- --dangerously-skip-permissions`,
`dispatch --task` — so a worker
dispatched at registration is started with the flag too (#118). The `agent start` line names the agent
by the task's bead id, with no `<name>` left in it: run it verbatim, and `herdr agent list` shows the
agent under that name. A refusal of the name, or of a second start under it after a rewind, is a
finding. Until its agent is detected, for up
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

- In **worker one's pane**: exactly one prompt, headed for *its* branch and *its* bead id (`<b1>`),
  naming *its* spec path.
- In **worker two's pane**: exactly one prompt, naming `<b2>` and its own spec path.
- In **neither pane**: a prompt containing the *other* task's bead id, or two prompts
  separated by a `---` rule. `deliveriesFor` joins same-pane prompts with `\n\n---\n\n`; that rule
  is correct when both fragments belong to that pane, and is the signature of the bug when the
  fragments name two different branches.
- In the **orchestrator's pane**: a digest, not a worker prompt. Worker prompts go to worker panes;
  the orchestrator only gets `[pipeline] run <id> …` digests and the dispatch/merge/close/decision
  prompts that are its own. Every event line in that digest must carry, in this order, the task id,
  the branch and bead id, a bracketed phase box with the age in that phase — `[spec 12m]`, or a
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
- **Leave one worker idle with an uncommitted edit** in `implement` (or any review): within a
  tick of it going idle, `hpipe status` should list it under `waiting on you:` as ``YOUR move:
  worker idle with N uncommitted path(s) (…) — `hpipe nudge --task tN` tells it to commit, push
  and finish implement``, and the entry should vanish the moment the worker goes busy. Run that
  nudge: the worker should get `# Carry on — implement (tN, …)` naming the paths, `status` should
  read `its nudge to carry on is queued` until it lands, and a second nudge should answer `a resume
  is already queued`. With a background shell running in the worker's pane the nudge must be
  refused, naming the shell. The supervisor runs one `git status` per idle spell, not
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

   The holder phase in that line should track `t1` as it moves: `implement`, `pr-review` (every
   tier), `ci`, `merge`, `close`, `teardown` all hold files. `t2`'s own task line, and any digest line
   about it, names the same holder: `— nothing for you — waiting for t1 (implement) to free the files
   it holds`. A digest that says no task holds its files while status still prints the ⚠ line above
   is a finding. A task nothing holds passes through `blocked-on-files` in a tick, and its digest line
   is held for that tick and reads `[plan-review → implement]` (or `[plan → implement]` for light);
   a `[… → blocked-on-files] … no task holds its files now` line in a digest is a finding.
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
   `- tN <branch> (<bead>) [blocked-on-decision 0m] agent:done — YOUR move: waiting for an answer to
   the open decision`. If the worker's idle was missed, the same clause appears in that digest's
   `also waiting on you:` footer instead. Either way, a `YOUR move` with nothing after it is a
   finding (#95).
3. **While the question is open**, `hpipe status` prints:

   ```
     ⚠ t1 blocked on an open decision (Nm): <question>
   ```

   Check this *before* answering. If `hpipe status` does not show it, the question is invisible to
   the human and that is a finding on its own.
4. The orchestrator answers it from the repo — the bead (`hpipe bead show`), `CLAUDE.md`, the surface agent file, an
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
is waiting for: the PR to merge, the bead to be closed by the supervisor, `gh pr checks <pr>`, or the `rewind` that
resumes an escalated task.

If the actor's pane reports `working` when escalation comes due, or shows background work under its
prompt (see §5's second finding), it is deferred one interval, up to `STALL_PROBE_MAX` times, then
escalated anyway. Nothing waits forever.

Each probe states the cadence in force — `sent every 15 minutes` at the defaults, whatever
`config.env` sets otherwise — that a reply does not answer it, and what holds the escalation off; a
probe whose minutes differ from the `This phase has been open N minutes` steps it arrives at is a
finding. A probe to the pane whose work holds its row, when that pane shows background work, names
it: `… This phase does not wait for it.` for a shell or a monitor, and `… it waits up to 10 minutes for
<subagent> to finish, and no longer.` for a subagent. A probe that tells the orchestrator a phase waits
for a shell is a **finding**, and so is one listing the orchestrator's work in a probe about a worker
owed its brief.

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
5. **Usage limit.** Limits are frequent (50 rejected requests in two weeks of worker transcripts), so
   one is likely in any long run. When a pane shows `You've hit your … · resets …`:
   - **Capture it raw**, before anything else touches the pane: `herdr pane read <pane> --source
     visible --lines 40 --format ansi > limited.ansi`, the same with `--format text > limited.txt`,
     and `herdr agent get <pane>`. Never through `grep` or `cut`: the parser needs the box rules and
     the dim `⎿`. Compare them with the fixtures in `test/usage-limit.test.ts` and add them there.
   - **Pass:** the supervisor logs `usage limit in <pane> until <reset>` once; `hpipe status` shows
     the worker `paused by Claude's usage limit, resets …` and `⚠ usage limit in <pane>`; no stall
     probe or escalation reaches it however long the outage; 90 s after the reset the log says
     `usage limit in <pane> lifted`, the worker gets one `Usage limit lifted` prompt and carries on
     without restarting its phase, and the orchestrator gets one note naming it.
   - **Record** what herdr reports for the limited pane (`done` on 2026-10-11), and whether Claude's
     own auto-continue appears (`continuing automatically`); if it does, capture that screen too and
     check that no resume prompt was sent on top of it.
   - `hpipe nudge --task <id>` on a limited worker queues the resume and the log says the hold is
     released; on a worker with no limit line it refuses.

## 5. The subagent / `agent_status` question — OPEN, record the answer here

**The question.** During `spec-review`, `plan-review` and `pr-review`, the worker dispatches a
*review subagent*, and during `implement` the Sonnet
subagent that writes the code; either way it was then told to wait for it within its own turn. The
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

Superseded by smoke run 16: Claude Code now runs every subagent in the background, and a worker told
to wait within its turn polled the verdict file in a foreground sleep loop. Every prompt that
dispatches a subagent now says to end the turn and carry on when its completion notice arrives; the
supervisor reads the agents panel (below), and holds a worker's review row until the verdict is
committed.

#### §5 again: shells, monitors and a parent that took another turn — the pane DOES read `done`

Measured on the berean-os trial run of 2026-10-12. The answer above holds only while the parent's
last line is `✻ Waiting for N background agents to finish`: herdr's claude manifest (2026.09.11.1,
`herdr agent explain <pane> --json`) rules that line, and `· N MCP tasks still running`, as
`working`, and nothing else. Once the parent takes another turn — a Monitor event, its subagent's
report — its last line reads `✻ Cogitated for 2m 27s · done 5:25 PM · 1 shell, 4 monitors still
running` and the pane reads `done`. t3 sat there with its implementer subagent waiting on a firmware
build, and the digest told the orchestrator to have it commit and push. The supervisor now reads the
footer for that work: `⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent`, and the agents
panel's `◯ ui-dev  Waiting on x4pro firmware build … · ↓ 112.8k tokens` row. `← 1 agent` is the
agents-view hint, which a fresh session shows too, and is not work.

To check it: have a worker in `implement` start a background shell (`sleep 600`, run in the
background) and end its turn with an uncommitted edit. Its digest line should read `agent:done,
background work running (1 shell)`, and `hpipe status` must **not** list it under `waiting on you:`.
Kill the shell: the uncommitted-work line should appear within a minute, which is how often the
supervisor re-reads a pane that showed work. A design row whose artifact appears while the pane
shows a subagent (a panel row or `N local agents`) must wait for it, and advance at the latest 10
minutes after the artifact appeared, with `advanced past background work still running (…) after
10m` in its history; with only a shell or a monitor running it must advance at once. Have the
orchestrator wait for a phase change from a background shell polling `hpipe status` once: the phase
must still advance when its signal arrives, and every probe and phase prompt says never to wait that
way. In `branch-review`, let the orchestrator
dispatch its reviewer subagent in the background and end its turn: once the escalation falls due,
`hpipe show` or the ledger's `stall.holds` should climb instead of the run escalating, for as long as
the panel lists the subagent. A pill or a panel row worded differently from these is a **finding**:
record the footer verbatim.

In a worker's review row the reviewer runs in the background: the worker dispatches it and ends its
turn. A `sleep`, `perl -e 'sleep …'` or `until [ -f … ]` loop in its pane is a **finding**, in any
row. The verdict appears while the worker sits idle with the subagent's panel row listed; the task
must stay in its review row, `git -C <worktree> status --short` showing the verdict untracked, until
the completion notice wakes the worker and it commits the verdict, with a `CLEAR`'s fixes. The row
advances within a tick or two of that commit and its push. A transition out of the review row while
the verdict is still untracked in the worktree is a **finding**; so is a review row that stays put,
the worker idle with nothing running, after the verdict is committed and pushed.

#### Environment note

`herdr agent start` returns `agent_not_ready` when Claude Code shows its folder-trust dialog on a
path it has not seen. Trust is per-path: the orchestrator blocked on a brand-new repo, the workers did
not, because `~/.herdr/worktrees/` was already trusted on this machine. On a fresh machine every
worker would block once. Not a plugin bug, but it will stall a first run.

## 6. Finish the run

Let `t1` go all the way. After `implement` every tier takes the same route: `implement` → PR →
`pr-review` → `ci` → `merge` → `close` → `teardown` → `done`. Then `t2` releases and follows. When both are `done` and
intake is closed, the run advances to `branch-review`, whose prompt goes to the orchestrator; it
clears to `done`.

**Along the way, assert:**

- The PR body ends with `Refs <bead id>`; there is no GitHub issue and no `Closes` keyword. After the
  merge, `close` waits for the supervisor to close the bead: within a tick or two
  `hpipe bead show <bead id>` shows `[closed]` with the reason `merged in PR #<n> (<sha>)`, and only then
  does the task move to `teardown`. Nobody is prompted to close it.
- After a review BLOCKER, the task's `head_sha_at_entry` in `$STATE/runs/$SMOKE/<run_id>.json` is the
  PR head at the send-back (`hpipe show` does not print it), and `.history` shows no `implement` exit
  before the worker's fix push appears on the PR.
- If CI goes red and the task returns to `ci`, `hpipe show` reads `ci: none` until the new head is
  polled; a failure, `ci` pass count bump or escalation within 30s of re-entry is the stale result.
- The merge prompt's command is `gh pr merge <n> --squash --match-head-commit <sha>`, `<sha>` being the
  head `hpipe show` prints as `ci: pass (on <sha8>)`, and it reads `Green is for <sha8>, the head CI
  ran on`. The merge it renders goes through.
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
| `heavy` | `plan-review` → `blocked-on-files` | `pr-review` → `ci` |

§1–§6 pin both tasks heavy, so none of that routing is exercised there. These two batches are its only
live check. The smoke repo's changes are small, so a light or standard task whose design reviews
cleared first time goes `implement → ci` and skips its `pr-review` (§10). To walk the rows this table
names, commit `.claude/pipeline-always-review` on `main` listing the batch's `--files` before
registering, and remove it afterwards. Run them against `victorstein/hpipe-smoke`, each in a fresh session: repeat Setup with
`export SMOKE=pipesmoke<N>` and the next unused `N`, so neither batch's ledger mixes with another's.

**Upgrade first.** The supervisor is long-lived and keeps the code it started with. If any session
that will drive these batches was up before this build was installed or linked, close its `Pipeline
supervisor` pane and run the plugin's `supervisor` action (or restart the session), then check that
`hpipe status` reads `supervisor: live (pid N)` with a new pid. A supervisor still on an old phase
table routes by it while the CLI briefs the task by the new one: a task of any tier reaching
`pr-review-intent` is that, not a routing bug.

### 7a. Batch A — one task per tier

Three beads, with **disjoint** `--files` and no `--depends-on`, so no collision or gate
staggers them. A bead the task files carries no labels, so the tier-label read is checked in §8e, where a
bead exists before its task; here the light task is registered `--tier light` and the tier log reads
`(--tier)`:

```bash
hpipe task --branch smoke/tier-light    --title "smoke tier light"    --body-file <body.md> --surface <surface> --files <p1> --tier light --keep-worktree
hpipe task --branch smoke/tier-standard --title "smoke tier standard" --body-file <body.md> --surface <surface> --files <p2> --keep-worktree
hpipe task --branch smoke/tier-heavy    --title "smoke tier heavy"    --body-file <body.md> --surface <surface> --files <p3> --tier heavy --keep-worktree
```

`--keep-worktree` is there because each task's verdict files live in its checkout, which `teardown`
otherwise removes before you can read them.

**Observe at registration:** the line after `task_id:` reads, in order,
`tier: light (--tier)`, `tier: standard (default)` and
`tier: heavy (--tier)`. Every `hpipe status` task line carries the tier after its phase box —
`[research 2m] light …`.

**Assert, for each task once it reaches `done`:**

1. `hpipe show --task <id>` prints `tier:` with the task's tier, a `tier log:` holding only its
   registration entry (`<time> — → light (--tier)`), and a
   `visited:` line that walks the table above:

   ```
   light     research → spec → spec-review → plan → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done
   standard  research → spec → spec-review → plan → plan-review → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done
   heavy     research → spec → spec-review → plan → plan-review → blocked-on-files → implement → pr-review → ci → merge → close → teardown → done
   ```

   A gate no task held reads `blocked-on-files (passed through)`. A returned review shows as a repeat
   (`… → spec-review → spec → spec-review → …`) and a decision as
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
4. **Each review runs at its own effort, and the plan review reads rather than runs.** `hpipe show`
   prints `effort: worker high, reviews high (plan-review medium)` for the standard task and
   `effort: worker high, reviews high (spec-review xhigh)` for the heavy one. In the worker panes, the standard task's
   `plan-review` subagent is dispatched with `effort: medium` and its other reviews with `effort:
   high`. In the `plan-review` subagent's transcript, record whether it ran the build or the tests,
   or copied the worktree to apply the plan: the prompt now tells it not to, so any of those is a
   finding. The plan itself has no step that pushes, opens a PR or runs `hpipe submit`.
5. **`branch-review` runs.** Three tasks landed, so once the last is `done` the run goes `execute →
   branch-review`, the orchestrator's pane gets the final-review prompt, and its verdict opens
   `Tiers: t1 light, t2 standard, t3 heavy`. It clears to `done`.

**Record:** each task's `visited:` line, the transcript counts from 2, and the wall-clock time each
task spent from `implement` to `ci`.

### 7b. Batch B — a raise mid-run, and one task landing

One throwaway bead, registered light:

```bash
hpipe task --branch smoke/tier-raise --title "smoke tier raise" --body-file <body.md> --surface <surface> --files <p1> --tier light
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
   `execute → done` with why `one task merged (PR #<n>); branch-review skipped`:

   ```bash
   jq '.history | map(select(.task_id == null)) | last' "$STATE/runs/$SMOKE/<run_id>.json"
   ```

4. **Record whether the orchestrator heard that the run ended.** An open question: nothing is known to
   prompt the orchestrator on `execute → done`, so it may be silent. Read the orchestrator's pane
   (`pane read … --lines 40`) a tick or two after the run reads `done` and write down the last thing
   the pipeline sent it — a digest naming the run's end, the task's `teardown → done` line alone, or
   nothing — and whether `hpipe status` then shows the run as ended. A silent end is data for that
   question, not a failure of this step. A done notice that arrives lists `t1 … : done, PR #<n> merged`
   and ends with a `Clean up when you are done with it:` block: the task branch on origin (unless
   GitHub deleted it on merge), the local task branch, and a `pull --ff-only` of `main`.

`hpipe tier` never lowers from a pipeline pane: `lowering a tier needs a human; run this from your own
pane`. If you want the live check of that guard, have the orchestrator run `hpipe tier --task t1 light
--why test` from its pane before `plan` clears; it must exit 1 and add nothing to `tier log:`.

---

## 8. Beads — the issue store

**Required versions: `bd` ≥ 1.3.1 (Homebrew core `beads`) and `bv` ≥ 0.25.2.** Check both first:

```bash
bd version && bv --version
hpipe status   # assert: no `tools:` line — it appears only when a tool is missing or too old
```

**Human-only steps.** bv's licence rider forbids Anthropic-related parties from executing it (see the
README's licence note). Every step below marked **(human)** runs `bv` or looks at its board; you do them
yourself, and no agent runs them, reads their output on your behalf, or drives the board pane. The
`bd`-only steps are also yours: `bd` is read here, and written only where a step says so with no run live.

Use a scratch repo with a GitHub remote and CI, as in Setup, a fresh herdr session, and no live run
(finish or `hpipe abort` the earlier sections' runs first). `$STORE` below is
`$STATE/beads/<repo>-<hash>`.

### 8a. Setup

```bash
hpipe start "beads smoke" --prefix bsm
```

**Expect:** `beads: created $STORE with prefix bsm`, then the intake prompt. If the repo's store already
exists from §1 the line reads `beads: prefix <p>, store …` and `--prefix` is ignored; use that prefix
wherever `bsm` appears below.

**Check:** `ls -A "$STORE"` holds `.beads`, `.git` and `project.json`; `$STORE/.beads/issues.jsonl`
exists; `git -C "$STORE" ls-files` prints only `.beads/issues.jsonl` and `git -C "$STORE" log
--format='%an %s'` prints `hpipe init`; if the state dir sits in a repo, that repo gains no commit and
nothing staged. **(human)** a `Board: <repo> <hash>` tab appears in the pipeline workspace within a
tick or two and runs `bv`.

### 8b. One task, open to closed

```bash
printf 'Add a NOTES.md line saying hello.\n' > /tmp/bsm-body.md
printf 'NOTES.md contains hello.\n' > /tmp/bsm-acc.md
hpipe task --branch smoke/bsm-1 --title "Say hello" --body-file /tmp/bsm-body.md \
  --acceptance-file /tmp/bsm-acc.md --surface <surface> --files NOTES.md --tier light
```

**Expect:** `task_id: t1`, `tier: light (--tier)`, `bead: bsm-1 (filed)`. Within a tick or two
`hpipe bead show bsm-1` reads `bsm-1 [open] Say hello`, label `queued`, assignee
`none`, `run: <run-id>`, then the description and `Acceptance` text you wrote.

Run the printed `dispatch, in order:` block. After `hpipe dispatch --task t1`, `hpipe bead show bsm-1`
reads `[in_progress]`, assignee `hpipe`, label `research`. **(human)** On the board (press `b`)
the card moves to the in-progress column and its phase label follows the task through `spec`,
`plan` and `implement` as `hpipe status` shows each.

Merge the PR when prompted. **Expect**, within a tick or two: `hpipe bead show bsm-1` reads `[closed]`
with the close reason `merged in PR #<n> (<sha>)`; `hpipe status` moves the task `close → teardown →
done` and never asked anyone to close anything; **(human)** the card moves to the closed column.

### 8c. `hpipe next` and the dependency graph

```bash
hpipe task --branch smoke/bsm-2 --title "Second" --body-file /tmp/bsm-body.md --surface <surface> --files NOTES.md
hpipe next
```

**Expect** (`bv` is run by `hpipe` on your machine, so this is **(human)**): any `warning:` lines, then
`now (parallel when their --files are disjoint):` — which does **not** list `bsm-2`, because task `t2` holds
it — or, with nothing else open, `nothing to pick up: no open bead is claimable — the backlog is empty, or every open bead is held, blocked or filtered out`.
`hpipe next --limit 1` prints at most one pick.

### 8d. Abort releases, resume re-claims

```bash
hpipe abort <run-id>
```

Within a tick or two: `hpipe bead show bsm-2` reads `[open]`, assignee `none`, label `aborted`,
and `hpipe next` **(human)** now offers `bsm-2`.

```bash
hpipe resume <run-id>
```

Within a tick or two: `bsm-2` reads `[in_progress]`, assignee `hpipe`, its `<phase>` label again,
and `hpipe next` **(human)** no longer offers it.

### 8e. Adopting an existing bead (`--bead`)

Abort the run (`hpipe abort <run-id>`). With **no live run**, file the beads by hand in the store —
the only time you run `bd` against it. `bd` finds the store through its environment:

```bash
export BEADS_DIR="$STORE/.beads" GIT_CEILING_DIRECTORIES="$STATE/beads"
bd create "Adopt me" -l pipeline:tier-light --json --actor smoke   # note the id as <adopt>
bd create "Epic" --json --actor smoke                              # <epic>
bd create "Child of epic" --parent <epic> --json --actor smoke     # <child>
unset BEADS_DIR GIT_CEILING_DIRECTORIES
```

(`bd create --help` is authoritative if a flag differs.) Then `hpipe start "adopt smoke"` and, from the
orchestrator pane:

```bash
hpipe task --branch smoke/adopt --bead <adopt> --surface <surface> --files NOTES.md
hpipe task --branch smoke/epic  --bead <epic>  --surface <surface> --files NOTES.md
hpipe task --branch smoke/dup   --bead <adopt> --surface <surface> --files NOTES.md
```

**Expect:** the first registers with `tier: light (label pipeline:tier-light)` and no `bead: … (filed)`
line — this is the only live check of the tier-label read; the second exits 1 with `bead <epic> has
open child beads (<child>) — an epic or parent bead cannot be adopted; adopt its children instead` and
registers nothing; the third exits 1 with `bead <adopt> is already held by t1 …`.

### 8f. Teardown

`hpipe abort <run-id>`; close the scratch PRs and delete the smoke branches; `rm -rf "$STORE"` only if the
store was created for this smoke (it is the only copy of its beads).

### Findings — Beads

| Step | Result | Notes |
|---|---|---|
| 8a setup, `$STORE` layout, board tab appears | | |
| 8b `--title` files one bead, brief matches | | |
| 8b claim on dispatch, phase labels on the board | | |
| 8b close on merge, teardown follows, no prompt | | |
| 8c `hpipe next` hides the held bead | | |
| 8d abort releases, resume re-claims | | |
| 8e adoption, tier label, refusals | | |

### Deferred checks — confirm on the real tools

None of these could be verified without running the real `bd`, `bv` or herdr. For each, record what you
saw in the table at the end of this section; a result that differs from "look for" is a finding to bring
back, not something to patch mid-run.

1. **bv board legibility (human).** Run a task as in 8b with the board tab open and press `b`.
   *Look for:* the phase labels (`research`, `spec-review`) and the `hpipe:` labels are legible on the kanban
   cards (not truncated). Then give a bead a non-built-in status, with no live run:
   `BEADS_DIR="$STORE/.beads" GIT_CEILING_DIRECTORIES="$STATE/beads" bd update <id> -s deferred`, and
   refresh the board. *Look for:* a `deferred` column exists, or the card is dropped — record which.
2. **Linked-bead field names.** On a bead that has both a `blocks` dependent and a `parent-child` child:
   `BEADS_DIR="$STORE/.beads" GIT_CEILING_DIRECTORIES="$STATE/beads" bd show <id> --include-comments --include-dependents --json`.
   *Look for:* every entry under `dependencies` and `dependents` carries `dependency_type` (`blocks` or
   `parent-child`) and `status`. The adoption refusal in 8e reads exactly those two names; if either is
   called something else, adoption silently lets an epic through.
3. **bd's stderr warning.** Provoke a failing bd write, for example
   `hpipe task --branch smoke/x --bead no-such-bead --surface <surface> --files NOTES.md` (or a `--title`
   run with an unreadable body). *Look for:* hpipe's error shows only bd's real error. Then capture the
   raw text with `BEADS_DIR="$STORE/.beads" GIT_CEILING_DIRECTORIES="$STATE/beads" bd create "x" --json --actor smoke 2>&1 >/dev/null | cat -A`
   (delete the `x` bead afterwards) and compare it to exactly these lines, spacing included, since hpipe
   filters them by prefix:

   ```
   warning: beads.role not configured (GH#2950).
     Fix: git config beads.role …
     Or:  git config beads.role …
   ```

   (`Fix:` has one space after it, `Or:` has two.) If a line differs, the filter lets it into hpipe's output.
4. **Ctrl-C leaves no bd behind.** In a pane, run a slow bd-backed command (`hpipe task --title …` or
   `hpipe dispatch --task t2`) and press Ctrl-C while it runs; immediately `pgrep -fl 'bd '` and, in
   a second pane, repeat the command. *Look for:* no `bd` process remains once hpipe has exited, the
   second command is not refused as locked after a second or two, and there is no stale lock file in
   `$STORE`. bd runs in its own process group, so a terminal Ctrl-C does not reach it directly.
5. **herdr restart and the board tab (human).** With a live run and the board open, note the pane id
   (`herdr --session "$SMOKE" pane list --workspace <pipeline workspace>`), then
   `herdr --session "$SMOKE" server stop` and start it again. *Look for:* whether the board tab comes
   back with the same pane id, and that a stale `Board: <repo> <hash>` tab is closed and replaced by one
   live board within a few ticks — never two boards for the repo.
6. **`hpipe next` on a real backlog (human).** In a store with 20+ beads (file them with `hpipe task
   --title` into a throwaway run, or point at a store you already use): `hpipe next`. *Look for:* output
   stays compact — a screenful, at most 5 ids per line then `+N more` — and any `warning:` line is one you
   can act on, not recurring noise.
7. **A whole task, end to end.** Run one task from dispatch to merge as in 8b, then abort and resume a
   second (8d). *Look for:* the bead goes `open → in_progress → closed`; **(human)** the phase label on
   the board updates at each phase; an abort releases the bead (`open`, no assignee) and a resume
   re-claims it.
8. **bv's history view (human).** After 8b, open bv's history view on the board. *Look for:* no
   `History load failed` line, and the bead's changes listed against hpipe's commits (`git -C "$STORE"
   log --format='%h %s'` shows one per CLI write and one per supervisor pass that wrote — `update bsm-1`,
   `sync`, …). Then the upgrade path, on a store made by a release before this one (or a copy of one with
   its `.git` removed, no run live): open the board with **Open board**. *Look for:* `$STORE/.git`
   appears with one `catch up` commit before bv starts, and the history view loads. If bv still cannot
   read the history, record its exact message: it is a finding, not something to work around mid-run.

| Deferred check | Result | Notes |
|---|---|---|
| 1 board labels, `deferred` column | | |
| 2 `dependency_type` / `status` on linked beads | | |
| 3 stderr warning text and filtering | | |
| 4 Ctrl-C leaves no bd | | |
| 5 board after herdr restart | | |
| 6 `hpipe next` compact | | |
| 7 full task lifecycle | | |
| 8 bv history view, new store and upgraded store | | |

---

## 9. One PR per batch (`--single-pr`)

This mode touches startup (the push in `start`), gating (the batch as every base, the landing slot) and
delivery (new prompts, the queued sync hand-over). The wiring test drives it end to end against a
bare local origin, but GitHub, release-please and live agents are only proven here. Run it in a fresh
`pipesmokeN` session against `victorstein/hpipe-smoke`.

### 9a. Setup, before the session boots

- `.claude/pipeline-always-review` on `main` listing every path these tasks touch: the steps below
  need each task's review to run, and a small change would otherwise skip it (§10). Remove it after.
- release-please configured on `hpipe-smoke` (`release-please-config.json` with `changelog-sections`,
  and the release workflow): step 9i is pass/fail on the release it cuts.
- A ruleset on `batch/*` blocking force-pushes and deletion (Settings → Rules → Rulesets). The landing
  gate is git refusing a non-fast-forward push; a `--force` landing gets through without the ruleset.
- Squash merges allowed on the repo.
- `.claude/pipeline-check` committed on `main`, executable, running the repo's tests, and a
  `.claude/agents/<surface>-dev.md`.

### 9b. A supervisor that predates the mode

With the previous release's supervisor still running in the session, run
`hpipe start "smoke batch" --single-pr` from the new CLI. **Assert:** refused, naming that
supervisor's pid and the `Pipeline supervisor` pane; no `batch/*` branch on origin; no run in
`hpipe status`. Restart the supervisor pane, then:

```bash
hpipe start "smoke batch" --single-pr
git ls-remote --heads origin 'batch/*'     # assert: exactly the printed branch, at origin/main's head
hpipe status                               # assert: "ships as one PR: batch/<…> → main · 0 of 0 landed"
```

**Assert** the output carries `batch: batch/<…> at <sha8> (origin/main as just fetched)`, `check:
.claude/pipeline-check` and the `ruleset:` line, and the intake prompt opens with "This run ships as
one PR". With the `batch/*` ruleset active, the `ruleset:` line reads `batch/<…> is already protected
from force-pushes and deletion`; without it, it recommends one.

### 9c. Registration, the base, submit's refusals

Register t1 and t3 with disjoint `--files`, and t2 with `--depends-on t1` and files overlapping t1's.
**Assert:**

- every `base:` line is `origin/batch/<…> as just fetched`, at the batch head;
- `hpipe task --branch batch/<…>` and `--branch main` are refused;
- in t1's worktree, before pushing, `hpipe submit --task t1 --title "feat: x"` says `push first`;
  `--title "feet: x"` is refused naming the repo's types; a PR opened by hand from t1's branch makes
  submit say `Close PR #n, then submit again` (close it after);
- a real submit prints `submitted t1 at <sha8> as "…" (implement; check passed)` and the check's log
  is under `$STATE/runs/$SMOKE/<run>.checks/`;
- push a commit to the batch after a worker's implement-start merge and before its submit: the submit
  prints a second line, `batch/<…> moved to <sha8> since this head last merged it, so tN goes through
  sync before it lands`, `<sha8>` being that push, and the task later goes `land-queue → sync`;
- the review prompt's diff command is `git fetch origin … && git diff origin/batch/<…>...origin/<branch>`.

### 9d. The gate, and one landing at a time

Time t1 and t3 so both clear review within a minute of each other, holding one worker's last review
back if needed. **Assert:**

- one takes the slot (`landing: tN (merge)` in status); the other waits in `land-queue` with `nothing
  for you — waiting to land; tN holds the landing slot`, no prompt, and no stall probe;
- before the waiting task syncs, pushing its old reviewed sha by hand
  (`git push origin <sha>:refs/heads/batch/<…>`) is refused;
- the slot holder's landing prompt reads `<land sha8> is the head that was reviewed. The check ran on
  <sha8>, and <land sha8> adds nothing to it but review verdicts under docs/superpowers/reviews/`, where
  `<sha8>` is the head `submit` printed and `git diff --name-only <sha8> <land sha8>` lists only that
  task's review file;
- the first lands with the rendered push: `origin/batch/<…>` equals its land sha, the landing shows in
  status within one CI poll (30 s), its bead closes with `landed on batch/<…> (<sha8>); ships with
  the batch PR into main`, and its worktree is torn down;
- the second goes `land-queue → sync`, its worker merges and submits, `submit` reports `a clean merge
  of batch/<…>` and runs the check, and it lands with no second review;
- t2, once t1 is done, is cut from a batch head containing t1's land sha.

### 9e. A reviewer's inline fix, checked before it lands

Have a task's last reviewer fix a MAJOR inline (a code change, committed and pushed with its verdict).
**Assert:** with the slot, the task goes to `sync`, not `merge` (`… was not checked since it was reviewed`
in `hpipe show`'s visited list or the history), the worker's submit runs the check on that head, and
only then does it land. When the batch has not moved, the worker's merge says `Already up to date`:
`submit` must report `nothing on batch/<…> to merge: it lands next`, the history `nothing on batch/<…>
to merge into <sha8>`, `hpipe show` `land sha: <sha8> (reviewed; its sync merged nothing)`, and the
land prompt `<sha8> is the head that was reviewed and checked; its sync found nothing on batch/<…> to
merge` (without `and checked` when the repo declares no check). `clean sync` anywhere in that
task's text is a **finding**: nothing was merged.

### 9f. A push in `merge` lands reviewed

While a task waits in `merge`, push a small hand-off commit to its branch as the orchestrator would.
**Assert:** on the next tick it goes to `sync` (`<branch> moved to <sha8> after its reviewed head`),
the sync is reported not clean, the task goes back through its review, and the commit lands on the
batch reviewed — it does not vanish with the worktree.

### 9g. A dirty sync, and a deleted branch

Register t4 and t5 editing one file under wrongly disjoint `--files`. **Assert:** the second to land
syncs with a conflict, `submit` reports `not a clean merge`, the task goes through its tier's first
review with the remerge-diff note in its prompt, then lands. While a task is in `merge`, delete an
already-landed sibling's branch on origin: the landing is still seen.

### 9h. A lost pane

Close the worker pane of a task waiting in `land-queue` that will have to sync. **Assert:** the task is
not failed (`hpipe status` shows it waiting, with the `agent start` line); when the batch moves past
it, another task with an agent takes the slot first; once you start an agent in its worktree, the
brief and the sync prompt arrive on their own, and nothing has to be sent by hand.

### 9i. The run's end, and the release

**Assert**, in order:

- `branch-review`'s prompt reads `git diff origin/main...origin/batch/<…>` in the batch checkout;
- `ship` writes `$STATE/runs/$SMOKE/<run>.batch-pr.md` with one override line per landing, the
  orchestrator creates `$STATE/checkouts/<run>` and runs `hpipe batch-check` there, and opens the PR;
  the run stays in `ship` until the PR's head is the head `batch-check` recorded (`checked batch/<…> at
  <sha8>: .claude/pipeline-check passed`, or in a repo with no check `recorded batch/<…> at <sha8>:
  nothing checked it, …` — `checked` there is a finding). The ship prompt says
  `The merge step replaces the PR's whole description`, and the orchestrator adds nothing to the PR's
  description on GitHub. With the `batch/*` ruleset active since `start` (whose `ruleset:` line said
  `already protected`), the ship prompt has no ruleset advice and the ledger's `.batch.ruleset_protected`
  is `true`; on a run started without one, the advice is there;
- `ship-ci` stays pending until every workflow run on the PR head has finished;
- **a push after the check:** push a failing test to the batch while the run is in `ship-ci` or
  `ship-merge`. The run goes back to `ship` (`head moved to <sha8> past <sha8>, the head batch-check
  recorded`) with the plain ship prompt, not `CI is red`, and spends no `ship-ci` pass; `batch-check`
  refuses the test there. Revert it, `batch-check`, `ship → ship-ci`. A run that reaches `ship-merge`,
  or merges, at a head other than `.batch.checked.head_sha` is a **finding**;
- **red CI, the fix-task route:** push a test that fails only in CI, such as
  `expect(process.env.CI).toBeUndefined()` (GitHub Actions sets `CI`), and `batch-check` it, so the
  red falls on a checked head: `ship-ci → ship` with `CI is red`. `hpipe task …`
  moves the run to `execute`, `dispatch --done`, the fix lands, the run goes
  `execute → branch-review → ship`, needs a fresh `batch-check`, then `ship-ci`, green;
- **red CI, the patch route:** push another CI-only failure and `batch-check` it; the second red
  escalates the run. `hpipe rewind <run> ship`, patch through a subagent in the batch checkout,
  `batch-check`: `ship → ship-ci`, green;
- squash-merge with the two rendered commands. The merge command carries `--match-head-commit <sha>`,
  `<sha>` being the head `ship-ci` saw pass (`.batch.ci_head.sha` in the ledger), and the prompt names
  its short sha as the green head; push an empty commit to the batch before running it once, and
  GitHub must refuse the merge. The run then goes `ship-merge → ship`, and merges only after a fresh
  `batch-check` and green CI on the new head. **Pass/fail:** exactly one release PR follows, whose notes list every
  landed title, the fix task's included, and nothing else;
- on a throwaway PR with no override block, check that the squash body's extra lines alone give one
  entry each (Verify 2 of the design), and whether GitHub appends ` (#n)` to `--subject` (Verify 3);
- `gh pr list --head batch/<…>` found the PR (Verify 4); the `done` notice prints `shipped: PR #n
  squash-merged as <sha8>` and deletes only the task branches whose head is on the batch. In a repo
  whose bootstrap initialises submodules, the batch checkout's line reads `worktree remove --force …  #
  git refuses its submodules without --force; nothing in them is unpushed` while the checkout is
  clean, and drops `--force` with a review note naming what is unrecorded once anything in it is
  uncommitted, a submodule is off the commit the checkout records, or a submodule's commit is on no
  remote branch: `--force` deletes the submodules' git data in a linked worktree. Run every clean-up line it
  prints, then check nothing is left: no local task branch (`git branch`), the
  default branch at the squash commit, `git status` clean (the plugin listed the branch review in
  `$(git rev-parse --git-common-dir)/info/exclude` when it reserved it, and the notice offers `rm` for
  it), and the batch branch on origin only when a ruleset kept it. With `.batch.ruleset_protected`
  `true`, the notice says `origin keeps batch/<…>, which the ruleset on batch/* protects from deletion:
  leave it` and offers no `push origin --delete`; without it, the delete is offered with its bypass
  caveat. When GitHub deleted the batch
  on merge, the notice carries `git -C <repo> branch -dr origin/batch/<…>  # origin no longer has it`,
  and after it `git branch -r` lists no `origin/batch/<…>`; a per-task run's notice does the same for
  merged PR branches GitHub deleted.

### 9j. Abort

On a second, throwaway single-PR run with one landed task, `hpipe abort <run>`. **Assert:** it names
the landed task, says its bead stays closed and nothing reached main, and prints the clean-up
commands; `hpipe status` shows `not shipped: batch/<…> holds 1 landed task (t1) that is not on main`.

Record the time a long check takes inside `submit` (the agent's Bash timeout is 10 minutes): a longer
one does not fit, and that is a finding.

---

## 10. Skipping the PR review on a small, well-planned change

A light or standard task leaving `implement` goes past its PR review when its change adds fewer than
150 lines outside `docs/`, its `spec-review` (and `plan-review`, where its tier runs one) cleared on
the first pass, no PR review sent it back, and it touches nothing listed in
`.claude/pipeline-always-review` on its base. The unit suite drives this against a bare local origin;
GitHub's PR base and a live supervisor's fetches are only proven here. Fresh `pipesmokeN` session,
`victorstein/hpipe-smoke`, no always-review file on `main` to start with.

### 10a. A per-task skip, and a heavy task beside it

Register t1 (`--tier standard`) and t2 (`--tier heavy`), each a change of a few lines, with disjoint
`--files`. **Assert**, once both are past `implement`:

- t1 went `implement → ci` and its pane received no `pr-review` prompt; t2 entered `pr-review`.
- `hpipe status`'s t1 line reads `standard pr-review skipped`; `hpipe show --task t1` prints
  `skipped:    pr-review (<N> lines added outside docs/, spec-review and plan-review cleared first pass)`,
  its `visited:` line has no `pr-review`, and `verdicts:` holds no `pr-review-0`.
- `<N>` is the added column of `git diff --numstat origin/main...origin/<t1 branch>`, summed over paths
  outside `docs/`.
- The orchestrator's digest line for t1's transition reads `[implement → ci, pr-review skipped]`, and
  t1's merge prompt opens `The PR review was skipped (…) and CI is green on PR #<n>.`
- The ledger records why:

  ```bash
  jq '.history | map(select(.task_id == "t1" and .from == "implement")) | last | .why' "$STATE/runs/$SMOKE/<run_id>.json"
  ```

  reads `PR #<n> at <sha>; pr-review skipped: <N> lines added outside docs/, …`.

### 10b. What keeps the review

In the same run, register three more small standard tasks:

- t3, after committing `.claude/pipeline-always-review` on `main` with a line naming t3's file. It
  enters `pr-review`.
- t4, whose change also edits `.claude/pipeline-always-review` on its branch. It enters `pr-review`:
  a change to the list is always reviewed, whatever the base's copy names.
- t5 with a change of 200 added lines outside `docs/`. It enters `pr-review`.
- If any task in the run had a `spec-review` or `plan-review` send-back, it entered `pr-review` however
  small its change was. Record whether one did.
- Each of them says why in the ledger: the `implement →` entry's `why` (the `jq` above) ends `; reviewed:
  <file> is on .claude/pipeline-always-review` for t3, `; reviewed: it edits
  .claude/pipeline-always-review` for t4, `; reviewed: 200 lines added outside docs/ (a skip needs
  fewer than 150)` for t5, and `; reviewed: <review> sent it back` for a send-back. A light or
  standard task that entered `pr-review` with no `reviewed:` reason is a **finding**; a heavy one has
  none.

### 10c. A single-PR skip

In a `--single-pr` run with one small standard task. **Assert:** it goes `implement → land-queue`;
`hpipe show` prints `land sha:   <sha8> (submitted; pr-review skipped)`, at the head `submit`
recorded; it lands as a fast-forward when up to date and checked, and the landing prompt reads `The PR
review was skipped (…), and <sha8> is the head that was submitted and checked`. A head pushed past
the submission before the skip lands only through `sync`; the unit suite covers that, since a live
run cannot time a push into the one tick between `submit` and the skip.

If such a task must sync and the merge conflicts, `submit` reports `not a clean merge` and the task goes
to `pr-review`, its first. **Assert** that review's prompt says `No reviewed head is recorded, so this
is the change's first review: read the whole diff` and names `git show --remerge-diff <sha>` at the
sha `submit` printed after `not a clean merge … (at`.

**Record:** each task's change size, whether it skipped, and the wall-clock time from `implement` to
`ci` (or `land-queue`) for a skipping task against a reviewed one.

## 11. Before-merge checks

A check only the human can make holds the merge it guards: no merge command and no stall probe until
the human rules. This touches gating (the gate rows hold a merge they would have recorded and moved
past), delivery (the hold prompt in place of the merge prompt, and the CLI replacing a queued one) and
the stall ladder. The wiring test drives it against a real ledger, but GitHub's merge state, Beads and
live agents are only proven here. Fresh `pipesmokeN` session against `victorstein/hpipe-smoke`, with
`STALL_MINUTES=2` and `TASK_STALL_MINUTES=3` in the plugin's `config.env`, so a probe that should not
come would come within minutes.

### 11a. A supervisor that predates it

With the previous release's supervisor still running, register t1 and run `hpipe hold --task t1
--before-merge "x"` from the new CLI. **Assert:** refused, naming that supervisor's pid and the restart
step; `hpipe show --task t1` has no `before merge:` line. Restart the supervisor, then:

```bash
jq .capabilities "$STATE/supervisor.$SMOKE.pid"    # assert: ["before-merge"]
```

### 11b. Per-task, a decision answered with `--before-merge`

Register t1 with `--tier heavy`, so its PR review runs. Have its worker raise a decision, and answer it
with `--by orchestrator --before-merge "<what the human checks>"`. **Assert:**

- The worker's answer prompt says `Before this merges, the human will check:` and names the check.
- `hpipe confirm --check c1 --by human` while t1 is in `pr-review` is refused: `confirm it once t1
  reaches ci`.
- At `merge`, the orchestrator's prompt is **Hold — PR #<n> (…) waits on the human before it merges**.
  It leads with `gh pr view <n> --json mergeStateStatus` and has no `gh pr merge`.
- `hpipe status`: t1's line ends `— waiting on the human (c1)`, the run header has a `before merge:`
  line, and `waiting on the human:` lists c1, not `waiting on you:`. The bead is `blocked` +
  `hpipe:awaiting-human`, with a `[hpipe t1/c1/before-merge]` comment.
- No probe comes for 10 minutes.
- `hpipe confirm --check c1 --by human` brings the merge prompt within a tick, and the first probe
  comes no sooner than one `TASK_STALL_MINUTES` after the confirm.
- Push an empty commit to t1's branch after confirming. t1 goes `merge → ci`, and comes back held, its
  hold line reading `confirmed on <old>; the head is now <new>`.
- `hpipe confirm --check c1 --by human --failed "<what>"` in `merge`: t1 goes to `implement`, and its
  worker gets **The human's check failed**. The fix goes through review and CI, and the hold comes
  again for the new head.
- Merge the PR by hand while held. Before the supervisor's next idle tick, `hpipe hold --task t1
  --before-merge "y"` is refused as merged: GitHub was asked. t1 stays in `merge` with the `⚠ t1: PR
  #<n> merged before the human confirmed c1` line, and its bead stays open. `hpipe rewind <run> done
  --task t1`, `hpipe rewind <run> implement --task t1` and `hpipe close --task t1` are refused. `hpipe confirm --check c1 --by human --waive
  "<why>"` → `close → done`, and the waiver comment (`[hpipe t1/c1/r<n>]`) is on the bead before it
  closes.

### 11c. Single-PR

- `hpipe hold --before-merge "<check>"` at intake. When the run reaches `ship-merge`, it is held with
  the hold prompt, and no probe comes.
- Confirming during `ship-ci` holds once CI passes on that head: the merge prompt comes, with
  `Before merge: c1 confirmed by the human on <sha8>.`
- A `BEHIND` batch PR: the hold prompt has `gh pr update-branch` run first, the run goes back through
  `ship`, and the human is asked about the new head.
- `hpipe confirm --check c1 --by human --failed "<what>"` in `ship-merge` keeps the run there, and the
  next probe names the two routes to a fix.
- `hpipe abort` on a held throwaway run lists `still owed to the human: c1 … — the batch PR is not
  merged`.

**Record**, verbatim: the `mergeStateStatus` GitHub gave for a PR behind its base, a conflicting PR,
one blocked on a review, and a draft. The hold prompt names a move for each; a value it does not name
is a **finding**.

---

## 12. One-command dispatch

`hpipe dispatch --task <id>` and `hpipe dispatch --ready` drive herdr from the CLI: `worktree
create`, the repo's bootstrap, `agent start` and the brief. The unit and process tests stand in for
herdr, so only this run proves herdr answers the way they assume. Fresh `pipesmokeN` session,
`victorstein/hpipe-smoke`. Set `STALL_MINUTES=2` and `TASK_STALL_MINUTES=3` in the plugin's
`config.env` first, so a probe that should not come would come within minutes.

Commit a bootstrap on `main` whose behaviour a marker file in the state dir picks:

```sh
#!/bin/sh
# .claude/pipeline-bootstrap — chmod +x before committing
echo "bootstrap in $PWD"
[ -f "$HOME/.local/state/herdr/plugins/stein.pipeline/smoke-boot-fail" ] && { echo "marker says fail"; exit 1; }
[ -f "$HOME/.local/state/herdr/plugins/stein.pipeline/smoke-boot-slow" ] && sleep 600
sleep 2
exit 0
```

The `sleep 2` keeps a passing bootstrap slower than herdr's `worktree.created` hook. A record of a
bootstrap that finished before the hook fired is cleared by the binding, by design, and the next
re-run would bootstrap once more, which 12c would misread.

Every dispatch below is run by the orchestrator with the Bash tool's `run_in_background`, and it ends
its turn. Each one prints a line per step (`base`, `worktree`, `bootstrap`, `agent`, `brief`) and ends
`dispatched tN` or `stopped tN at <step>: <why>`.

### 12a. The tool facts the code rests on — record each verbatim

- **The create response (Verify 1).** Register one throwaway task and dispatch it **by hand** with
  its printed block, and save `herdr worktree create`'s JSON. **Assert** it carries
  `.result.worktree.path`, `.result.root_pane.pane_id`, and the workspace id at
  `.result.workspace.workspace_id` or `.result.root_pane.workspace_id`. If the id is in neither, every
  one-command dispatch stops at `worktree` with `herdr may have created the worktree, but herdr's
  create response named no workspace id`: a **finding** — record where the id actually is.
- **The workspace list entry (Verify 2).** `herdr --session "$SMOKE" workspace list` for that
  task's workspace. **Assert** `worktree.is_linked_worktree` is `true` and `worktree.repo_root` is
  the checkout's own path, not the repo's. If it is the repo's, a re-run of any bound task stops at
  `worktree` with `herdr says wN is the checkout at <repo>`: a **finding** — the design's fallback
  (match `repo_root` against the run's repo, plus `worktree list`'s entry for the ledger's path) is
  then the fix.
- **`worktree list` (Verify, pass 2).** `herdr --session "$SMOKE" worktree list --cwd <repo>`.
  **Assert** `.result.worktrees[]` entries carry `path`, `branch`, `is_linked_worktree` and
  `is_prunable`. Any other shape makes every dispatch stop at `worktree` with `could not be read`.
- **`agent start` (Verify 3).** The dispatch passes `--timeout 80000`. **Record** herdr's error code
  and message for a name already in use (12c) and for an agent blocked by a dialog at start, if one
  shows up.
- **Focus.** The dispatch passes `--no-focus` to `worktree create`. **Assert** focus stays on the
  orchestrator pane while a background dispatch creates worktrees.
- **Background Bash (Verify 4).** **Record** that the dispatch outlives Claude Code's 10-minute
  foreground limit (12d's slow bootstrap), that its completion notice carries the step lines, and
  which signal reaches it if the orchestrator's session ends while it runs (`hpipe status` and the
  lock show what was left).
- **Auto mode.** With auto mode on, **record** that `hpipe dispatch` needed no separate approval for
  the `herdr agent start` inside it.

### 12b. Three tasks, one command

Register t1, t2 and t3 (disjoint `--files`, no dependencies), then `hpipe dispatch --ready`.
**Assert:**

- the step lines name each task in task id order, each `worktree   created wN at <path>, pane
  wN:p1`, `bootstrap  ./.claude/pipeline-bootstrap passed in <n>s (log: …)`, `agent      started
  <bead> in wN:p1 (--effort <tier's>)`, and `brief      claimed <bead>; delivered to wN:p1, and the
  worker is working on it`; the last line is `dispatched t1, t2, t3`;
- one pane per new workspace, each worker working on its brief (`herdr pane read`), and
  `hpipe show --task tN` names the workspace and pane within a tick;
- `$STATE/dispatch/` is empty once it ends.

### 12c. Stops, and re-runs that skip what is done

- **Bootstrap.** `touch "$STATE/smoke-boot-fail"`, register t4, `hpipe dispatch --task t4`. It
  stops `at bootstrap: ./.claude/pipeline-bootstrap failed (exit 1)` with `marker says fail` in the
  tail. Remove the marker and run it again: `worktree   wN at <path> exists (pane wN:p1) — skipped`,
  then the bootstrap runs and the rest follows.
- **Straight after a create.** Repeat with t5, but re-run within a second or two of the failure,
  before the supervisor's tick binds the worktree. **Assert** it waits for the binding (up to 15 s)
  and carries on, rather than stopping on `no workspace is bound`.
- **A name in use.** Register t6. Before dispatching it, start an agent named after t6's bead in
  some other shell pane (`herdr agent start <bead> --kind claude --pane <other>`). With the fail
  marker absent, `hpipe dispatch --task t6` stops `at agent: an agent named <bead> already runs in
  <other>`, without retrying. Close that agent, run it again: `bootstrap  passed in this checkout
  before — skipped`, and the agent starts.
- **A workspace closed after a failed bootstrap.** Fail t7's bootstrap as above, then
  `herdr --session "$SMOKE" workspace close <its workspace>`. Remove the marker and re-run: it stops
  `at worktree` naming the kept checkout and the `herdr worktree open --cwd '<repo>' --branch <b>`
  step. Run that step, wait for `hpipe show --task t7` to name the new workspace, re-run: the
  bootstrap runs again (the binding cleared the record). **Assert** at no point did an agent start
  in a pane outside t7's workspace.
- **A branch that is not the task's.** `git branch smoke/stale <a commit before main's tip>` and push
  nothing; register t8 on `smoke/stale` and dispatch it: refused `` at worktree: `smoke/stale`
  already exists at <sha8> and does not contain the base <sha8> ``, nothing created.
- **Another session.** From a pane of a different herdr session, cd'd into the repo,
  `hpipe dispatch --task t8 --run <run_id>` is refused: `hpipe dispatch drives herdr itself: run it
  from a pane of session <smoke session>`.

### 12d. The lock while a bootstrap runs

`touch "$STATE/smoke-boot-slow"`, register t9 and t10, and `hpipe dispatch --task t9`. While its
bootstrap sleeps:

- `hpipe dispatch --task t10` is refused: `t9 is being dispatched by pid <pid> (bootstrap, <n>m), in
  session <s> (run <id>): one dispatch runs per repo at a time`. So is `hpipe dispatch --task t10
  --pane <any>`.
- `hpipe status`'s t9 line reads ``nothing for you — `<hpipe> dispatch` (pid <pid>) is at bootstrap
  for t9, started <n>m ago``, and nothing anywhere says `YOUR move: … herdr agent start` for t9. Wait
  five minutes, past both shortened thresholds: **assert** no stall probe about t9 reaches the
  orchestrator, and the digest's footer does not list it.
- `cat "$STATE"/dispatch/*.lock` names `t9`, `bootstrap`, the pid and `bootstrap.pgid`.
- `kill -TERM <pid>`. **Assert** within 10 s: `ps -g <pgid>` lists nothing, the lock file is gone,
  and the dispatch's output ends `stopped t9 at bootstrap: interrupted` (exit 143).
- Remove the slow marker. `hpipe dispatch --task t9` carries on from the worktree.
- Slow marker on again, register t13 and `hpipe dispatch --task t13`. While its bootstrap sleeps,
  `herdr --session "$SMOKE" workspace close <t13's workspace>`, then remove the marker. **Assert** the
  dispatch stops `at agent` (herdr lists no workspace, or the ledger no longer binds it) and that no
  agent started anywhere: the workspace, the ledger and the pane are all checked again just before
  `agent start`, since a bootstrap can take twenty minutes.

A dispatch killed with `kill -KILL` leaves its lock: `hpipe status` then says `⚠ a dispatch lock for
this repo is left by pid <pid>, which is gone`, and the next dispatch stops the dead one's bootstrap
group (when its leader is provably the one recorded) and takes the lock over. Record what you see.

### 12e. `--ready` takes what becomes ready while it runs

Slow marker on. Register t11, start `hpipe dispatch --ready`, and while t11 bootstraps register t12.
Remove the marker. **Assert** the same run dispatches t12 before it ends (`dispatched t11, t12`), and
that a `Dispatch t12` prompt arriving meanwhile, if any, is answered by waiting for the notice: a
`dispatch --task t12` then would be refused with `it takes every task that becomes ready before it
ends, t12 included`.

**Record:** each dispatch's wall-clock time from command to `dispatched`, against the manual block's
in §1.

## 13. Shared paths

A path listed in `.claude/pipeline-shared-paths` never holds the file lock, so two tasks that both
declare it implement at once, and the conflict that follows is left to the rebase before a per-task
merge, or to `sync` in a single-PR run. The unit suite and `test/shared-paths-wiring.test.ts` drive the
gate against a bare local origin; a live supervisor's gate, GitHub's merge and a real `sync` are only
proven here. Fresh `pipesmokeN` session, `victorstein/hpipe-smoke`. With the plugin's `config.env`
set to `STALL_MINUTES=2` and `TASK_STALL_MINUTES=3`, a probe that should not come comes within minutes.

### 13a. Start reads the list once

Commit `.claude/pipeline-shared-paths` to `main` on origin, from a clone other than the
orchestrator's checkout:

```
# every task appends to it
docs/registry.md
docs/*.md
```

**Assert:** `hpipe start` prints, above the intake prompt,

```
shared: docs/registry.md — from .claude/pipeline-shared-paths at <sha8> (origin/main as just fetched); never locked
⚠ shared: ignored "docs/*.md" in .claude/pipeline-shared-paths — a glob would share more than it names: list each path
```

with `<sha8>` the commit that added the file, though the orchestrator's working tree has never
pulled it. `hpipe status` shows `  shared: docs/registry.md (from <sha8>)` under the run's header, and
the ledger holds it:

```bash
jq '.shared_paths' "$STATE/runs/$SMOKE/<run_id>.json"
```

If the session's supervisor is still the previous release's, `start` also prints `⚠ shared: the
supervisor of session … predates shared paths and locks them anyway`. Restart it before going on, or
13b holds t2 behind t1 and that is the old supervisor, not a finding.

### 13b. Two tasks on one shared file, and one on a locking path

Register three small tasks:

- t1: `--files src/alpha/,docs/registry.md`, a change that adds `src/alpha/` code and a `## alpha`
  section to `docs/registry.md`;
- t2: `--files src/beta/,docs/registry.md`, the same with `beta`;
- t3: `--files src/alpha/x.ts`.

**Assert:** `hpipe task` prints `files: src/alpha/, docs/registry.md (shared)` for t1, t2's line has no
`overlaps`, and t3's reads `— overlaps t1: whichever reaches implement second waits there until the
other finishes`. `hpipe show --task t2` prints `files:      src/beta/, docs/registry.md (shared)`.

Once all three are past their plans:

- t1 and t2 are in `implement` together: whichever reaches `blocked-on-files` second passes straight
  through to `implement` while the other is still in it (on the same tick, if they arrive together).
  Each implement prompt's implementer's brief reads
  ``docs/registry.md` is shared: other tasks edit it at the same time.``
- t3 waits in `blocked-on-files`; `hpipe status` prints `⚠ t3 blocked on files held by t1 (implement)`
  and never names t2 as a holder; t3's bead is blocked by t1's bead and by no other.
- No probe about t3 comes while t1 moves (`TASK_STALL_MINUTES=3`: watch it for ten).
- t3 enters `implement` once t1 is `done`, with t2 possibly still in flight.

**Record:** when t1 and t2 entered `implement`, from `jq '.history'`, and when t3 did.

### 13c. Per-task: the rebase at merge

Let t1 merge first. **Assert:** t2's merge prompt carries, after the bootstrap paragraph,

```
This task declares the shared `docs/registry.md`, and t1 (merged) declares it too, so this PR may conflict there. …
```

and the orchestrator rebases t2 onto `main`, keeps both sections, pushes, and t2 goes back to `ci`,
then `merge` again on the rebased head. A merge prompt that names no shared path for t2, or names a
task that has not merged, is a **finding**.

Then make the additions collide: register two more tasks, each adding a `## gamma` section with
different text to `docs/registry.md`. Once the first merges, **assert** the orchestrator, following the
other's merge prompt, does not hand-resolve it but runs the `hpipe rewind <run> implement --task <id>`
it prints, and that task's worker redoes its addition on top of the merged one and is reviewed again.

### 13d. Single-PR: the dirty sync

In a `--single-pr` run with the same list on `main`, two tasks that each add a section to
`docs/registry.md`. **Assert:** both implement at once; the second to land syncs, its merge of the
batch conflicts on `docs/registry.md`, the sync prompt it received says `` `docs/registry.md` is shared,
so a conflict there is expected: keep both sides' additions``, `submit` reports `not a clean merge`,
and the task goes back through `pr-review` before it lands. Make the two additions collide instead,
and the worker raises it with `hpipe decide`, recommending a rewind to `implement`.

### 13e. A mid-run edit changes nothing

During 13b, while t1 is still in flight, commit `src/` to the list on `main` (another clone, as in
13a), then register another task with `--files src/alpha/y.ts`. **Assert:** its `files:` line reads
`— overlaps t1`, the ledger's `shared_paths.commit` is still 13a's, and `hpipe status` still prints
`shared: docs/registry.md (from <13a's sha8>)`. The next `hpipe start` reads the new list.

Afterwards, delete `.claude/pipeline-shared-paths` from `main`: the sections above expect a repo
that shares nothing.

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
| A phase was escalated by the stall ladder | `hpipe status` lists the task under `waiting on you:` as `tN <branch> (<bead>) [escalated Nm] — needs a human: <rewind command> resumes it, <rewind … failed command> abandons it` (a run shows `⚠ run escalated from <phase> … needs a human`). Deal with whatever it was waiting for, then `hpipe rewind <run_id> <phase> [--task <id>]`, which re-arms the ladder from zero. To drop an escalated task instead, `hpipe rewind <run_id> failed --task <id>`: until one of the two is run the run stays in `execute`, the task's dependents stay `queued`, and the run gives up its orchestrator pane to any other run driven from it. |
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

The beads live in `$STATE/beads/<repo>-<hash>/`; delete that directory only if the store was created for
this run (§8f). Close the throwaway PRs and delete the smoke branches. If the run merged
anything into `main` of a real repo, revert it — nothing in this runbook is work you want to keep.
