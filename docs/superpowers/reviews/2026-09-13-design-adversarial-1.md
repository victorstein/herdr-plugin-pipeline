# Adversarial review — herdr-plugin-pipeline design v1

**Target:** `docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md`
**Date:** 2026-09-13
**Reviewer method:** every "verified herdr fact" re-checked against the installed `herdr 0.9.0`
binary, its bundled API schema, the v0.9.0 docs at `raw.githubusercontent.com/herdrdev/herdr/v0.9.0`,
and a **live probe plugin** linked into a throwaway herdr session (`--session probetest`, since
deleted; registry restored to empty). `gh 2.96.0` and `bun 1.3.14` behaviours executed directly.

Citations of the design use `design:<line>`; the requirements document is
`/Volumes/stein/Documents/development/personal/nicaraguan-laws/CLAUDE.md`, cited as `CLAUDE.md:<line>`.

---

## BLOCKER 1 — The orchestrator pane is excluded from the event path, so no orchestrator-owned phase can ever complete

**Claim.** design:269-270: "The plugin advances a phase only when its **completion predicate** is
satisfied, evaluated on `pane.agent_status_changed → idle | done` for a pane it knows." Seven of the
twelve phases in the table at design:273-285 have Actor = *orchestrator* (`spec`, `spec-review`,
`plan`, `plan-review`, `dispatch`, `merge`, `close`, `branch-review`).

**Problem.** design:265 states, as a deliberate invariant: "**A pane registered as an orchestrator is
excluded from the event path.** Without this the orchestrator's own status changes would wake itself
in a loop." design:323-324 implements it: "Resolve the workspace to a run + task. Unknown workspace,
**or a registered orchestrator pane → exit 0.**"

The orchestrator's `idle`/`done` transitions are therefore discarded at step 2 of every hook, before
any predicate is evaluated. Nothing else can drive those phases:

- During `spec`, `spec-review`, `plan`, `plan-review` there are **no worker panes at all** — dispatch
  has not happened. Zero events reach the machine.
- There is no timer (see BLOCKER 2), so nothing re-evaluates on elapsed time.

A run therefore dead-stops at `spec` forever, and the stall probe that was supposed to catch that
(design:312-316) cannot fire either, because it too is only reachable "with at least one idle
transition".

**Evidence.** design:265, design:323-324 versus design:269-270 and the Actor column of
design:274-285. This is a pure internal contradiction; no external verification needed.

**Concrete fix.** Split the one exclusion into two independent predicates:
`is_wake_target(pane)` (never *prompt* a pane about its own transition — the actual loop risk) and
`is_event_source(pane)` (always *evaluate* the machine). Change step 2 to: an orchestrator pane's
event updates the ledger, evaluates that run's phase, and is marked `no_wake` so the flush renders
the next phase's prompt without counting the orchestrator's own idle as an event line.

---

## BLOCKER 2 — There is no clock anywhere in the architecture; the stall probe, the retry backoff, and every timeout are unimplementable

**Claim.** design:312-316: "after `STALL_MINUTES` (default 15) in one phase with at least one idle
transition and no artifact, the plugin injects `prompts/stall-probe.md` once per phase."
design:340-342: delivery failure "schedules a bounded retry with backoff (`PROMPT_RETRY_MAX`,
default 5)."

**Problem.** The design has exactly three process kinds and none of them can tick:

1. **Startup hook** — one-shot, runs once after the server restores the session, and again only on
   live handoff. The design states this itself as a verified fact (design:80) and the docs confirm it
   ("Startup hooks are one-shot initialization commands rather than supervised daemons",
   `plugins.mdx:242-244`).
2. **Event hooks** — one process per event, verified live: a `pane split` produced exactly one hook
   process which exited when the script did (plugin log `status: succeeded`). They only exist when an
   event exists.
3. **The CI supervisor pane** — design:385 says it is "opened by the startup hook via
   `plugin.pane.open` **when any run has an open PR**". During `spec` … `dispatch` no PR exists, so
   the pane is not open. It is also the *only* long-lived process in the design, and design:392
   scopes it explicitly: "Its output is not parsed by anything — the queue is the interface."

So no component evaluates elapsed time. `STALL_MINUTES`, `phase_entered_at` (design:213),
`PROMPT_RETRY_MAX` and the backoff are all dead configuration. Combined with BLOCKER 1 the run has
no liveness mechanism at all: the only recovery is a human typing `hpipe drain`.

The "schedule a retry with backoff" wording also contradicts the design's own verified fact at
design:80 ("Long-running work goes in a plugin *pane*, not a background process") — a retry loop in a
one-shot hook is exactly a background process, and it holds a scarce plugin-command slot while it
sleeps (see MAJOR 1).

**Concrete fix.** Make the supervisor pane unconditional and make it the tick: open it from the
startup hook whenever *any* run exists (not only when a PR exists), and give it one loop that every
`TICK_SECONDS` (a) polls CI for tasks that have PRs, (b) evaluates stall probes against
`phase_entered_at`, (c) retries any failed delivery, and (d) drains a non-empty queue. If that is too
much for v1, delete `STALL_MINUTES` and `PROMPT_RETRY_MAX` from the design and state plainly that
`hpipe drain` is the only recovery from a missed delivery.

---

## BLOCKER 3 — `herdr agent start` does not open a pane in 0.9.0. The reaper, `root_pane_id`, `REAP_ORPHAN_ROOT_PANE` and the "dispatch footguns" prompt are all built on an obsolete CLI

