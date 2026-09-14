# Adversarial review — herdr-plugin-pipeline design v2

**Target:** `docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md` (531 lines)
**Round 1:** `docs/superpowers/reviews/2026-09-13-design-adversarial-1.md` (VERDICT: BLOCKER)
**Date:** 2026-09-13

**Method.** Round 1's findings were audited one by one against v2. The new supervisor-pane
architecture was probed **live**: a throwaway plugin (`test.supprobe`) with a `[[startup]]` hook, a
`[[panes]]` entrypoint at `placement = "tab"`, and a global action was linked into a throwaway
session (`--session supprobe`), driven through a cold start, a workspace creation, a
`server stop` → restart cycle, and a supervisor-process kill. A second throwaway session
(`--session envprobe`) captured a pane shell's environment. **Both sessions were stopped and
deleted, the probe plugin unlinked, its state directory removed, and `herdr plugin list` returned to
"No plugins installed"; the user's running `default` and `personal` sessions were never touched.**
The queue-rotation claim and hook latency were measured with runnable scripts. Every `gh` field
claim was re-executed against `gh 2.96.0`.

Design citations are `design:<line>`. Requirements are
`/Volumes/stein/Documents/development/personal/nicaraguan-laws/CLAUDE.md`, cited as `CLAUDE.md:<line>`.

---

## BLOCKER 1 — The supervisor pane cannot be opened by the startup hook on a cold start, and a server restart leaves a ghost pane plus a duplicate. Verified live.

**Claim.** design:96-99: "**The supervisor is mandatory infrastructure.** If it is not running,
nothing advances. It lives in its own unfocused workspace (`PIPELINE_WORKSPACE_LABEL`, default
`pipeline`), **opened unconditionally by the startup hook** and reopenable with the `ci-pane`
action." design:498 lists "Server restart / live handoff" as a handled failure whose only casualty
is badges.

**Problem.** Three independent facts, each verified live, break this:

**(a) A startup hook cannot open the pane on a cold start.** Herdr restores the session and runs
startup hooks before there is an active workspace; `plugin.pane.open` fails with
`no_active_workspace`.