**Claim.** design:78, a load-bearing row of the "Verified herdr facts" table: "`herdr agent start`
**always opens a new pane**, orphaning a worktree's root shell | The reaper exists". The whole
§"Orphan root-pane reaper" (design:364-374), the `root_pane_id` field (design:222), the
`REAP_ORPHAN_ROOT_PANE` config key (design:464) and design:406-409 ("`prompts/dispatch.md` carries
the two dispatch footguns verbatim from `nicaraguan-laws/CLAUDE.md` — pass `--workspace`; close the
orphaned root pane") all rest on it.

**Problem.** In herdr 0.9.0 `agent start` takes an *existing* pane and has no workspace/cwd
arguments at all.

**Evidence.**

`herdr api schema`, `schemas.request.$defs.AgentStartParams`:

```json
{"properties": {"args": {...}, "kind": {...}, "name": {...}, "pane_id": {...}, "timeout_ms": {...}},
 "required": ["name", "kind", "pane_id"]}
```

`cli-reference.mdx:319`:

```
herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
```

`cli-reference.mdx:334`: "`agent start` **activates an existing available shell pane**: the pane's
interactive shell must own the foreground, with no foreground command, editor, or agent running.
**Topology must be created separately.**"

`herdr agent --help` on the installed binary: "start — Start a supported interactive agent **in an
existing pane**."

The behaviour the design encodes is from `CLAUDE.md:69-74`, which describes a pre-0.9.0 signature
(`herdr agent start <name> --workspace <ws> --cwd <worktree> -- claude ...`). Passing `--workspace`
to 0.9.0's `agent start` is not a footgun to avoid — it is an unrecognised flag. A `prompts/dispatch.md`
that "carries the two footguns verbatim" would teach the orchestrator a command that fails.

This also invalidates design:427 ("The orchestrator passes that output straight to `herdr agent
start`") — in 0.9.0 the executable is selected by `--kind claude` and the prompt would have to travel
as an argument after `--`, which this review did **not** verify end-to-end.

**Concrete fix.** Delete §"Orphan root-pane reaper" (design:364-381), the `root_pane_id` field, the
`REAP_ORPHAN_ROOT_PANE` key, and the reaper half of `src/hooks/agent-detected.ts`. Rewrite the
dispatch contract as: `herdr worktree create --branch <b> --workspace <parent>` → read
`.result.root_pane.pane_id` from the **response** → `herdr agent start <name> --kind claude --pane
<root_pane_id> -- --dangerously-skip-permissions "<rendered prompt>"`. Verify that final argv live
against one throwaway worktree before writing `prompts/dispatch.md`; the result is one pane per
worktree with no orphan, which is the outcome the reaper existed to produce.

---

## BLOCKER 4 — The workflow's task-ordering and collision rules are silently dropped

**Claim.** design:231-232: "Tasks carry their own `phase` — workers progress independently and in
parallel. … During `execute` the run sits still while tasks move." design:279: `dispatch` completes
on "≥1 `worktree.created` adopted into this run".

**Problem.** The requirements make two ordering rules mandatory, and the design has no representation
for either:

- `CLAUDE.md:91-94`: "**Default to parallel across non-colliding surfaces/files.** … Keep the
  collision rule: **never two agents editing the same files in parallel** — when two PRs must touch
  one file …, serialize or rebase the second onto the first before merge."
- `CLAUDE.md:95-97`: "**Route by surface; `core` first.** … A change spanning `core` + an app:
  dispatch `core-dev`, **let it land and rebuild `dist`, *then* dispatch the app agent** (the apps
  consume the built `dist`)."

The Task record (design:220-226) carries `task_id, branch, issue, workspace_id, pane_id,
root_pane_id, status, pr, ci, phase, text`. There is no `depends_on`, no `surface`, no file set.
`hpipe task` (design:442) takes `--branch`, `--issue`, `--text`. Nothing in the machine can hold a
task back, and `dispatch` explicitly advances the run on the *first* adopted worktree, which
encourages the orchestrator to fire everything at once. The `nicaraguan-laws` footgun this is meant
to replace (stale `@repo/core` `dist`, `CLAUDE.md:229-231`) is a data-corruption-class failure, not a
style preference.

**Concrete fix.** Add `surface: string` and `depends_on: string[]` to the task record and
`--surface`/`--after` to `hpipe task`. Add a `queued` task sub-phase: a task with unsatisfied
`depends_on` is registered but not dispatched, and the plugin surfaces "N tasks unblocked" in the
flush message when a dependency reaches `done`. `prompts/dispatch.md` must instruct the orchestrator
to declare the surface and any `core`-first dependency at registration time.

---

## BLOCKER 5 — One review per task instead of the mandatory two-stage review, and no surface-agent routing in the worker prompt

**Claim.** design:280 gives each task exactly one `task-review` phase with one verdict file.
design:396-398 lists every template placeholder: `{{run_id}} {{title}} {{repo_root}} {{spec_path}}
{{plan_path}} {{verdict_path}} {{pass}} {{task_text}} {{branch}} {{issue}} {{pr}} {{ci_failure}}`.
design:424-426 enumerates what `prompts/task.md` carries: the verdict path, the closing-keyword
requirement, and the escalation rule.

**Problem.** Two required elements of the workflow are absent:

1. `CLAUDE.md:46-48`: "fresh subagent per task; **two-stage review per task (spec compliance, then
   code quality)**". The design has one stage. The two stages catch different classes of defect and
   the requirement is stated twice (`CLAUDE.md:46-48` and again at `CLAUDE.md:55-56`).
2. `CLAUDE.md:76-77`: the worker prompt "**points at the scoped `.claude/agents/<surface>-dev.md`**",
   and `CLAUDE.md:116-121` names six such agents (`core-dev`, `api-dev`, `crawler-dev`, `emails-dev`,
   `worker-dev`, `dashboard-dev`) each of which "carr[ies] the same three [prime-directive] rules
   scoped to their surface". A worker that is not pointed at its surface agent loses the
   mirror-the-nearest-example rule that the repo's PRIME DIRECTIVE depends on.

Because design:39 makes "Shipping Claude Code skills. All instruction text lives in this package." a
non-goal-by-inversion, and design:414-431 says "The plugin owns every instruction *except* what the
task is", the omission is load-bearing: the orchestrator is explicitly told **not** to compose its
own prompt, so it cannot add the routing back.

**Concrete fix.** Split `task-review` into `task-review-spec` → `task-review-quality`, each with its
own verdict path and `VERDICT:` trailer, and add `prompts/task-review-quality.md` to the package
layout. Add `{{surface}}` and `{{agent_file}}` (rendered as `.claude/agents/{{surface}}-dev.md`) to
the render context, populated from `hpipe task --surface <s>`, and have `prompts/task.md` name that
file. A `--surface` with no matching `.claude/agents/*-dev.md` should be a hard error at
registration, not a silently empty placeholder (the design already requires unresolved placeholders
to be fatal — design:399-400 — so extend that rule to the file's existence).

---

## BLOCKER 6 — Completion inference rests on screen-scraped agent status for Claude Code, and the "stalling, never derailing" invariant is false

**Claim.** design:308-311: "The governing invariant: **a missing or unparseable artifact means 'not
done'.** … An orchestrator that went idle to ask the human a question has not written the file, so it
cannot be falsely advanced. **The failure mode is therefore *stalling*, never *derailing*.**"

**Problem.** The invariant only holds if "went idle to ask a question" and "finished the turn" are
distinguishable, and if the artifact's presence implies the work that produced it is finished.
Neither holds for Claude Code on herdr 0.9.0.

**Evidence.**

`agents.mdx:28` — the supported-agents table:

| Agent | State authority | Integration role |
| --- | --- | --- |
| Claude Code | **screen manifest** | **session** |

`agents.mdx:50` — "Integrations marked `session` in the table above are **intentionally not lifecycle
authorities**. They provide native session identity for restore, but their hooks do not cover the
whole lifecycle. **They can miss permission approval results, escape interrupts, or other
transitions.** For those agents, Herdr still uses screen manifest detection."

`agents.mdx:60-62` — "Blocked detection is deliberately strict for screen-manifest agents. … **If no
manifest rule matches for a known agent, Herdr falls back to `idle`** … This means unusual new agent
prompts may initially show as `idle` instead of `blocked` until Herdr learns that screen shape."

This directly falsifies the premise the design inherited from `CLAUDE.md:79-80` ("The claude
integration hook makes state reliable from the live transcript (`herdr integration status` →
`claude: current`)") — that prose is wrong for 0.9.0, and the design repeats its consequence without
re-checking it, despite design:66-67 claiming every row was "Established against the installed
`herdr 0.9.0` binary's API schema … and the v0.9.0 docs."

Concrete derail paths this opens:

- **Worker.** The task agent opens the PR (so `gh pr list --head <branch>` returns it), then hits an
  unrecognised permission dialog. Herdr reports `idle`. The `execute` predicate (design:279) is
  "task agent `done`/`idle` **and** `gh pr list --head <branch>` returns a PR" — both true. The task
  advances to `task-review` and the orchestrator reviews a PR whose author is still mid-turn and
  blocked.
- **Orchestrator.** The orchestrator writes `docs/.../spec.md`, then asks the human a clarifying
  question on a prompt shape herdr does not recognise → `idle` + file exists → `spec-review` is
  injected on top of the open question.
- **Ordering.** Nothing requires the artifact to have been written *during* the turn that went idle.
  An agent that writes a partial artifact early in a long turn and idles later satisfies the
  predicate on stale content; the parser reads only "the last `VERDICT:` line of the file"
  (design:306), which a truncated file may not have — that case at least holds — but a `spec`/`plan`
  file has no trailer requirement at all (design:274, design:276: "spec file exists", "plan file
  exists"), so *any* partial write advances the phase.

**Concrete fix.** Three changes, all cheap:

1. Replace the fact row at design:71-80 with the real one: "Claude Code's state authority is the
   **screen manifest**; the claude integration provides session identity only. `idle` is also the
   documented fallback when no rule matches, so `idle` does not prove the turn ended."
2. Require the artifact to be **newer than `phase_entered_at`** (`stat` mtime) for every
   existence-based predicate. This is also the fix for BLOCKER 7.
3. Add a settle check: at flush time, re-read the pane's status via `$HERDR_BIN_PATH agent get` and
   require it still to be `idle`/`done` after `SETTLE_MS`. A momentary misclassification will have
   flipped back to `working` or `blocked` by then.

And delete the "never *derailing*" sentence — it is an unsupported safety claim, and the design's
whole argument for autonomy leans on it.

---

## BLOCKER 7 — Existence-of-file predicates are already satisfied on re-entry, so every failure branch is a false-advance loop

**Claim.** design:274-285, the phase table. `spec` completes when "spec file exists at the path the
prompt named"; `spec-review` on BLOCKER goes "else `spec`, `pass`+1". `execute` completes when "task
agent `done`/`idle` **and** `gh pr list --head <branch>` returns a PR"; `task-review` on BLOCKER goes
"else task → `execute`, re-prompt worker"; `ci` red goes "task → `execute` with the failing check".

**Problem.** Every one of those re-entries lands in a phase whose predicate is *already true*:

- Re-entering `spec` after a failed review: the pass-1 spec file is still on disk. The predicate is
  satisfied the instant the phase is entered.
- Re-entering `execute` after a failed `task-review` or a red CI: the PR still exists. The predicate
  needs only one more `idle`/`done` from that pane — which the very next event delivers, including
  the idle that follows the plugin's own re-prompt landing.
- Re-entering `plan` and `branch-review` the same way.

So the machine bounces `execute → task-review → execute → task-review` on unchanged work, consumes
both `MAX_PASSES` (design:287) in seconds, and lands in `escalate` with a review the human will read
as spurious. The `pass` counter does not protect against this — it *accelerates* the failure into an
escalation.

The design half-anticipates this with per-pass verdict keys (`"verdicts": { "spec-review-1": … }`,
design:217) but never states that the *path* differs per pass, and never applies the idea to `spec`,
`plan`, or `execute` at all.

**Concrete fix.** Make every predicate an **edge**, not a level. On entering a phase, record
`phase_entered_at` (already in the record, design:213) and for tasks a `rework_entered_at`. Then:
`spec`/`plan`/`*-review` require `stat(artifact).mtime > phase_entered_at`; `execute` requires
`gh pr view <pr> --json headRefOid,updatedAt` to show a head SHA different from the one recorded at
entry. State this as a governing rule alongside the "missing artifact means not done" invariant.

---

## MAJOR 1 — Plugin event hooks are capped at 32 concurrent commands and herdr *drops* the event over the cap; the debounce `sleep` inside a hook parks a slot

**Claim.** design:330-333: "Try `mkdir flush.lock`. The winner **sleeps `DEBOUNCE_MS` (default
2000)**, then reads and truncates the queue …". design:342: "**Nothing is dropped: the disk queue is
the truth** and the prompt is only a doorbell."

**Problem.** herdr bounds concurrent plugin commands at 32 and, over the cap, **fails the hook
without running it**. An event whose hook never ran never reaches `queue.jsonl`, so the disk queue is
not the truth — the event is gone.

**Evidence (live, herdr 0.9.0).** A probe plugin with a hook that sleeps was linked, then 40 panes
were created in a burst. `herdr plugin log list`:

```
Counter({'running': 32, 'failed': 8, 'succeeded': 2})
```

and the failed entries:

```json
{"log_id":"plugin-log-35","event":"pane.created","status":"failed","stdout":"","stderr":"",
 "error":"maximum concurrent plugin commands reached (32)"}
```

A `worktree.created` fired while the 32 slots were held was dropped the same way:

```
plugin-log-45 worktree.created failed maximum concurrent plugin commands reached (32)
```

No retry, no queueing, no stderr for the plugin to see — the only trace is the plugin command log.
The same string is in the binary: `strings herdr | grep` yields `plugin_command_limit_reached` and
`maximum concurrent plugin commands reached (`.

Two mitigating facts, also verified live, so the design is not wrong about these: herdr does **not**
block on a hook (a `pane split` returned in 12 ms while its hook was still running, plugin log
`status: running`), and it does **not** kill a long one (an 8 s hook completed cleanly,
`finished_unix_ms - started_unix_ms = 8018`, `exit_code: 0`). The cost of the sleep is purely the
slot it occupies.

32 is not comfortable headroom for this design. A six-worker fleet plus an orchestrator plus the CI
pane produces bursts on `worktree.created` + `pane.created` + `pane.agent_detected` +
`pane.agent_status_changed`; the design adds a 2 s sleep to one of them, a `gh` network call inside
the `execute` predicate (design:245-248, acknowledged as "the one place the hot path touches the
network"), and a retry-with-backoff loop on delivery failure (design:340-342) which extends the hold
further. Slot exhaustion silently loses exactly the transitions the machine runs on.

**Concrete fix.** Never sleep in a hook. Each hook does: append to the queue, update the badge, exit
— target well under 100 ms. Move the debounce and the flush to the supervisor pane (the same fix as
BLOCKER 2): the pane wakes on a tick, sees a non-empty queue and a `flush_after` timestamp, and does
the coalesced delivery. If the flush must stay in-hook for v1, replace the sleep with a
`flush_after_ms` timestamp written to the state dir: a hook that arrives after that timestamp does
the flush immediately and no process ever sleeps. Add a `plugin log list` check to the integration
smoke test asserting zero `plugin_command_limit_reached` entries.

---

## MAJOR 2 — The flush lock has no release and no staleness rule; one killed winner silences the plugin permanently

**Claim.** design:330-334 and design:199: "`flush.lock/` mkdir-based mutex for the debounce window";
"Try `mkdir flush.lock`. The winner sleeps … Losers exit immediately".

**Problem.** The design never says who removes the lock directory, nor what a later hook should do if
it finds a stale one. The winner can die without releasing it: killed by the 32-command cap (MAJOR 1),
by a server stop, by a bun crash, or by the machine sleeping. From that moment every hook is a loser
and the orchestrator is never woken again. With no timer (BLOCKER 2) there is no self-healing path;
recovery requires a human noticing silence and running `hpipe drain`.

design:476 lists "Concurrent hook processes | Atomic rename on every write; `mkdir` mutex on the
flush" as a *handled* failure mode, which overstates what a bare `mkdir` gives you.

**Concrete fix.** Write `flush.lock/owner` containing `{pid, started_at}`. Any hook that finds a lock
older than `2 × DEBOUNCE_MS` (or whose pid is gone) removes it and retries the `mkdir` once. Remove
the lock in a `finally`, and add a unit test that kills the winner mid-sleep and asserts the next
event still flushes.

---

## MAJOR 3 — The queue read/truncate races the appenders the winner is supposed to carry

**Claim.** design:330-334: "The winner sleeps `DEBOUNCE_MS`, then **reads and truncates the queue** …
Losers exit immediately — **their events are already on disk and the winner will carry them.**"

**Problem.** The invariant holds only for losers that appended *before* the read. A loser that
appends after the truncate is orphaned: it already lost the lock, so it scheduled nothing, and with
no timer nothing re-flushes. Worse, a truncate concurrent with an `O_APPEND` write can discard or
tear that line outright — the design's atomicity story (design:192-193, design:476) is explicitly
about "write to `<file>.tmp`, then `rename(2)`", which is exactly the technique the append-only queue
does *not* use.

**Concrete fix.** Rotate instead of truncate. Under the lock: `rename(queue.jsonl,
queue.flushing.<ts>.jsonl)`, then read the rotated file and delete it after a successful prompt (keep
it on failure — that is also the retry backlog). After releasing the lock, the winner re-`stat`s
`queue.jsonl` and, if it is non-empty, takes another pass. This makes the design's own concurrency
test ("N hook processes racing one flush; assert exactly one prompt and **no lost events**",
design:493) actually passable.

---

## MAJOR 4 — `gh pr checks --json conclusion` does not exist

**Claim.** design:281: the `ci` phase completes when "`gh pr checks` **conclusion** is terminal".
design:388: "it polls `gh pr checks <pr> --json name,state,conclusion` every `CI_POLL_SECONDS`".

**Problem.** `conclusion` is not a field of `gh pr checks`. The command errors out.

**Evidence.** `gh 2.96.0`:

```
$ gh pr checks --json name,state,conclusion
Unknown JSON field: "conclusion"
Available fields:
  bucket
  completedAt
  description
  ...
```

`gh pr checks --help`: "JSON FIELDS: bucket, completedAt, description, event, link, name, startedAt,
state, workflow" and "When the `--json` flag is used, it includes a `bucket` field, which categorizes
the `state` field into `pass`, `fail`, `pending`, `skipping`, or `cancel`."

A second, related trap the design does not mention: the same help says "Additional exit codes: **8:
Checks pending**". The supervisor loop must not treat a non-zero exit as a `gh` failure, or every
in-progress run reads as broken — design:478 currently maps any `gh` failure to "unknown, which is not
'done', so nothing advances", which would freeze the `ci` phase for the entire duration of any
pending check.

**Concrete fix.** `gh pr checks <pr> --json name,state,bucket`; aggregate on `bucket` (terminal =
no entry with `bucket == "pending"`; red = any `bucket == "fail"`). Treat exit code 8 as "pending",
not as an error. `gh pr view <pr> --json statusCheckRollup` is the alternative if a single call for
both merge state and CI is wanted.

---

## MAJOR 5 — `worktree.created` carries no pane id, so `root_pane_id` cannot be learned where the design says

**Claim.** design:240: "**How a task's fields are learned.** `branch` and `root_pane_id` come from the
`worktree.created` event".

**Problem.** The event has no pane field at all.

**Evidence (live capture from a linked probe plugin, herdr 0.9.0).** `HERDR_PLUGIN_EVENT_JSON` for
`worktree.created`:

```json
{"event":"worktree_created","data":{"type":"worktree_created",
 "workspace":{"workspace_id":"w5","number":5,"label":"feat-probe3","focused":false,
   "pane_count":1,"tab_count":1,"active_tab_id":"w5:t1","agent_status":"unknown",
   "worktree":{"repo_key":".../repo/.git","repo_name":"repo","repo_root":".../repo",
     "checkout_path":"/Volumes/stein/.herdr/worktrees/repo/feat-probe3","is_linked_worktree":true}},
 "worktree":{"path":".../feat-probe3","branch":"feat/probe3","is_bare":false,"is_detached":false,
   "is_prunable":false,"is_linked_worktree":true,"open_workspace_id":"w5","label":"repo"}}}
```

`branch` is there; no pane. The schema agrees: `EventData` variant `worktree_created` requires only
`type`, `workspace`, `worktree`, and `WorkspaceInfo` carries `pane_count`, not a pane list. `root_pane`
exists only on the **response** to `worktree.create` (`ResponseResult::WorktreeCreated`) — which is
exactly what `CLAUDE.md:69` reads (`.result.root_pane.pane_id`). The design conflated the CLI result
with the event payload.

Note that `WorkspaceInfo.worktree` does carry `repo_key`, `repo_name`, `repo_root`, `checkout_path`,
`is_linked_worktree` — the fact row at design:76 is correct, and provenance resolution works
(verified: the parent repo workspace `w2` gained `"is_linked_worktree": false` with the same
`repo_key` once a worktree existed).

**Concrete fix.** Mostly moot once the reaper is deleted (BLOCKER 3). Where a root pane id is still
wanted, take it from the `pane.created` event, which fires for the same workspace at effectively the
same moment (verified live: `pane.created` for `w5:p1` at `…741.889827`, `worktree.created` at
`…741.890152`, two independent processes with no ordering guarantee), or query
`$HERDR_BIN_PATH pane list` at adoption time.

---

## MAJOR 6 — Orchestrator resolution step 3 resolves to the *worker's* pane, not the human's

**Claim.** design:258, third and last resolution rule: "**Focused pane** from
`HERDR_PLUGIN_CONTEXT_JSON` at event time."

**Problem.** In an event hook, the context's `focused_pane_id` is the pane of the *event's* workspace,
not the session's focused pane. The last-resort fallback would therefore register/route the pipeline
digest to a worker agent.

**Evidence (live).** During a `worktree.created` hook, the session's actual focused pane was `w1:p1`:

```
$ herdr --session probetest pane list   # filtered
FOCUSED: w1:p1 w1
```

while the same hook's `HERDR_PLUGIN_CONTEXT_JSON` read:

```json
{"workspace_id":"w5","workspace_label":"feat-probe3", ...,
 "focused_pane_id":"w5:p1","focused_pane_cwd":"/Volumes/stein/.herdr/worktrees/repo/feat-probe3",
 "focused_pane_status":"unknown","invocation_source":"api","correlation_id":"worktree.created"}
```

`w5:p1` is the newly created worktree's own pane, and its `PaneInfo.focused` was `false`.

**Concrete fix.** Delete resolution step 3. Fall through from provenance straight to "queued
parentless" (design:260-262 already describes that state and it works). A digest that waits is
strictly better than one delivered into a worker's context.

---

## MAJOR 7 — The CI supervisor may not exist when the `ci` phase needs it

**Claim.** design:281: the `ci` phase's Actor is the "CI supervisor pane". design:385: it is "opened
by the startup hook via `plugin.pane.open` **when any run has an open PR**".

**Problem.** Startup hooks run once, at server start (`plugins.mdx:242-244`, and design:80 states it).
The normal lifecycle is: server starts (no runs, no PRs → no pane) → human starts a run → workers open
PRs hours later → tasks enter `ci` → **the only actor for that phase does not exist**. Nothing opens
it on the transition into `execute`; the `ci-pane` action (design:174-177) is manual and is not
mentioned in any prompt, so neither the human nor the orchestrator is ever told to invoke it. Every
task stalls at `ci` on the first run of a session.

**Concrete fix.** Open the supervisor from the transition into `execute` (and idempotently — check
`herdr plugin pane` state first), not only from the startup hook. Have the pane exit when no run has
an open PR, and add a line to `prompts/dispatch.md` naming the `ci-pane` action as the manual
recovery.

---

## MAJOR 8 — A binary `CLEAR`/`BLOCKER` verdict discards the MAJOR rank the workflow gates on, and nothing fixes MINORs

**Claim.** design:305: "Accepted values are `CLEAR` and `BLOCKER`." design:275-277, 280, 285: the
machine advances on `CLEAR` and loops on anything else.

**Problem.** The requirement gates on a three-level rank, not two:

- `CLAUDE.md:28-30`: "When a review clears — **no hard blockers (no BLOCKER/MAJOR that reverses a
  decision, changes scope, or needs a judgment only the user can make)** — advance to the next step
  automatically."
- `CLAUDE.md:41-42`: "Rank **BLOCKER / MAJOR / MINOR**, each with claim → problem → evidence →
  concrete fix."
- `CLAUDE.md:26`: "**Fix MINOR/mechanical findings inline.**"

With a binary trailer, a review that finds three MAJORs but no BLOCKER either lies (`CLEAR`, and the
MAJORs are never acted on — the run advances and the review file is never read again) or over-blocks.
And there is no phase, prompt, or predicate in which MINOR findings get fixed: on `CLEAR` the machine
goes straight to the next phase (design:275), so `CLAUDE.md:26` is unimplemented.

**Concrete fix.** Keep the binary machine gate but define it correctly in the review prompt text:
"emit `VERDICT: BLOCKER` if there is **any BLOCKER or any MAJOR** finding; otherwise `VERDICT: CLEAR`."
Add one line to the `CLEAR` branch of every review prompt — "before reporting CLEAR, apply every MINOR
finding inline" — so the fix happens inside the review turn and the machine needs no extra phase.

---

## MAJOR 9 — `hpipe start` (and every flush) injects a prompt into an agent that is mid-turn; the design states the assumption only for the `blocked` case

**Claim.** design:77, a verified fact: "`herdr agent prompt <target> <text>` submits in one call and
rejects with `agent_blocked` if the target is already blocked, **before sending any input** | Safe
delivery primitive; a blocked orchestrator cannot be corrupted by a half-typed prompt." design:441:
`hpipe start "<title>"` "Open[s] a run in the current repo, claim[s] the calling pane as orchestrator,
**inject[s] `prompts/spec.md`**".

**Problem.** The `blocked` half is correct and verified. The `working` half — which is the common case
— is never addressed, and the design creates one guaranteed instance of it. `hpipe start` is run *by
the orchestrator, as a tool call, inside its own turn*, so the pane is `working` when the plugin calls
`agent prompt` on it. Every subsequent flush does the same whenever the orchestrator is mid-turn.

**Evidence.** `cli-reference.mdx:336`: "`agent prompt` honors live bracketed-paste mode and writes
text followed by delayed Enter as one ordered submission, **including while the agent is working**.
**Success without `--wait` acknowledges the writes, not the start of a turn.**" `agent-automation.mdx:72`
is blunter: "**It can prompt an agent that is already working.**"

So the plugin types a multi-hundred-line rendered prompt into Claude Code's composer and presses
Enter while a turn is in flight. Whether Claude Code queues that cleanly, interleaves it, or
truncates it is exactly the assumption this design rests on, and it is neither stated nor verified.
This review could not test it (it requires a live Claude Code pane under herdr) — but the design
should not ship asserting "Safe delivery primitive" on the strength of the `blocked` guard alone,
which protects a different case.

**Concrete fix.** State the assumption explicitly in §Event transport and verify it once, live, before
building. Reduce the exposure meanwhile: make `hpipe start` and `hpipe task` **print** the rendered
prompt on stdout for the calling agent to read as tool output (design:423 already does this for
`hpipe task`; make `hpipe start` consistent) and reserve `agent prompt` for panes that are not the
caller. For flushes into a `working` orchestrator, prefer holding the queue until the next `idle`
over injecting mid-turn — the queue is already the truth (design:342).

---

## MAJOR 10 — `pane.exited` carries no exit status, but the digest prints one

**Claim.** design:354, the coalesced message shape: `- feat/chat-t4-chat-meter (#210, w7) **exited
(status 1)**, no PR`.

**Problem.** The event has two fields and neither is a status.

**Evidence (live).** Sending `exit` to a pane's shell produced:

```json
{"event":"pane_exited","data":{"type":"pane_exited","pane_id":"w1:p1B","workspace_id":"w1"}}
```

Schema: `EventData` variant `pane_exited` has `properties: {pane_id, type, workspace_id}` and
`required: ["type","pane_id","workspace_id"]`.

Separately worth knowing: removing a worktree workspace emitted `worktree.removed` and **no**
`pane.exited` for the pane it destroyed — so the design's teardown re-entrancy discussion
(design:376-381) is correct to key on `worktree.removed`, but `pane.exited` is not a backstop for it.

**Concrete fix.** Drop `(status 1)` from the message template. If exit status matters for the
`failed` classification (design:279, design:480), find and cite an API that exposes it before relying
on it; this review found none.

---

## MAJOR 11 — No kill switch and no way to correct a mis-advanced run

**Claim.** §Failure modes (design:468-480) enumerates nine failures, all of them herdr's, `gh`'s, or
the human's.

**Problem.** The one failure not covered is "the plugin is wrong" — it advanced a phase it should not
have (which BLOCKERs 6 and 7 make likely), or it is injecting prompts into the orchestrator in a loop.
The design's recovery verbs are `hpipe abort <run_id>` (design:445, "Stop driving a run; leaves
worktrees and branches alone") and `hpipe forget <workspace_id>`. Neither stops the plugin, and
nothing puts a run back into a phase it left. The actual kill switch — `herdr plugin disable
stein.pipeline` — is never mentioned in the document, and there is no `hpipe resume`, so `abort` is a
one-way door: a human who aborts to stop the noise cannot restart the pipeline on the same run and
must drive the rest by hand with no ledger.

For a system whose stated purpose is to run autonomously across a six-agent fleet (design:29-33),
the escape hatch is a design requirement, not an operational detail.

**Concrete fix.** Add a §Recovery section: `herdr plugin disable stein.pipeline` is the stop-everything
switch (state that the ledger and queue survive it, and that `enable` + the startup hook replay
resumes). Add `hpipe set-phase <run_id> <phase> [--task <id>]` so a human can put a mis-advanced run
or task back, and make `hpipe abort` reversible with `hpipe resume <run_id>`.

---

## MAJOR 12 — `REPOS_ALLOW` cannot disambiguate two orchestrators on one repo

**Claim.** design:475: "Two orchestrators on one repo | `REPOS_ALLOW` plus explicit `claim`
disambiguate; provenance alone would pick one arbitrarily".

**Problem.** `REPOS_ALLOW` is a repo-key allowlist (design:465: "Repo-key allowlist"). It decides
*whether* a repo is driven at all; it has no way to express *which of two panes in that repo* is the
orchestrator. Only `claim` does anything in this row. As written the row reads as if there are two
independent defences when there is one.

**Concrete fix.** Rewrite the row: "Two orchestrators on one repo | explicit `claim` wins; provenance
is only used when no pane has claimed. A second `claim` overwrites the first and is logged."

---

## MINOR 1 — Fact row 4 is right for the wrong reason: `workspace.metadata_updated` is not a plugin event at all

**Claim.** design:74: "`workspace.metadata_updated` does **not** invoke plugin event hooks | The
plugin's own token writes cannot cause an event loop".

**Evidence.** Linking a manifest that declares it produces a validation warning, not a silently inert
hook:

```
$ herdr plugin link ./probe
... "warnings":["unknown event 'workspace.metadata_updated'"]
$ herdr plugin list
- test.probe (Probe) enabled [...; 1 warning(s)]
  warning: unknown event 'workspace.metadata_updated'
```

The valid plugin event names, extracted from the 0.9.0 binary, are the 26 dotted forms
`workspace.created, workspace.updated, workspace.metadata_updated, workspace.closed,
workspace.renamed, workspace.moved, workspace.reordered, workspace.focused, worktree.created,
worktree.opened, worktree.removed, tab.*, pane.created, pane.closed, pane.updated, pane.focused,
pane.moved, pane.output_changed, pane.exited, pane.agent_detected, pane.agent_status_changed,
layout.updated` — but the *linker* rejects `workspace.metadata_updated` specifically, so the enum and
the accepted set differ. **The design's five event names all linked with no warning**, so fact row 1
(design:71) is confirmed correct.

**Concrete fix.** Restate the row as "`workspace.metadata_updated` is not an accepted plugin event
name (link warns `unknown event`), so badge writes cannot loop" — and note that this is a
version-fragile detail worth re-checking on upgrade, since the name *is* in the binary's event enum.

---

## MINOR 2 — The `hpipe` symlink will not execute, and it breaks on reinstall

**Claim.** design:436-437: "The startup hook idempotently symlinks `src/cli.ts` to
`~/.local/bin/hpipe` (`HPIPE_LINK_PATH`, skippable with `HPIPE_LINK=0`)."

**Evidence.**

```
$ ln -sf ./cli.ts ./hpipe && ./hpipe x
permission denied: .../hpipe

$ printf '#!/usr/bin/env bun\n...' > cli2.ts && chmod +x cli2.ts && ln -sf ./cli2.ts ./hpipe2
$ ./hpipe2 x
hi [ "x" ]
```

A symlink to a `.ts` file runs only if the target carries `#!/usr/bin/env bun` and mode `+x`; the
design says neither. Two further problems: `plugins.mdx:263-265` warns that `HERDR_PLUGIN_ROOT` is a
managed source checkout for GitHub installs and reinstall replaces it, so the symlink breaks on
`plugin install`; and nothing removes `~/.local/bin/hpipe` on `plugin unlink`, leaving a dangling
binary on the user's `PATH`.

(Bun startup itself is a non-issue: three `bun run` invocations of a trivial `.ts` totalled 37 ms
wall, so the per-hook interpreter cost is negligible.)

**Concrete fix.** Ship `bin/hpipe` as a two-line POSIX wrapper (`#!/bin/sh` /
`exec bun "$(dirname "$0")/../src/cli.ts" "$@"`), committed with mode `755`, and symlink that. Or drop
the auto-symlink entirely and have the startup hook print the one-line command once — writing to
`~/.local/bin` from a plugin's startup hook is a surprising side effect for something the user
installed to watch panes.

---

## MINOR 3 — The test plan's fakes cannot intercept the code under test

**Claim.** design:484: "`bun:test`, with a fake `herdr` and a fake `gh` **earlier on `PATH`** than the
real ones".

**Problem.** design:100 specifies `lib/herdr.ts` as "typed **`$HERDR_BIN_PATH`** wrapper". A
`PATH`-order fake never sees those calls, because the wrapper resolves an absolute path from the
environment. The `gh` half works; the `herdr` half does not.

**Concrete fix.** Fake by setting `HERDR_BIN_PATH` to the stub in the test harness (and, since the
same problem will recur, have `lib/gh.ts` read an overridable `GH_BIN_PATH` too).

---

## MINOR 4 — `pane.agent_detected` also fires on agent *release*

**Evidence.** Schema, `EventData` variant `pane_agent_detected`:

```json
{"properties":{"agent":{...},"final_status":{...},"pane_id":{...},"released":{"type":"boolean"},
  "type":{"const":"pane_agent_detected"},"workspace_id":{...}},
 "required":["type","pane_id","workspace_id"]}
```

`released` and `final_status` mean the same hook fires when an agent *leaves* a pane. design:240
("`pane_id` from `pane.agent_detected`") and design:365-372 (the reaper's "it has no agent" guard)
both key on this hook and neither mentions the release case: a release event for the *agent's own*
pane presents a pane with no agent, which is one of the reaper's five conditions.

**Concrete fix.** Ignore events with `released == true` in `src/hooks/agent-detected.ts` (or, if the
reaper is deleted per BLOCKER 3, use the release case to mark the task `failed` instead).

---

## MINOR 5 — Task `status` and task `phase` overlap and the failure column does not say which it writes

design:222-223 gives a task both `"status": "working"` and `"phase": "execute"`. The phase table's
On-failure column writes `failed` (design:279), `orphaned` (design:284) and `done` (design:284)
without saying which field receives them, and design:324 dedups "against the task's stored `status`",
which is also where the herdr agent status lives. Three meanings in two fields.

**Fix.** Keep `agent_status` (mirror of herdr's), `phase` (position in the task machine), and make
`failed`/`orphaned`/`done` terminal *phases*. Drop `status`.

---

## MINOR 6 — `run_id` collides

design:205: `"run_id": "nicaraguan-laws-20260913-chat-meter"`. Two runs of the same title on the same
day, or an `hpipe abort` followed by a retry of the same title, produce the same id — and design:236
("One active run per repo") only guards the *active* case, so the second run would overwrite the
aborted one's `runs/<run_id>.json`. **Fix:** append four random base36 characters.

---

## MINOR 7 — The mandatory "issue per task" step is made optional

`CLAUDE.md:67` makes "**Get tasks → open a GitHub issue per task** (`gh issue create`)" step 1 of the
dispatch loop, and `CLAUDE.md:84-86` requires verifying the PR's closing keyword actually closed it.
design:243 instead: "`issue` stays `null` until one of those resolves, and **the `close` phase is
skipped for a task that never had one**." A worker whose PR body used "Implements #N" — the exact
footgun `CLAUDE.md:78` and design:425 both call out — leaves `issue` null and gets the `close` phase
skipped silently, which is the failure the rule exists to prevent.

**Fix.** Make `--issue` required on `hpipe task`, and make a task that reaches `merge` with
`issue == null` an escalation rather than a skip.

---

## MINOR 8 — Teardown is unconditional; the requirement allows keeping the branch

`CLAUDE.md:88-89`: "**Teardown:** `herdr worktree remove --workspace <ws> --force` … **Skip only if a
follow-up still needs the branch.**" design:284 makes teardown an unattended plugin action with no
opt-out. **Fix:** add `hpipe task --keep-worktree`, and have the `teardown` phase skip to `done`
when it is set.

---

## MINOR 9 — The `min_herdr_version` justification is an argument from ignorance and names the wrong reasons

design:186-188: "`min_herdr_version = "0.9.0"` because the design depends on `agent.prompt`'s pre-send
`agent_blocked` rejection and on `plugin.pane.open`'s `env` map, **neither of which is verified on
earlier releases**." "Not verified on earlier releases" is not evidence that they are absent, and
neither is what actually pins the version: `agent start --pane` (BLOCKER 3) and the dotted plugin
event names are. **Fix:** "0.9.0 is the version every fact in this table was verified against" is
both honest and sufficient.

---

## MINOR 10 — v1 delivers neither of the two headline benefits it opens with

design:19-22 states costs #1 and #2 as "The pipeline is re-taught every session" and "It is duplicated
per repo". design:501-504 then defers "Trimming the now-redundant workflow prose from
`nicaraguan-laws/CLAUDE.md` — a separate change to a separate repo, made only once this plugin has
earned it in practice." That is a defensible sequencing call, but as written v1 *adds* a second copy
of the workflow while leaving the first in place, so the context cost goes up, not down, until the
follow-up lands.

**Fix.** Say so in §Non-goals ("v1 does not reduce `CLAUDE.md` context; that lands after the plugin
has run a real pipeline"), so the trade is explicit rather than read as an accidental omission.

---

## Open questions (could not verify; not ranked as findings)

1. **Does `agent prompt` into a `working` Claude Code pane queue cleanly?** MAJOR 9 establishes that
   herdr will send it; what Claude Code does with mid-turn input needs a live pane under herdr to
   test. This is the single highest-value thing to check before building.
2. **Is the 32-command cap per plugin or global?** Only one plugin was linked during the probe. If it
   is global, a second installed plugin makes MAJOR 1 worse.
3. **Does `herdr plugin action invoke stein.pipeline.claim`, run from a pane's shell, carry that
   pane?** `PluginInvocationContext` (request schema) has `focused_pane_id`, not `pane_id`, and
   `plugins.mdx:257` says commands receive "**any available** `HERDR_PANE_ID`". Whether the CLI
   populates it from the calling shell's environment could not be tested without a TUI client.
   (`hpipe start`'s implicit claim is fine either way — the plugin's own CLI reads its own env.)
4. **Do workspace/pane tokens survive a server restart?** (fact row, design:75.) `session-state.mdx:31`
   lists what snapshot restore preserves — "workspaces, tabs, panes, cwd, layout, and focus" — and
   does not mention tokens; `session-state.mdx:97` says a live *handoff* preserves "agent identity and
   durable metadata". Untested. The design's behaviour (reapply from the startup hook) is safe either
   way, so this is informational.
5. **Does `agent prompt` reject a pane with no agent, or a pane whose agent is `unknown`?** The
   delivery-failure row (design:474) only covers `agent_blocked` and "a missing pane".

---

## Verdict

Seven BLOCKER-ranked findings. Three are internal contradictions that stop the design from working at
all as written — the orchestrator is excluded from the only event path that could complete its own
phases (B1), nothing in the architecture can tick, so the stall probe and the retry backoff cannot
exist (B2), and every failure branch re-enters a phase whose predicate is already satisfied (B7).
Two are false premises: `herdr agent start` no longer opens a pane, which deletes a whole subsystem
and makes the dispatch prompt teach a failing command (B3); and Claude Code's status is screen-scraped
with a documented `idle` fallback, which falsifies the "stalling, never derailing" invariant the
autonomy argument rests on (B6). Two are requirements the design drops without saying so: task
ordering and the collision rule (B4), and the two-stage per-task review plus surface-agent routing
(B5).

The bones are good — the "plugin owns the prompt text so it dictates where the answer goes" idea
(design:291-306) is the right insight, the ledger-as-truth/prompt-as-doorbell split is right, and
`hpipe task` printing the rendered worker prompt is a clean way to keep the contract in the package.
But the state machine needs an explicit liveness owner, the predicates need to be edges rather than
levels, and the facts table needs re-deriving from 0.9.0 rather than from `CLAUDE.md`'s prose.

The event-transport design in particular should be revisited whole rather than patched: with a hard
cap of 32 concurrent plugin commands, a design that deliberately parks a hook in `sleep 2000` and adds
a retry-with-backoff loop in the same process is spending the scarcest resource in the system on the
thing a supervisor pane already exists to do.

VERDICT: BLOCKER