**(b) After a server restart the old supervisor pane is restored as a plain interactive shell that
keeps the label "Supervisor".** Snapshot restore does not re-run plugin pane commands
(`session-state.mdx:33`: "Panes that cannot use a stronger restore path come back as new shells in
their saved directories").

**(c) The startup hook then opens a *second* pane.** There is no idempotency check. Every restart
adds one dead-looking "Supervisor" tab.

**Evidence.**

Cold start, `[[startup]]` invoking `plugin pane open --placement tab --no-focus`, from
`$HERDR_PLUGIN_STATE_DIR/probe.log`:

```
=== STARTUP 1789357033 pid=19131 statedir=/Volumes/stein/.local/state/herdr/plugins/test.supprobe ws= event=startup
STARTUP pane open rc=1 out={"error":{"code":"no_active_workspace","message":"no active workspace"},"id":"cli:plugin"}
```

Note `ws=` is empty and `herdr --session supprobe workspace list` returned
`{"workspaces":[]}`. The plugin command log recorded this as **`"status":"succeeded","exit_code":0`**
— the failure is invisible to `plugin log list` unless the hook propagates it.

Restart cycle. Before: one live supervisor at `w1:p2`, `pid=19961`. After `server stop` + restart:

```
$ herdr --session supprobe pane list        # pane_id, label, cwd
w1:p1 None       /Volumes/stein
w1:p2 Supervisor /…/scratchpad/supprobe      <-- restored ghost
w1:p3 Supervisor /…/scratchpad/supprobe      <-- opened by the startup hook
```

`probe.log` shows exactly one `SUPERVISOR START` after the restart (`pid=21269 pane=w1:p3`) — `w1:p2`
was **not** relaunched. Reading it confirms a plain zsh:

```
$ herdr --session supprobe pane read w1:p2 --source visible --lines 10
aicommit2 is already installed
 stein …/scratchpad/supprobe   21:38  ❯
```

`pane get w1:p2` still reports `"label":"Supervisor"`. A user looking at the workspace cannot tell
the ghost from the real one.

A PID-file singleton guard does not help with any of this: the ghost is not a supervisor process, so
liveness never reclaims it, and the duplicate pane is opened before the guard runs.

**Concrete fix.** Make the startup hook reconcile rather than open blindly:
1. `workspace list`; if no workspace with `PIPELINE_WORKSPACE_LABEL` exists, `workspace create
   --label <label> --no-focus` and record its id in the state dir.
2. `pane list --workspace <id>`; close every pane whose `label` is the supervisor's but whose pid is
   not the live one from `supervisor.pid` — that is the ghost-reaping step, and it is the one piece of
   v1's deleted reaper that the new architecture actually needs.
3. Only then `plugin pane open --workspace <id> --placement tab --no-focus`, and **check the response
   for an error rather than exiting 0** (`no_active_workspace` is returned as a JSON `error`, not a
   non-zero from the hook's perspective unless checked).
4. Add a failure-modes row: "Server restart | supervisor process is killed and its pane returns as a
   mislabelled shell; the startup hook must close it and reopen."

---

## BLOCKER 2 — When the supervisor dies its pane *disappears*. The one stated reason for choosing a pane over a daemon is false.

**Claim.** design:101-102: "Consequence accepted deliberately: the plugin now has a component that
can die. **It dies *visibly*, in a pane you can look at, which is why it is a pane and not a detached
daemon.**" design:492, failure modes: "Supervisor dies | Nothing advances; **visible dead pane**;
`hpipe status` says so; `ci-pane` reopens".

**Problem.** A plugin pane is destroyed when its command exits. There is no dead pane to look at.

**Evidence.** With the supervisor running in `w1:p3`:

```
$ kill 21269        # the supervisor process
$ herdr --session supprobe pane list
w1:p1 None
w1:p2 Supervisor          <-- only the ghost from the earlier restart remains
$ herdr --session supprobe pane read w1:p3 --source visible --lines 6
{"error":{"code":"pane_not_found","message":"pane w1:p3 not found"},"id":"cli:pane:read"}
```

So the only "Supervisor"-labelled pane left in the workspace is the *ghost from BLOCKER 1*, which is
a live shell. The design's visibility story is exactly inverted: a dead supervisor is invisible and a
non-supervisor looks alive.

This also breaks the singleton guard's UX (design:98-99: "a second instance exits immediately") — a
second `ci-pane` invocation opens a tab that vanishes within a tick, with no message to the user
explaining why.

**Concrete fix.** Two lines of design, not a re-architecture:
- Make the supervisor's outermost shell keep the pane alive on exit: the manifest command becomes
  `["sh", "-c", "bun run src/supervisor/main.ts; echo '[pipeline] supervisor exited — see hpipe status'; exec $SHELL"]`,
  so a death leaves a readable pane. The singleton-guard path prints "another supervisor is live
  (pid N)" before dropping to the shell.
- Correct design:101-102 and design:492: the pane is chosen for *observability while running*, not
  for a visible corpse, and `hpipe status` — not the pane — is the death detector.

---

## BLOCKER 3 — Edge-triggered predicates were applied to runs only. Tasks have no `phase_entered_at`, so v1's BLOCKER 7 livelock is intact for 7 of the 14 phase rows.

**Claim.** design:338-349, §"Predicates are edges, not levels": "**Every predicate compares against
`phase_entered_at`**"; "a **file** predicate requires `mtime > phase_entered_at`". design:314-315:
`task-review-spec` and `task-review-quality` complete on "verdict file, fresh, parses" and on failure
go "else task `execute`, re-prompt worker".

**Problem.** `phase_entered_at` exists **only on the run record** (design:251). The task record
(design:258-265) carries `task_id, branch, issue, surface, depends_on, files, workspace_id, pane_id,
agent_status, phase, pr, ci, text` — **no timestamp of any kind**. Seven rows of the phase table are
task-scoped (`queued`, `execute`, `task-review-spec`, `task-review-quality`, `ci`, `merge`, `close`,
`teardown` — eight, in fact), and while tasks move the run sits in `execute`, so the run's
`phase_entered_at` is a single value shared by every task and updated by none of them.

Concretely, the exact livelock v1 found:

- `task-review-spec` finds a BLOCKER → task returns to `execute`.
- `execute`'s predicate is "worker `done`/`idle` **and** `gh pr list --head <branch>` returns a PR".
  The PR still exists. design:345 says "a **PR** predicate requires the PR's `createdAt`/`updatedAt`
  to postdate phase entry" — but there is no task-level phase entry to postdate, and `updatedAt`
  moves on any comment or label change, not only a push.
- The worker's next `idle` — including the one that follows the plugin's own re-prompt landing —
  satisfies it. Task bounces back to `task-review-spec` on unchanged work.
- Neither `task-review-spec` nor `task-review-quality` has a per-pass verdict path either. The run's
  `artifacts.verdicts` map is keyed `"spec-review-1"` (design:256) with no task dimension, so pass 2
  of a task review reads pass 1's file — which is already "fresh" relative to the run's stale
  `phase_entered_at`.

The design's own test plan asks for exactly this case and would fail it: design:515-516, "the
livelock case (re-enter a phase whose old artifact still exists — must *not* advance)".

**Concrete fix.** Add `phase_entered_at` and `head_sha_at_entry` to the **task** record, set both on
every task phase transition, and key verdict paths per task and pass:
`artifacts.verdicts["<task_id>-task-review-spec-<pass>"]`. Change design:345 to require
`gh pr view <pr> --json headRefOid` to differ from `head_sha_at_entry` — `updatedAt` is not a
work-happened signal. Add `pass` to the task record too; `MAX_PASSES` is currently run-scoped and has
no meaning for a task that loops `execute ↔ task-review-*`.

---

## BLOCKER 4 — v2 removed the agent-idle condition from every orchestrator-owned phase, so the supervisor advances on a file alone — while the orchestrator is still mid-turn. The document contradicts itself.

**Claim.** design:298-301: "**Waking and evaluation are separate concerns.** … It is **not** excluded
from *evaluation*: its `idle`/`done` transitions **are exactly the trigger** for seven of the twelve
phases."

**Problem.** The phase table says otherwise. Compare the two kinds of row:

- design:313, `execute`: "worker `done`/`idle` **and** `gh pr list --head <branch>` returns a PR" —
  an agent-state condition is present.
- design:307-310, 314-315, 320: `spec` → "spec file, fresh"; `spec-review` → "verdict file, fresh,
  parses"; `plan`, `plan-review`, `task-review-spec`, `task-review-quality`, `branch-review` — all
  identical. **No agent-state condition at all.**

And the supervisor loop at design:83-88 evaluates "due predicates" every `TICK_MS`, with "due"
undefined and no mention of gating on a queue event. So the operational reading is: one second after
the orchestrator's `Write` tool call lands the spec file, the file settles, the predicate fires, the
phase advances, and `herdr agent prompt` injects `prompts/spec-review.md` into an orchestrator that is
still explaining its spec to the human. v1 at least required an `idle` transition first.

This is not a theoretical risk — it is the *normal* path. Claude Code writes a file early in a turn
and keeps talking. design:358-360 even concedes the case ("an agent that writes a complete artifact
and then keeps going … advances the phase early") but treats it as a residual risk of *inference*,
when in fact v2's own table removed the only guard v1 had against it.

It also makes MAJOR 9 of round 1 the common case rather than the exception: design:118 files
mid-turn `agent prompt` behaviour as "an accepted open risk, mitigated below", and design:451-453's
mitigation is only that `hpipe start` prints instead of injecting. Every *other* delivery now lands
mid-turn by construction.

**Concrete fix.** Restore the gate in the table, not just in the prose: every orchestrator-owned row's
predicate becomes "**actor pane is `idle` or `done`** *and* artifact file, fresh, parses". State in
§Event transport that a predicate is evaluated only for a run whose actor pane's last observed
`agent_status` is `idle`/`done`, re-read live at delivery time. That is the round-1 BLOCKER 6 fix #3
("re-read the pane's status via `agent get` and require it still to be `idle`/`done` after
`SETTLE_MS`") that v2 dropped — see MAJOR 4. Also fix the arithmetic while you are in there: the
table has **14** rows, of which **10** are orchestrator-owned, not "seven of the twelve"
(design:14, design:300 — stale from v1).

---

## BLOCKER 5 — Plugin state is global, not per-session; pane ids are not unique across sessions; the user runs two servers right now. The single supervisor will deliver prompts into the wrong session's panes.

**Claim.** design:54, Non-goals: "**Cross-machine coordination.** Single herdr server, single
machine." design:96-99: one supervisor, "Singleton-guarded by a PID file with a liveness check; a
second instance exits immediately." design:230: "All state in `$HERDR_PLUGIN_STATE_DIR`."

**Problem.** "Single herdr server" is not true of this machine, and nothing in the design detects the
violation. Herdr named sessions are separate servers with separate sockets, but **plugins and their
state are global to the user**, and **pane ids are per-session** (`w1:p1` exists in every session).

**Evidence.** Right now, unprompted:

```
$ herdr session list
default   running  /Volumes/stein/.config/herdr              /Volumes/stein/.config/herdr/herdr.sock
personal  running  /Volumes/stein/.config/herdr/sessions/personal  …/personal/herdr.sock
```

`plugins.mdx:196-197`: "Installed and linked plugins, including their enabled state, are **global to
the current user and available in every Herdr session**." Verified: the probe plugin's state dir was
`/Volumes/stein/.local/state/herdr/plugins/test.supprobe` and its config dir
`/Volumes/stein/.config/herdr/plugins/config/test.supprobe` — neither path contains the session name,
while the socket does (`/Volumes/stein/.config/herdr/sessions/supprobe/herdr.sock`).

A pane's shell carries its session, so `hpipe` invoked from an orchestrator resolves to *that*
session (verified live in a probe pane):

```
HERDR_PANE_ID=w1:p1
HERDR_SESSION=envprobe
HERDR_SOCKET_PATH=/Volumes/stein/.config/herdr/sessions/envprobe/herdr.sock
```

So: `default`'s startup hook wins `supervisor.pid`. The user runs `hpipe start` in a `personal`
pane; the run record stores `orchestrator_pane: "w3:p1"` with no session qualifier. The one live
supervisor, bound to `default`'s socket, resolves that run and calls
`herdr agent prompt w3:p1 "<rendered prompt>"` — against **`default`**. Best case `pane_not_found`
and a retry loop to `PROMPT_RETRY_MAX`; worst case `default` has a `w3:p1`, and a several-hundred-line
pipeline prompt is typed into an unrelated agent. `herdr agent prompt` "writes text followed by
delayed Enter … including while the agent is working" (`agent prompt --help`), so it submits.

The same aliasing corrupts `orchestrators.json` (keyed `repo_key → pane_id`), the badge writes, and
teardown's `worktree remove --workspace <ws>`.

**Concrete fix.** Two changes, both small, one of which the user must choose between:
- **Qualify every herdr id with its session.** Store `session` (from `HERDR_SESSION`, verified
  present in pane shells) and `socket_path` on the run record and in `orchestrators.json`; the
  supervisor skips any run whose `session` is not its own; `hpipe` stamps its own session on write.
- **Scope the singleton per session**: `supervisor.<session>.pid`, and put runs under
  `runs/<session>/`. One supervisor *per running server*, not one per machine.

If the user prefers to keep it truly single-server, then the design must say so enforceably: `hpipe
start` and the startup hook refuse to run when `herdr session list` shows more than one `running`
session, naming the conflict. Silently mis-delivering is the only outcome that must not ship.

---

## MAJOR 1 — `gh pr view --json merged` does not exist. This is v1's `conclusion` bug, fixed in one place and reintroduced in another.

**Claim.** design:317, the `merge` phase: "Completion predicate: **`gh pr view` reports `merged`**".

**Problem.** `merged` is not a `gh pr view --json` field.

**Evidence.** `gh 2.96.0`:

```
$ gh pr view --json merged
Unknown JSON field: "merged"
Available fields:
  … closed, closedAt, … mergeCommit, mergeStateStatus, mergeable, mergedAt, mergedBy, … state …
```

There is no `merged`. v2 correctly deleted `conclusion` (design:119, design:427: "not the nonexistent
`conclusion` field v1 specified") and then wrote the identical class of error one row above it in the
same table. The `close` row is fine by contrast — `closed` *is* a real `gh issue view --json` field,
verified.

**Concrete fix.** `gh pr view <pr> --json state,mergedAt` and treat merged as `state == "MERGED"`
(`mergedAt != null` is equivalent). Add the field list to the verified-facts table the way the
`gh pr checks` row already does, since that is the row that stopped the first instance of this bug and
would have stopped this one.

---

## MAJOR 2 — "nothing is lost" in the queue rotation is false. A hook that has already opened the segment writes into the rotated file, and into a deleted inode after the supervisor unlinks it.

**Claim.** design:239-241: "The supervisor **renames the active segment aside before reading it, so a
hook appending concurrently writes to the new segment and nothing is lost.** v1's read-then-truncate
raced every late appender."

**Problem.** `rename(2)` moves the directory entry, not the open file description. A hook that
`open(path, O_APPEND)`ed *before* the rename holds an fd on the inode and its write lands in the
**rotated** segment, not a new one. That is survivable if the supervisor reads afterwards — but the
supervisor deletes the rotated segment after a successful prompt (implied by "rotated segments",
design:235), and any write arriving after the unlink goes into an unlinked inode and is gone.

**Evidence.** Runnable, executed with `bun 1.3.14` on this machine:

```js
fs.writeFileSync('active.jsonl', '{"e":"pre-rename"}\n');
const fd = fs.openSync('active.jsonl', 'a');        // hook opens fd
fs.renameSync('active.jsonl', 'rotated.jsonl');     // supervisor rotates
fs.writeSync(fd, '{"e":"written-after-rename"}\n'); // hook appends
```
```
rotated.jsonl  => "{\"e\":\"pre-rename\"}\n{\"e\":\"written-after-rename\"}\n"
active.jsonl exists? => false
```

The post-rename append went into the **rotated** file, and no new active segment was created. Then
the lossy ordering:

```js
const fd2 = fs.openSync('a2.jsonl','a');
fs.renameSync('a2.jsonl','r2.jsonl');
const read = fs.readFileSync('r2.jsonl','utf8');    // supervisor reads
fs.unlinkSync('r2.jsonl');                          // supervisor deletes after success
fs.writeSync(fd2, '{"e":"LOST"}\n');                // hook appends
```
```
supervisor read => "{\"e\":\"pre\"}\n"
r2.jsonl exists? => false   a2.jsonl exists? => false
dir after => [ "rotated.jsonl" ]
```

The `LOST` line is unrecoverable. The window is small but it is exactly the window the design's own
concurrency test targets (design:517-518: "N hooks appending while the supervisor rotates and
drains — assert no lost or duplicated events"), and that test would fail as specified. The
round-1 fix (rotate instead of truncate) was adopted; the *reason it works* was not, so the residual
race survived the rewrite.

**Concrete fix.** Drop the shared-inode append entirely — it buys nothing once hooks are
append-and-exit. Each hook writes **one file per event**: `queue/<ts>-<pid>-<rand>.json.tmp`, then
`rename(2)` to `queue/<ts>-<pid>-<rand>.json`. The supervisor globs `queue/*.json` (a partially
written event is still `.tmp` and invisible), reads, and unlinks each file it has processed. No
shared fd, no rotation, no race, and it matches the atomic-rename rule design:230 already states for
every other write. Restate design:239-241 accordingly.

---

## MAJOR 3 — "`BLOCKER` means any BLOCKER or MAJOR" × `MAX_PASSES = 2` makes escalation the default outcome, and `escalate` is a dead end with no exit.

**Claim.** design:380-381: "**`BLOCKER` means any BLOCKER *or* MAJOR finding** — the prompt says so
explicitly." design:335-336: "`pass` caps at `MAX_PASSES` (default 2). Exceeding it renders
`prompts/escalate.md` and **advances nothing**."

**Problem.** The two rules were adopted from round 1 independently and were not checked against each
other.

An adversarial review under `CLAUDE.md:39-44` ("evidence-first … Attack internal consistency … not
just the happy path") finds at least one MAJOR on almost any first draft. Under the new contract each
such review emits `VERDICT: BLOCKER`. So the common trajectory is: `spec` → `spec-review` (BLOCKER,
pass 1) → `spec` → `spec-review` (BLOCKER, pass 2) → `pass` exceeds `MAX_PASSES` → escalate. **A run
now escalates at the spec gate before a single task is dispatched**, which is the opposite of
`CLAUDE.md:36-37` ("Absent those, keep going to completion") and of design:42-44's goal ("so the human
never walks the fleet pane by pane").

This design's own history is the worked example the document offers at design:385-386: v1 produced 7
BLOCKERs and 12 MAJORs, v2 is pass 2 — and under its own contract v2's review emitting any MAJOR
means the run escalates now.

Second problem: escalation has no exit. `escalate` is not a `phase` value in the run record
(design:250 shows `"phase": "spec-review"`), nothing resets `pass`, and `hpipe rewind <run_id>
<phase>` (design:447) is not documented to reset it. So after the human answers the escalation and the
orchestrator rewrites the spec, the phase either never advances (nothing re-evaluates a run that
"advances nothing") or advances to `spec-review` where `pass` is still over the cap and escalates
again on the next tick.

**Concrete fix.**
1. Raise `MAX_PASSES` to `3` **or** define the gate on BLOCKER count only and let MAJORs advance with
   a carried "open MAJORs" note in the next prompt — this is the judgment call the user has to make,
   because `CLAUDE.md:28-30` genuinely does gate on "no BLOCKER/MAJOR that reverses a decision,
   changes scope, or needs a judgment only the user can make" — note the *qualifier*, which the
   design's flat "any MAJOR" reading drops. The faithful contract is: `BLOCKER` if any BLOCKER, or
   any MAJOR that reverses a decision / changes scope / needs the user; otherwise `CLEAR` with the
   MAJORs fixed inline alongside the MINORs.
2. Make `escalated` an explicit phase with `escalated_from` recorded, and make `hpipe rewind` reset
   `pass` to 0 for the phase it rewinds to. Add both to the `history` shape and the recovery table.

---

## MAJOR 4 — The settle check does not detect an incomplete artifact, and it replaced round 1's agent-status re-check under the same name.

**Claim.** design:342-344: "a **file** predicate requires `mtime > phase_entered_at`, plus a settle
check — read twice `SETTLE_MS` apart and require identical size and mtime, **so a half-written
artifact is not read as complete**". design:497 repeats it as a mitigation: "Freshness + settle
prevent stale/partial reads".

**Problem.** `SETTLE_MS` defaults to 750 (design:480). Claude Code does not write a spec in one
continuous stream — it issues a `Write` and then a series of `Edit` calls, seconds to minutes apart,
with the file perfectly stable between them. A 750 ms window of stability proves nothing about
completeness; it only excludes the sub-second interval *inside* a single syscall-level write, which
`Write` already makes atomic enough not to matter. The claimed property is not the property the check
has.

Worse, round 1's BLOCKER 6 fix #3 asked for a different settle check: "at flush time, re-read the
pane's status via `$HERDR_BIN_PATH agent get` and require it still to be `idle`/`done` after
`SETTLE_MS`. A momentary misclassification will have flipped back to `working` or `blocked` by then."
v2 kept the word `SETTLE_MS`, kept the config key, and pointed it at a different subject — the file
instead of the agent. The agent-status re-check does not appear anywhere in v2. Combined with
BLOCKER 4 (no idle condition in the table at all), the design now has *no* agent-state guard on seven
phases where v1 had one.

**Concrete fix.** Keep the file-stability check but describe it honestly ("guards against reading a
file mid-`write(2)`; it does not prove the artifact is finished"), and add back the guard that was
dropped: before delivering, re-read the actor pane with `$HERDR_BIN_PATH agent get <pane>` and require
`idle`/`done` at both the predicate evaluation and `SETTLE_MS` later. For review artifacts the real
completeness signal is already specified and should be stated as the primary one: the trailer
(design:369-378) must be the **last** non-empty line of the file, which a mid-write file will not have.

---

## MAJOR 5 — The `queued` gate is bypassed by `hpipe task`'s own output, gates on a pre-declared guess, exposes no task ids to depend on, and has no cycle check.

**Claim.** design:312: "**task** `queued` | supervisor | all `depends_on` tasks `done`, and no
in-flight task shares a `files` entry | task `execute`; **prompt orchestrator to dispatch it**".
design:325-329: "`queued` is the entry state for every task. … This implements two `CLAUDE.md` rules
v1 dropped". design:444: `hpipe task … --text <t>` — "Register a task; **print its rendered worker
prompt**".

**Problem.** Four defects, each of which alone defeats the gate:

1. **The gate is bypassed by design.** `hpipe task` hands the orchestrator the fully rendered worker
   prompt at *registration* time, before the gate has opened. The orchestrator's natural next action —
   and the one `prompts/dispatch.md` will teach — is to create the worktree and start the agent with
   that prompt. Nothing in the CLI or the state machine prevents dispatching a `queued` task; the
   supervisor's "prompt orchestrator to dispatch it" arrives *after* the work has already started.
2. **`files` cannot be known in advance.** design:279 sources `files` from `hpipe task`, i.e. the
   orchestrator's guess before any worker has run. `CLAUDE.md:92-94` forbids "two agents editing the
   **same** files in parallel" — actual edits, not declared intent. A worker that touches an
   undeclared file collides silently, which is precisely the failure the rule exists to prevent.
   Comparison is also exact-path, so `packages/core/src/db/usage.ts` and a sibling rename in the same
   directory do not register as a collision.
3. **No task ids to depend on.** `--depends-on <ids>` takes task ids, but ids (`t1`, design:259) are
   assigned by the plugin at registration and design:444 does not say `hpipe task` prints the id it
   assigned. The orchestrator cannot express `t2 depends_on t1`.
4. **No cycle check and no deadlock detector.** Two tasks naming each other stay `queued` forever. The
   run sits in `execute` with no artifact; the stall probe (MAJOR 7) is the only thing that fires, and
   it fires on healthy runs too, so it carries no signal.

**Concrete fix.** Smallest set that makes the gate real:
- `hpipe task` prints `task_id: t1` as the first line of its output, and its rendered prompt is
  **withheld** until the task leaves `queued` — print `queued: waiting on t1` instead, and have the
  supervisor's dispatch prompt carry the rendered text. That single change makes the gate binding
  instead of advisory.
- Reject a `--depends-on` graph containing a cycle at registration time (Kahn's algorithm over the
  run's tasks; refuse with the cycle named), and add a `queued` deadlock row to the failure table.
- Treat `--files` as prefix globs, and state plainly in §Ordering that it is a declared-intent
  heuristic, not an enforcement — with the orchestrator's PR-level conflict check as the real backstop.

---

## MAJOR 6 — `core`-first is implemented as an ordering constraint without the `dist` rebuild the rule exists for.

**Claim.** design:326-328: "This implements two `CLAUDE.md` rules v1 dropped: *core first* (`core`
tasks are depended on by app tasks, **because apps consume the built `dist`**)".

**Problem.** The requirement is not merely an ordering: `CLAUDE.md:95-97` reads "dispatch `core-dev`,
**let it land and rebuild `dist`**, *then* dispatch the app agent (the apps consume the built
`dist`)." The design implements "land" (via `depends_on` on task `done`, which follows merge) and
omits "rebuild `dist`" entirely. Nothing in the plugin, the supervisor, or `prompts/task.md` runs a
build. An app worker's worktree is created from `main` after the core PR merges, so its `packages/core`
*source* is current — but `CLAUDE.md:129` records that `packages/core` is a built ESM library
consumed through its `exports` map, and `CLAUDE.md:229-231` (the stale-`dist` footgun v1 was faulted
for dropping) is about the built output, not the source.

Claiming to implement the rule while omitting the half that names the failure is worse than not
claiming it, because a reader stops checking.

**Concrete fix.** One line in `prompts/task.md`, rendered only when the task has a `core` dependency:
"`@repo/core` changed on `main` since this branch's base — run `pnpm install && pnpm turbo build
--filter=@repo/core` before your first edit and before opening the PR." Then design:326-328 can claim
the rule honestly. If a build belongs in the supervisor instead, that is a scope change and needs the
user's call.

---

## MAJOR 7 — The stall probe fires on every healthy run, because `dispatch` and `execute` have no artifact by design.

**Claim.** design:88, the supervisor loop: "check stalls → **`STALL_MINUTES` since `phase_entered_at`
with no artifact**". design:479: `STALL_MINUTES`, default 15, "Idle-without-artifact before the
probe". design:516, the test plan: "stall probe firing exactly once per phase".

**Problem.** Of the 14 phase rows, `dispatch`, `queued`, `execute`, `ci`, `merge`, `close` and
`teardown` produce **no artifact file at all** — their predicates are worktree adoption, dependency
state, `gh pr list`, `gh pr checks`, `gh pr view`, `gh issue view`, and `worktree remove`. A run
legitimately sits in `execute` for hours while a six-worker fleet implements tasks. Under the rule as
written, `prompts/stall-probe.md` is injected into the orchestrator 15 minutes into **every** run,
during normal healthy operation.

That is not merely noise: the design's first stated cost is context budget (design:30-34), and this
spends it on a false alarm on every run, in the one phase where the orchestrator is busiest.

**Concrete fix.** Make the stall predicate artifact-phase-only and state it: the probe fires for a
phase whose completion predicate is a file (`spec`, `spec-review`, `plan`, `plan-review`,
`task-review-spec`, `task-review-quality`, `branch-review`) when `now - phase_entered_at >
STALL_MINUTES` and the actor pane has been `idle`/`done` since entry. For `execute`, the equivalent
liveness check is per-task and different — "no `agent_status` change and no PR after
`STALL_MINUTES`" — so give it its own key (`TASK_STALL_MINUTES`) or drop it from v1 and say so.

---

## MAJOR 8 — PID-file liveness is defeated by PID reuse, and `hpipe status` then reports a healthy supervisor that does not exist.

**Claim.** design:98-99: "Singleton-guarded by a **PID file with a liveness check**; a second instance
exits immediately." design:493: "Two supervisors | PID file + liveness check; the second exits."
design:445: `hpipe status` reports "**supervisor liveness**".

**Problem.** A bare pid plus `kill -0` is not a liveness check for a long-lived singleton:

- **Reuse.** The supervisor is killed by a server stop (verified: `pid 19961` was gone after
  `server stop`). The pid file survives — it is in `$HERDR_PLUGIN_STATE_DIR`, which is not cleaned.
  macOS recycles pids within a boot; the next `bun`/`sh`/agent process can take it. The next
  supervisor's liveness check then sees a live pid, **exits immediately**, and the pipeline is
  silently dead with `hpipe status` reporting it healthy. There is no recovery path short of the user
  deleting `supervisor.pid` by hand — a file the design never tells them about.
- **Restored ghost.** Per BLOCKER 1, a restart leaves a pane whose label says "Supervisor". Nothing
  correlates the pid file with a pane, so `status` cannot distinguish the three states (live, ghost
  pane, stale pid).
- **`--remote`.** design:54 scopes out cross-machine work, but `herdr --remote <target>` runs the
  server — and therefore the plugin and its pid file — on the remote host, while `hpipe` run from a
  local pane talks to the remote socket. The pid in the file is a remote pid and `kill -0` locally is
  meaningless. This needs one sentence, not a feature.

**Concrete fix.** Write `supervisor.pid` as `{pid, started_at_ms, boot_id, session, socket_path,
pane_id}`; liveness requires the pid to exist **and** its process start time to match `started_at_ms`
(`ps -p <pid> -o lstart=`) **and** `session` to equal `HERDR_SESSION`. A mismatch means stale: remove
the file and take over. Have `hpipe status` print all four states explicitly (live / stale-pid
reclaimed / another session owns it / no supervisor) and name the file path in the recovery table.

---

## MINOR 1 — Two of the three new `CLAUDE.md` citations point at the wrong lines.

design:281: "because `CLAUDE.md:83` makes an issue per task mandatory". `CLAUDE.md:83` is
"(`herdr agent read`/`send`). React on whichever fires; confirm the PR via `gh pr list --head
<branch>`." The issue rule is **`CLAUDE.md:66`**.

design:382: "the MAJOR rank that `CLAUDE.md:38` actually gates on". `CLAUDE.md:38` is a **blank
line**. The gating rule is **`CLAUDE.md:28-30`**.

`CLAUDE.md:46` (two-stage review, design:322) and `CLAUDE.md:76` (surface agent, design:333) are
both correct. For a document whose §Verified herdr facts opens "Prose in any `CLAUDE.md` is **not** a
source" (design:107), citing it by line and getting the line wrong is the same failure mode one level
down. **Fix:** `CLAUDE.md:66` and `CLAUDE.md:28-30`.

---

## MINOR 2 — `placement = "tab"` opens into the *active* workspace; nothing creates `PIPELINE_WORKSPACE_LABEL`.

design:221-226 declares `placement = "tab"`, and design:97 says the supervisor "lives in its own
unfocused workspace (`PIPELINE_WORKSPACE_LABEL`, default `pipeline`)". Verified live: with no
`--workspace`, `plugin pane open --placement tab` created `w1:t2` — a tab in the **active** workspace,
which in practice is the orchestrator's or a worker's. Passing `--workspace w2` does work
(`PluginPaneOpenParams.workspace_id`, verified in the schema and live), but the workspace must exist
first and `workspace create` also creates a stray shell pane (`w2:p1`) that nothing closes. **Fix:**
fold into BLOCKER 1's reconcile step, and note the stray root pane.

---

## MINOR 3 — The action that reopens the supervisor is still called `ci-pane`.

design:215-219, design:144, design:463, design:492 all name `ci-pane` — v1's name, when the pane only
polled CI. Its own title is already "Reopen the supervisor" (design:217). **Fix:** rename to
`supervisor` (ids may use letters, digits, colon, underscore, hyphen — `plugins.mdx:108-110`),
matching the `[[panes]]` id.

---

## MINOR 4 — `hpipe rewind` claims to move a task but takes no task selector; `hpipe abort` still has no inverse.

design:447: "`hpipe rewind <run_id> <phase>` | Move a run **or task** back to a phase". The signature
has no `--task <id>`, and task phases (`execute`, `task-review-spec`, …) are not run phases, so the
argument is ambiguous. Round 1's MAJOR 11 asked for `[--task <id>]` and for `hpipe abort` to become
reversible; the first was dropped and the second was not addressed — design:448 still describes abort
as one-way, so a human who aborts to stop the noise must finish the run by hand with no ledger.
**Fix:** `hpipe rewind <run_id> <phase> [--task <id>]`, and `hpipe resume <run_id>`.

---

## MINOR 5 — The 32-command row asserts an unverified absolute, and the check that would have caught a regression was dropped.

design:494: "32-command cap reached | Hooks are sub-50 ms and hold no slot; **the cap is no longer
reachable by this plugin's own design**". Measured here: a warm `bun run <trivial>.ts` is 10 ms, and
40 concurrent invocations completed in 279 ms wall with zero lost appends — so the *premise* is sound
and the architectural fix is real. But "no longer reachable" is not established: whether the 32 cap is
per-plugin or per-server is still unverified (round 1, open question 2), and a six-worktree teardown
sweep can produce more than 32 events inside one hook's lifetime. Round 1's fix also asked for "a
`plugin log list` check in the integration smoke test asserting zero `plugin_command_limit_reached`
entries"; design:504-520 does not include it. **Fix:** soften the row to "no longer reachable by this
plugin's own hooks in normal operation; asserted by the smoke test", and add the assertion.

---

## MINOR 6 — `WAKE_ON` mixes agent statuses with an event kind, and the `released` case is named but never handled.

design:401 and design:477: `WAKE_ON = blocked,done,idle,exited`. Herdr's agent statuses are `idle,
working, blocked, done, unknown` (`agent prompt --until`, verified); `exited` is a pane event, not a
status, and `unknown` — which is what a released or crashed agent becomes — is absent from the wake
set, so a worker whose agent is released never wakes anyone. design:117 adds the fact that
`pane.agent_detected` fires on release, with the consequence "Handler must check the payload, not
assume attach" — but no phase, predicate, or failure row says what a release *does*. Round 1's MINOR 4
proposed marking the task `failed`. **Fix:** document `WAKE_ON` as covering statuses plus the
`pane.exited`/`released` events explicitly, and add `released == true` on a task's pane → task
`failed`, surfaced (mirroring design:501).

---

## MINOR 7 — `prompts/digest.md` is orphaned, and `{{agent_file}}` has no existence check.

design:154 ships `digest.md`, but the coalesced message shape is specified inline at design:404-416
and no phase or transport step references the prompt. Either wire it or drop it. Separately,
design:331-333 renders `{{agent_file}}` as `.claude/agents/<surface>-dev.md` without requiring the
file to exist — round 1's BLOCKER 5 fix asked for a hard error at registration. All six files do
exist today (`core-dev, api-dev, crawler-dev, dashboard-dev, emails-dev, worker-dev`, verified in
`nicaraguan-laws/.claude/agents/`), which is exactly why a typo in `--surface` would render a
plausible dead path silently. **Fix:** `hpipe task` rejects a `--surface` with no matching
`.claude/agents/<surface>-dev.md` under the run's `repo_root`.

---

## MINOR 8 — Teardown is still unconditional, and `GH_BIN` is named only in the test plan.

design:319 and design:430-433 make teardown unattended with no opt-out; `CLAUDE.md:88-89` says "Skip
only if a follow-up still needs the branch." Round 1's MINOR 8 (`hpipe task --keep-worktree`) was not
addressed. Separately, design:506-507 injects the `gh` fake "by overriding `HERDR_BIN_PATH` and a
`GH_BIN` indirection", but `GH_BIN` appears in neither the configuration table (design:474-486) nor
the `lib/gh.ts` description (design:148). **Fix:** add `--keep-worktree` and a `GH_BIN` row.

---

## Audit of round 1's findings

29 findings: **17 genuinely fixed, 6 cosmetic, 6 displaced.**

| R1 | Finding | Verdict | Evidence |
| --- | --- | --- | --- |
| B1 | Orchestrator excluded from the event path | **Fixed** | design:298-301 splits waking from evaluation, exactly as proposed. Over-corrected into new BLOCKER 4 (the idle condition vanished from the table too) |
| B2 | No clock anywhere | **Displaced** | The supervisor is a real clock (design:83-90) and `STALL_MINUTES`/`PROMPT_RETRY_MAX` now have a home. The liveness problem moved into the supervisor's own lifecycle → BLOCKERs 1, 2, 5; MAJOR 8 |
| B3 | `agent start` obsolete; reaper built on it | **Fixed** | Re-verified: `herdr agent start <NAME> --kind <KIND> --pane <ID>`, "in an existing pane". `grep -n "reaper\|root_pane_id\|REAP_ORPHAN"` finds only the v2-changes note — the subsystem is gone |
| B4 | Task ordering and the collision rule dropped | **Cosmetic** | `surface`/`depends_on`/`files`/`queued` added (design:312, 325-329), but the gate is bypassed by `hpipe task`'s own output, gates on a guess, has no task ids and no cycle check, and omits the `dist` rebuild → MAJORs 5, 6 |
| B5 | One review per task; no surface routing | **Fixed** | `task-review-spec` + `task-review-quality` (design:314-315), `{{surface}}`/`{{agent_file}}` (design:331-333). The "hard error on a missing agent file" half was dropped → MINOR 7 |
| B6 | Screen-scraped status; "never derailing" false | **Fixed** | design:351-365 withdraws the claim explicitly and states the residual risk. Fix #3 (agent-status re-check) was displaced onto a file check → MAJOR 4 |
| B7 | Level-triggered predicates livelock | **Displaced** | §"Predicates are edges" added (design:338-349) but applied to runs only; tasks have no `phase_entered_at` → BLOCKER 3 |
| M1 | 32-command cap; in-hook `sleep` | **Fixed** | The architecture flip removes the sleep entirely; measured 10 ms warm hooks, 40 concurrent in 279 ms with no loss. The smoke-test assertion was dropped → MINOR 5 |
| M2 | Flush lock never released | **Fixed** | `flush.lock` deleted; only the v2-changes note mentions it |
| M3 | Read/truncate races appenders | **Cosmetic** | Rotation adopted (design:239-241) with a false justification; the residual loss is reproducible → MAJOR 2 |
| M4 | `gh pr checks --json conclusion` | **Displaced** | `conclusion` correctly removed and `bucket`/exit-8 documented (design:119, 425-428) — and the identical error reappears one row above at `gh pr view --json merged` → MAJOR 1 |
| M5 | `worktree.created` has no pane id | **Fixed** | design:112 and design:278 both corrected |
| M6 | Focused-pane fallback resolves the worker | **Fixed** | design:291-293 deletes it and says why; design:114 records the live evidence |
| M7 | CI supervisor may not exist when needed | **Displaced** | Made unconditional (design:96-99) — and the mechanism that was supposed to open it does not work → BLOCKER 1 |
| M8 | Binary verdict discards MAJOR | **Cosmetic** | Wording fixed (design:380-383) without checking it against `MAX_PASSES`, and `CLAUDE.md`'s qualifier on "hard blockers" was dropped → MAJOR 3 |
| M9 | Prompting a mid-turn agent | **Displaced** | `hpipe start` now prints (design:451-453) and the risk is named (design:118), but BLOCKER 4 makes mid-turn injection the normal path for every other delivery, and it is still unverified |
| M10 | `pane.exited` has no status | **Fixed** | design:115; the digest at design:413 now reads "exited, no PR" |
| M11 | No kill switch, no correction path | **Fixed** | §Recovery added (design:455-468) with `plugin disable`, `unlink`, and `hpipe rewind`. `--task` and `hpipe resume` still missing → MINOR 4 |
| M12 | `REPOS_ALLOW` can't disambiguate | **Fixed** | design:295-296 says so explicitly |
| m1 | `workspace.metadata_updated` | **Fixed** | design:121 |
| m2 | `hpipe` symlink won't execute | **Cosmetic** | Shebang + `0755` (design:160-162) and stale-link replacement (design:438-439) added; nothing still removes `~/.local/bin/hpipe` on unlink |
| m3 | `PATH` fakes can't intercept | **Fixed** | design:506-508 (`GH_BIN` undocumented → MINOR 8) |
| m4 | `agent_detected` fires on release | **Cosmetic** | Fact row added (design:117); no handler behaviour anywhere → MINOR 6 |
| m5 | `status` vs `phase` overlap | **Fixed** | design:261-262, 271-272 |
| m6 | `run_id` collides | **Fixed** | design:247, 270 |
| m7 | Issue per task made optional | **Fixed** | design:280-282 makes `--issue` required (wrong citation → MINOR 1) |
| m8 | Teardown unconditional | **Not addressed** | design:319, 430-433 unchanged; no `--keep-worktree` → MINOR 8 |
| m9 | `min_herdr_version` argument from ignorance | **Fixed** | design:127-129 |
| m10 | v1 adds a system without removing one | **Fixed** | design:529-531 says so plainly |

**Re-verification of v2's "Verified herdr facts" table (design:109-125).** Independently re-derived;
every row holds except as noted. `agent start --kind --pane` ✓ (`--help`). `worktree.created` has no
pane id ✓ (schema). 32-command cap ✓ (round 1's live capture; scope per-plugin vs per-server still
unverified). Event-time `focused_pane_id` ✓. `pane.exited` payload ✓. Claude Code screen-manifest
authority ✓ (`agents.mdx:28,50,60`). `agent_detected` release ✓ (schema `released`). `agent prompt`
pre-send `agent_blocked` ✓ (`--help`, verbatim). `gh pr checks` field list ✓ (re-executed, exact
match) — but the neighbouring `gh pr view --json merged` in the phase table is wrong (MAJOR 1).
`PluginActionInvokeParams` takes only `action_id`, `plugin_id`, `context` ✓ (schema).
`workspace.metadata_updated` ✓. Token limits ✓ (`socket-api.mdx:778` "at most 16 token keys … at most
32 keys"; `:788` "caps … at 80 characters"; `:792` "Token metadata is not restored after a server
restart" — round 1 left this as an open question; v2's assertion is correct). `WorkspaceInfo.worktree`
✓. `plugin.pane.open` accepts `env` ✓ (schema) — but the row's implied consequence, that the startup
hook can therefore parameterise the supervisor, is defeated by BLOCKER 1. Startup hooks one-shot ✓
(`plugins.mdx:236-248`).

Two claims outside that table were **newly verified favourably** and are worth promoting into it,
since the design now depends on both: a pane's interactive shell carries `HERDR_PANE_ID`,
`HERDR_SESSION` and `HERDR_SOCKET_PATH` (so `hpipe start`'s implicit claim at design:286 works —
round 1 open question 3, resolved), and `$HERDR_PLUGIN_STATE_DIR` is
`~/.local/state/herdr/plugins/<id>`, **not session-scoped** (which is what makes BLOCKER 5 bite).

**Checked and found not to be a problem** (recorded so the next round does not re-litigate them):
mtime granularity — `/Volumes/stein` is APFS with nanosecond `st_mtime_ns` (measured deltas of
3.4–4.0 ms between consecutive writes), so `mtime > phase_entered_at` in milliseconds is sound on
both declared platforms; and clock skew is a non-issue because `phase_entered_at` and the artifact's
mtime are both stamped by the same host.

---

## Open questions (not ranked as findings)

1. **Is the 32-concurrent-command cap per plugin or per server?** Still unverified (round 1's open
   question 2). It only matters if the user runs a second plugin.
2. **What does Claude Code do with an `agent prompt` that lands mid-turn?** design:118 accepts it as a
   risk; BLOCKER 4 makes it the normal path. It needs one live test against a Claude Code pane under
   herdr before the state machine is built on it — it is still the single highest-value thing to
   check.
3. **Does a plugin pane survive `herdr update --handoff`?** `session-state.mdx:97` says handoff
   preserves "pane PTYs and processes", which suggests the supervisor process survives while the
   startup hook runs again — i.e. a duplicate is opened and the PID guard exits it. Not tested
   (handoff is disabled for non-updater installs).
4. **Does `worktree.removed` fire for a workspace closed via `workspace.close` rather than `worktree
   remove`?** Round 1 found no `pane.exited` on worktree removal; the converse was not tested, and
   design:319/433 depends on it to mark a hand-removed worktree `orphaned`.

---

## Verdict

Five BLOCKERs and eight MAJORs. The architectural flip was the right call and most of round 1's
findings are genuinely gone — the reaper, the in-hook sleep, the flush lock, the focused-pane
fallback, the `conclusion` field and the binary verdict are all correctly dealt with, and the
withdrawal of the "never derailing" claim (design:351-365) is exactly the kind of honesty a v2 should
show.

But the supervisor was designed and not probed, and it does not behave the way the document assumes.
It cannot be opened by the startup hook on a cold start (`no_active_workspace`); a server restart
resurrects it as a mislabelled shell and opens a duplicate beside it; and when it dies its pane
vanishes, which falsifies the one sentence justifying a pane over a daemon. Its state directory is
global while its pane ids are per-session, and this machine is running two herdr servers right now.

Two of round 1's fixes are half-applied in ways that recreate the original defect one level down:
edge-triggered predicates were given to runs and withheld from tasks, so the livelock survives in the
task machine; and the `gh` field that was verified for `pr checks` was left unverified for `pr view`,
reproducing the exact bug that finding existed to kill. A third — the settle check — kept round 1's
name while quietly changing its subject, so the agent-status guard it was meant to add is simply
absent, and the phase table then removed the idle condition it was meant to reinforce.

The fixes are all local. Nothing here argues against the design's shape: hooks that append and exit,
one process with a clock, the plugin owning the prompt text so it dictates where the answer goes. The
supervisor just has to be specified against what herdr actually does to a plugin pane, and the edge
rule has to be applied to the half of the machine that was left out.

VERDICT: BLOCKER
