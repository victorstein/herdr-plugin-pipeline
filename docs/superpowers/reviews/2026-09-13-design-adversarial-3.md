# Adversarial review — herdr-plugin-pipeline design v3

**Target:** `docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md` (584 lines)
**Round 1:** `reviews/2026-09-13-design-adversarial-1.md` (VERDICT: BLOCKER, 7/12/10)
**Round 2:** `reviews/2026-09-13-design-adversarial-2.md` (VERDICT: BLOCKER, 5/8/8 + audit of round 1)
**Date:** 2026-09-13

**Method.** Round 2's audit identified one failure pattern — *the author fixes an instance, not the
class* — so this round hunted that pattern first. Every round-2 finding was classified against v3.
Then v3's new material was probed **live**: a throwaway plugin (`test.pipe3`) declaring a
`[[startup]]` hook, a `pane.created` `[[events]]` hook, a global `[[actions]]` entry and a
`[[panes]]` entrypoint wrapping a long-running child, linked into a throwaway session
(`--session pipe3`) and driven through a **cold start**, a **warm restart with a snapshot**, a ghost
reap, and a pane-process inspection. A second, action-only probe (`test.p3b`) was invoked against the
**default** session to capture the env of a plugin process there. Every `gh` field name and every
`herdr` verb in v3 was re-executed against `gh 2.96.0` / `herdr 0.9.0`. Queue-name ordering and the
`exec $SHELL` fallback were measured with runnable scripts.

**Environment restored.** Both probes unlinked (`herdr plugin list` → "No plugins installed"), the
`pipe3` session stopped and its directory deleted, both probe state/config dirs removed, no stray
processes. The user's `default` and `personal` servers were never stopped, never had a pane created
in them, and are still running. The only thing executed against `default` was one global action
invocation that dumped three environment variables to the scratchpad.

Design citations are `design:<line>`. Requirements are
`/Volumes/stein/Documents/development/personal/nicaraguan-laws/CLAUDE.md`, cited `CLAUDE.md:<line>`.

---

## Summary

v3 is a substantially better document than v2. The four claims v2 was caught asserting falsely are
withdrawn and replaced with mechanisms that **actually work when probed** — the startup reconcile in
particular, which I expected to fail and which passes cleanly on both a cold and a warm start. The
class-pattern sweep found the run/task asymmetry genuinely closed in the state shape (task
`phase_entered_at`, `head_sha_at_entry`, `pass`, per-task-per-pass verdict keys).

But the pattern is not extinct; it moved. v3 states three **universal** rules ("every orchestrator-owned
predicate…", "every predicate compares against `phase_entered_at`", "`MAX_PASSES` … before escalating")
and each is contradicted by rows of its own table. And v3's single biggest new dependency —
`HERDR_SESSION` — is **absent in the default session**, which is the session the user actually works
in. That is a fact the document asserts as verified.

No finding here is a BLOCKER. Every one is a local correction, and several are one line.

---

## MAJOR 1 — `HERDR_SESSION` is unset in the default session. Every session-scoped path in v3 degrades to an empty key, and the design asserts the opposite as a verified fact.

**Claim.** design:143-144: "`hpipe` stamps `HERDR_SESSION` on every write — **verified present in pane
shells** alongside `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`." design:160 promotes it into the
verified-facts table: "pane shells carry `HERDR_SESSION`". The whole of §Sessions keys on it:
`runs/<session>/` (design:139), `orchestrators.json` keyed `<session>/<repo_key>` (design:140),
`supervisor.<session>.pid` (design:141, 257), "the supervisor skips any run whose `session` is not
its own" (design:142).

**Problem.** `HERDR_SESSION` is injected **only for named sessions**. In the default (unnamed)
session it does not exist. Round 2 verified its presence in session `envprobe` — a *named* session —
and the verification was generalised to all sessions without re-testing the unnamed one.

**Evidence.** A global action invoked against the running **default** session (probe `test.p3b`,
`contexts = ["global"]`, dumping its own environment):

```
===== CTX=action-default-session pid=36820 at=1789358735
HERDR_SESSION=[<UNSET>]
HERDR_SOCKET_PATH=[/Volumes/stein/.config/herdr/herdr.sock]
SHELL=[/bin/zsh]
```

Compare the same probe's startup hook in the **named** session `pipe3`:

```
===== CTX=startup pid=33072 ppid=33043
HERDR_SESSION=pipe3
HERDR_SOCKET_PATH=/Volumes/stein/.config/herdr/sessions/pipe3/herdr.sock
```

So in the default session the design's paths become `runs//<run_id>.json`, `supervisor..pid`, and an
`orchestrators.json` key of `/<repo_key>`. They do not *collide* with a named session's keys (empty
is still distinct from `personal`), so this degrades rather than mis-delivers — but it is malformed,
it is invisible until someone reads the state directory, and any implementation that does
`mkdir -p "runs/$HERDR_SESSION"` under `set -u`, or `path.join(base, session)` in TypeScript with
`session === undefined`, fails outright.

Note also that `plugins.mdx:254-261` enumerates the injected variables and **does not list
`HERDR_SESSION` at all** — it is present in plugin processes (verified above for startup, event and
pane contexts in a named session) but undocumented, so it is not a variable to build on without a
fallback.

**Concrete fix.** Define one helper and use it at every write site:

```
sessionKey() = HERDR_SESSION (if set and non-empty)
             | <name> parsed from HERDR_SOCKET_PATH matching …/sessions/<name>/herdr.sock
             | "default"
```

`HERDR_SOCKET_PATH` is present in every context measured, including the default session, and encodes
the session unambiguously. Add a verified-facts row: "`HERDR_SESSION` is injected into plugin
processes for **named sessions only**; it is unset in the default session. Derive the session key
from `HERDR_SOCKET_PATH`." Correct design:143-144 and design:160, which currently state the
unqualified claim.

---

## MAJOR 2 — One `pid` field is asked to identify two different processes, and the API that would supply either is never named. `pane list` and `pane get` expose no pid at all.

**Claim.** design:123: reconcile step 2 — "close every pane labelled as the supervisor **whose pid is
not the live one in `supervisor.<session>.pid`**." design:257: the pid file is
`{ pid, started_at_ms, boot_id, session, socket_path, pane_id }`. design:545: "Liveness requires pid
**and** process start time **and** session to match."

**Problem.** Two distinct processes, one field.

The manifest command (design:100, design:246) is
`sh -c 'bun run src/supervisor/main.ts; echo …; exec $SHELL'`. The pane's process is the **`sh`
wrapper**; the supervisor is its **child**. Liveness wants the child's pid (when the supervisor dies
the wrapper survives — that is the entire point of the wrapper). Pane identity wants the wrapper's
pid (it is what herdr reports for the pane). One `pid` field cannot be both, and the design uses it
for both.

Separately, **the design never names an API that returns a pane's pid**, and the two obvious
candidates do not have one.

**Evidence.** `pane get` and `pane list` carry no pid field:

```
$ herdr pane get wK:p1
{"result":{"pane":{"agent_status":"unknown","cwd":"…","focused":false,"foreground_cwd":"…",
"pane_id":"wK:p1","revision":1,"scroll":{…},"tab_id":"wK:t1","terminal_id":"term_65b6914918b721",
"terminal_title":"…","workspace_id":"wK"}}}
```

The pid is available, but only from a third verb the design does not mention, one call per pane:

```
$ herdr pane process-info --pane w1:p2       # live supervisor pane, probe session
{"result":{"process_info":{"foreground_process_group_id":33758,"foreground_processes":[
  {"argv":["sleep","400"],                              …"pid":33782},
  {"argv":["/bin/sh",".../longrun.sh"],                 …"pid":33781},
  {"argv":["sh","-c","…; exec $SHELL"],                 …"pid":33758}],
"pane_id":"w1:p2","shell_pid":33758}}}
```

`shell_pid` is **33758** (the wrapper). The "supervisor" process is **33781**. They differ, and the
supervisor's own `getpid()` returns 33781 — so a supervisor that writes its own pid produces a file
that reconcile step 2 can never match against `shell_pid`.

The destructive reading does not actually fire today, and this is why the finding is MAJOR and not
BLOCKER: startup hooks run once per server start, and a server start has already killed the previous
supervisor, so there is never a live supervisor when reconcile runs. The mismatch is therefore
harmless *at startup* and simply closes everything labelled as the supervisor — which is the correct
outcome. It bites on the other two paths: the `supervisor` **action** (design:237-240) reopening while
one is live, and `hpipe status` (design:498) distinguishing live / stale-pid / other-session / none.

**Concrete fix.** Two fields, one sentence, one named API:
- Record `pid` (the supervisor process, for liveness) **and** `pane_pid` (the wrapper — the supervisor
  reads it as its own `PPID` at startup, for pane identity).
- design:123 becomes "…whose `shell_pid` from `herdr pane process-info --pane <id>` is not the
  `pane_pid` in `supervisor.<session>.pid`."
- Add a verified-facts row: "`pane list`/`pane get` carry **no** pid; `pane process-info --pane <id>`
  returns `shell_pid` and `foreground_processes[].pid`, one call per pane."

---

## MAJOR 3 — `exec $SHELL` is a silent no-op when `SHELL` is unset, and the pane vanishes — the exact failure the wrapper exists to prevent.

**Claim.** design:99-100: "The manifest command wraps the process **so a death leaves a readable pane
rather than none**: `sh -c 'bun run src/supervisor/main.ts; echo "[pipeline] supervisor exited — run
hpipe status"; exec $SHELL'`." design:544: "Supervisor dies | Wrapped command leaves a readable pane".

**Problem.** `SHELL` is not injected by herdr. It reached the probe by inheritance from the shell that
launched `herdr server`. A server started from launchd, a systemd unit, a `machine add` background
start, or any non-login context has no `SHELL`, and `exec $SHELL` then expands to bare `exec`, which
is a no-op — the shell falls off the end of the script and exits, destroying the pane.

**Evidence.** Measured on this machine:

```
$ env -u SHELL sh -c 'echo before; exec $SHELL; echo AFTER-EXEC-RETURNED'
before
rc=0
```

No replacement shell, no `AFTER-EXEC-RETURNED`, `sh` exits — the pane would be destroyed, silently,
at exactly the moment the design promises a readable corpse. With `SHELL` set it behaves as designed:

```
$ SHELL=/bin/zsh sh -c 'echo before; exec $SHELL -c "echo I-AM-REPLACEMENT"'
before
I-AM-REPLACEMENT
```

For the record, `SHELL=/bin/zsh` **was** present in all three probed plugin contexts (startup hook,
event hook, pane command) because the probe server was launched from an interactive shell. That is
the lucky case, not a guarantee.

**Concrete fix.** `exec "${SHELL:-/bin/sh}"` in design:100 and design:246. One token.

---

## MAJOR 4 — `MAX_PASSES` and `escalated` have no task-level twin. A task that keeps failing review loops `execute ↔ task-review-*` forever. This is round 2's BLOCKER 3 fixed as a data shape and not as a rule.

**Claim.** design:300-304: "**Tasks carry their own `phase_entered_at`, `head_sha_at_entry`, and
`pass`.**" design:527: `MAX_PASSES` = 2, "Review passes before escalating". design:434: "`escalated`
is a real phase, recording `escalated_from`."

**Problem.** The field was added; the rule that consumes it was not.

- design:349-350, the two task review rows, both end "else task `execute`, `pass`+1" — **with no
  cap**. Nothing in the document says what happens when a *task's* `pass` exceeds `MAX_PASSES`.
- `escalated_from` exists on the **run** record (design:278) and **not** on the task record
  (design:285-295).
- design:434's `escalated` sentence is written entirely in run terms, and the phase table has no
  `escalated` row at either level (see MINOR 4).

So `task-review-spec` finds a BLOCKER on pass 7 and the task goes back to `execute` for the seventh
time. The run cannot finish: `teardown`'s "last → run `branch-review`" (design:354) never fires while
one task is still cycling. Round 2's BLOCKER 3 fix asked for exactly this: "Add `pass` to the task
record too; **`MAX_PASSES` is currently run-scoped and has no meaning for a task** that loops
`execute ↔ task-review-*`." v3 took the first clause and left the second.

**Concrete fix.** Mirror the run rule at the task level, in the same two places the run rule lives:
add `escalated_from` to the task record; add to design:349-350 "…`pass`+1; **at `MAX_PASSES`, task →
`escalated`, surfaced to the orchestrator, and the run continues with the remaining tasks**"; and make
design:434 read "at both levels". `hpipe rewind --task <id>` already resets `pass` (design:500), so
the exit path exists.

---

## MAJOR 5 — "Every orchestrator-owned predicate is actor-idle **and** artifact-fresh" is false for 3 of the 10 orchestrator-owned rows; "every predicate compares against `phase_entered_at`" is false for 5 of 14.

**Claim.** design:335-336: "Fourteen rows; **ten are orchestrator-owned**. **Every** orchestrator-owned
predicate is `actor pane idle|done` **and** `artifact fresh`." design:389-391: "**Every** predicate
compares against the **relevant record's** `phase_entered_at`."

**Problem.** The arithmetic is now right — I recounted, and the table is 14 rows with 10
orchestrator-owned, so round 2's "seven of the twelve" is genuinely fixed. The *universals* are not.

Orchestrator-owned rows with **no** actor-idle and **no** artifact:

- design:346 `dispatch`: "≥1 task registered **and** ≥1 worktree adopted"
- design:352 `merge`: "`gh pr view --json state` is `MERGED`"
- design:353 `close`: "`gh issue view --json closed` is true"

Rows not covered by any of the three edge rules at design:394-400 (file / PR `headRefOid` / CI bucket
change): `dispatch`, `queued`, `merge`, `close`, `teardown`. `merge` and `close` are **pure level
predicates** — once a PR is `MERGED` it is `MERGED` forever. `hpipe rewind <run> merge --task t1`
(design:500, offered in the recovery table as the escape for an early advance) therefore re-advances
on the very next tick, because `state == "MERGED"` is still true. The escape hatch for rows 11 and 12
does not work on rows 11 and 12.

This is the round-2 class exactly: a rule asserted at the level of the table, true of the rows the
author was thinking about, false of the rows they were not.

**Concrete fix.** Both halves are one line each, and the fields are already verified to exist:
- Qualify design:335-336: "Every orchestrator-owned predicate whose completion signal is an
  **artifact** is `actor idle|done` and `artifact fresh`; `dispatch`, `merge` and `close` complete on
  external state and are gated at delivery only."
- Add a fourth bullet at design:394-400: "**GitHub state** — `mergedAt` / `closedAt` must postdate
  `phase_entered_at`." Verified present: `gh pr view --json` offers `mergedAt` and `closedAt`, and
  `gh issue view --json` offers `closedAt` (both re-executed against gh 2.96.0).

---

## MAJOR 6 — The supervisor renders "one coalesced message per orchestrator" containing "the rendered prompt for **the phase just entered**" (singular), but v3 made ten task rows orchestrator-owned and idle-gated, so several tasks enter different phases in the same tick.

**Claim.** design:452-453: the supervisor "…evaluates predicates, and renders **one coalesced message
per orchestrator** from `prompts/digest.md`". design:464, inside the digest template:
`<rendered prompt for the phase just entered>` — singular. The example above it (design:456-462)
lists three tasks.

**Problem.** Every orchestrator-owned task row now gates on the same single orchestrator pane reading
`idle`/`done` (design:335-336, design:359-362). That means task phases do not advance one at a time —
they advance in a batch, at the first idle window after several artifacts land. With three tasks
entering `task-review-spec`, `task-review-quality` and `merge` on the same tick, the digest has one
slot and three prompts, and the document does not say which one wins or whether they concatenate.

v2 did not have this problem because its task rows carried no idle gate, so they advanced
independently as their files landed. The gate is the right fix (round 2's BLOCKER 4); it just
multiplied a delivery template that was written for one run-level phase at a time.

**Concrete fix.** Either (a) the digest carries an ordered **list** of rendered prompt blocks, one per
phase entered this tick, with a stated cap; or (b) the supervisor advances **at most one
orchestrator-owned phase per orchestrator per tick**, leaving the rest for the next tick. Say which,
in §Event transport, and make design:464 plural if (a).

---

## MAJOR 7 — The queue has no defined processing order. Same-millisecond events are unordered, the pid segment sorts lexicographically, and the design specifies no sort at all.

**Claim.** design:83: "drain queue → **glob `queue/*.json`**, read, unlink; dedup; update tasks".
design:260-262: "the supervisor globs `queue/*.json`, reads, and unlinks each processed file."
design:257: names are `<ts>-<pid>-<rand>.json`.

**Problem.** `glob` returns readdir order, which is not emission order, and the filename is not a
usable sequence key either: the timestamp collides at millisecond resolution under exactly the load
this design creates, and the `<pid>` tiebreak sorts as a string.

**Evidence.** Eight events written in a known order into one directory, then read back:

```
EMISSION ORDER:              READDIR ORDER:               LEXICOGRAPHIC:
 …708-88888-9de8d6.json       …708-10-174d08.json          …708-10-137cbe.json
 …708-10-174d08.json          …708-9-6fa64b.json           …708-10-174d08.json
 …708-10-1b8e11.json          …708-9-b1b3e2.json           …708-10-1b8e11.json
 …708-1234-67cacc.json        …708-10-1b8e11.json          …708-1234-67cacc.json
 …708-10-137cbe.json          …708-1234-991337.json        …708-1234-991337.json
 …708-9-6fa64b.json           …708-10-137cbe.json          …708-88888-9de8d6.json
 …708-1234-991337.json        …708-88888-9de8d6.json       …708-9-6fa64b.json
 …708-9-b1b3e2.json           …708-1234-67cacc.json        …708-9-b1b3e2.json
```

All eight landed in the same millisecond (`…708`), so the timestamp orders nothing; readdir order
matches neither; and lexicographically pid `9` sorts *after* `88888`. Eight simultaneous events is
not a stress case for this design — design:77 measures 40 concurrent hook invocations completing in
279 ms, and a six-worktree teardown sweep emits its `worktree.removed` events together.

It matters because ordering is semantic here. A worker that goes `working → idle → working` inside one
tick writes two `agent_status` events; processed in the wrong order the task record keeps
`agent_status: "working"` when the worker is idle (a missed `execute` trigger, design:348) or `"idle"`
when it is working. The delivery-time re-read (design:359-362) protects the **actor**, not the task
record, and `TASK_STALL_MINUTES` (design:446, "no `agent_status` change") reads that same corrupted
field.

**Concrete fix.** Make the name sortable and say so: `<ts>-<seq>-<pid>.json` with `ts`
zero-padded-fixed-width epoch-ms and `seq` a zero-padded per-process monotonic counter, and state in
§State that the supervisor **sorts the glob lexicographically before processing** and that this is
emission order within a process and best-effort across processes. If ordering genuinely does not
matter, say that instead and name the two fields (`agent_status`, `pr`) that are last-write-wins.

---

## MAJOR 8 — A task whose dependency `failed` waits in `queued` forever. Round 2 asked for a deadlock detector and got a cycle check, which is a different thing.

**Claim.** design:347, `queued`: "`depends_on` all **`done`**, no in-flight `files` overlap | …
| cycle → rejected at registration". design:552, failure modes: "`queued` deadlock | Cycles rejected at
registration; **an unsatisfiable gate is reported by `status`**".

**Problem.** Cycles are one way to deadlock and not the common one. The common one is a dependency
that never reaches `done`:

- design:348, `execute` failure: "pane exited or agent released → task **`failed`**".
- design:354, `teardown` failure: "removal fails → task **`orphaned`**".

Neither `failed` nor `orphaned` is `done`, so every dependent task sits in `queued` permanently. The
run cannot finish either — design:354's "last → run `branch-review`" requires all tasks `done`. The
stall rules do not reach it: design:439-441 fires only for **file** phases and `queued` is not one,
and design:446's `TASK_STALL_MINUTES` covers `execute` only. So a single worker crash wedges the run
silently and forever, and the only thing that notices is `hpipe status` — which is a command the human
has to think to run, i.e. exactly the "failures are silent" problem design:35 exists to fix.

Round 2's MAJOR 5 fix #2 asked for two things: "Reject a `--depends-on` graph containing a cycle at
registration time … **and add a `queued` deadlock row to the failure table**." The cycle half was
implemented; the deadlock half became a `status` mention.

**Concrete fix.** One predicate and one prompt: when any task in `depends_on` is `failed` or
`orphaned`, the dependent leaves `queued` for a terminal `blocked-on-failure` state and the supervisor
surfaces it to the orchestrator through the digest, the same way design:555-556 surfaces the failure
itself. Update the design:552 row to name it.

---

## MAJOR 9 — `hpipe task` now withholds the worker prompt and the supervisor delivers it "when the task leaves `queued`" — but nothing says the worker pane exists by then, and v2's wording (prompt the *orchestrator* to dispatch) was the version that closed the loop.

**Claim.** design:369-370: "**`hpipe task` withholds the rendered worker prompt until the gate opens**
— it prints `task_id: t1` and `queued: waiting on t0`, and **the supervisor delivers the prompt when
the task leaves `queued`**." design:347, the `queued` success cell: "task `execute`; **supervisor
delivers the worker prompt**".

**Problem.** Delivery needs a target. design:311-312 sources the task's `pane_id` from
`pane.agent_detected` — which fires only after the orchestrator has created the worktree and run
`agent start`. Nothing in v3 says when that happens for a task that is still `queued`. Two readings,
both left open:

- The orchestrator creates a worktree and starts an agent for **every** registered task at `dispatch`,
  including gated ones — then six Claude agents sit idle in worktrees waiting for prompts, which works
  but is never stated, and `dispatch`'s predicate ("≥1 worktree adopted", design:346) explicitly does
  not require all of them.
- The orchestrator creates worktrees only for unblocked tasks — then a task leaving `queued` has
  `pane_id: null` and the supervisor has nowhere to deliver, so the task never starts.

v2's table said "**prompt orchestrator to dispatch it**", which was unambiguous and closed the loop.
v3 changed the recipient while fixing the *withholding* defect (round 2's MAJOR 5.1) and did not
re-check that the new recipient exists at that moment.

**Concrete fix.** Keep the withholding and restore v2's recipient: the `queued` success cell becomes
"task `execute`; **supervisor prompts the orchestrator to dispatch it, carrying the rendered worker
prompt**". That preserves the property round 2 asked for (the gate is binding because the text is
withheld until it opens) and keeps delivery aimed at a pane that is known to exist.

---

## MAJOR 10 — The `--remote` refusal tests a condition that cannot occur. `hpipe` cannot tell a remote socket path from a local one, and a `--remote` pane's `hpipe` runs on the remote host anyway.

**Claim.** design:547, failure modes: "`--remote` | The server, plugin and pid file live on the remote
host while `hpipe` runs locally; the pid is remote and local liveness is meaningless. **Unsupported —
`hpipe` refuses when `HERDR_SOCKET_PATH` is not local**". design:53-54 leans on this row to scope
`--remote` out of the non-goals.

**Problem.** Two things are wrong.

First, the check is undecidable. `HERDR_SOCKET_PATH` is an absolute filesystem path
(`/Volumes/stein/.config/herdr/herdr.sock`, measured). A remote server's socket path is also an
absolute filesystem path, on the remote host, and may be byte-identical if the layout matches. There
is no substring, prefix, or `stat()` that distinguishes them from inside the process.

Second, the scenario it guards against does not arise. `cli-reference.mdx:69`: "Workspace, tab, pane
IDs, and agent names belong to a single server. **Selecting a machine in the UI does not change the
session or socket inherited by commands running in an existing pane.** For remote automation, run the
CLI on the intended host against the intended session and discover its IDs there." With
`herdr --remote workbox` the *client* is local and the server, its panes, its plugin processes and
therefore `hpipe` all execute on the remote host — where the socket genuinely is local and the pid
genuinely is checkable. The design describes "`hpipe` runs locally" against a remote socket, which is
not a configuration herdr produces.

**Concrete fix.** Replace the enforcement claim with the fact, in the same row: "`--remote` puts the
server, the plugin, the supervisor and `hpipe` all on the remote host, so a remote session is
internally consistent and needs no special handling. What is **not** supported is driving a remote
session's runs from a local shell — ids and pids belong to one server (`cli-reference.mdx:69`). No
check is possible or needed." If the user wants a real guard, the only implementable one is comparing
`HERDR_SOCKET_PATH`'s existence on the local filesystem — say so explicitly rather than "is not
local".

---

## MINOR 1 — `SETTLE_MS` still serves two unrelated subjects under one key. Round 2 named this exact shape as the defect; v3 fixed the missing subject and kept the conflation.

design:530: "`SETTLE_MS` | `750` | **File-stability and actor-idle re-read gap**." Round 2's MAJOR 4
was that v2 "kept the word `SETTLE_MS`, kept the config key, and pointed it at a different subject".
v3 correctly restored the agent-status re-check (design:359-362) *and* kept the honest file-stability
description (design:394-396) — both halves, genuinely. But it then ran both off the same number, so
the two cannot be tuned independently, and a user who raises it to make artifact reads safer also
lengthens every delivery's idle confirmation. Note too that a 750 ms re-read runs synchronously inside
a 1000 ms tick (design:525), so a tick with several deliveries overruns its own interval.
**Fix:** split into `FILE_SETTLE_MS` (750) and `ACTOR_SETTLE_MS` (750), and state that the actor
re-read happens off the tick's critical path.

---

## MINOR 2 — On a cold start the supervisor's workspace is the *focused* one, contradicting "lives in its own unfocused workspace". `--no-focus` is honoured only when another workspace already exists.

design:94-97 and design:120: the supervisor "lives in its own unfocused workspace" created with
`workspace create --label <label> --no-focus`. Measured, cold start (empty `workspace list`):

```
-- workspace create --label pipeline --no-focus:
{"result":{"workspace":{"label":"pipeline","number":1,"workspace_id":"w1","focused":true,…},
           "root_pane":{"pane_id":"w1:p1","focused":true,…}}}
```

`focused: true` despite `--no-focus` — there is nothing else to focus. On a warm restart the same call
correctly returned `focused: false`. So on a cold start the user's first workspace is the pipeline
one. **Fix:** one sentence in §Startup reconciliation — "on a cold start the pipeline workspace is
necessarily focused; the hook creates the user's default workspace first, or focuses away after
opening the supervisor pane." (Ordering against the TUI's own first-workspace creation is untested
here — see open questions.)

---

## MINOR 3 — Workspace labels are not unique, so "if none carries `PIPELINE_WORKSPACE_LABEL`" can match the wrong workspace or silently create a second one.

design:120: "`workspace list`; if none carries `PIPELINE_WORKSPACE_LABEL`, `workspace create --label
<label> --no-focus`". Measured: two workspaces can carry the same label simultaneously —

```
"workspaces":[{"label":"pipeline","workspace_id":"w1","number":1,…},
              {"label":"pipeline","workspace_id":"w2","number":2,…}]
```

herdr enforces nothing, and the user can rename any workspace to `pipeline`. A label lookup is also
the design's *only* way to re-find the workspace after a restart. **Fix:** record the workspace id in
the state dir (design:187 already says the startup hook reconciles; add `workspace.<session>.id`),
match on the recorded id first and fall back to the label; if the label matches more than one, use the
one containing a supervisor-labelled pane and report the ambiguity in `hpipe status`.

---

## MINOR 4 — `escalated` is a phase with no row, in a table the document calls complete.

design:434: "`escalated` is a real phase, recording `escalated_from`." design:335: "**Fourteen rows**".
The table (design:342-355) has no `escalated` row, so the phase has no actor, no completion predicate,
no success cell and no failure cell — it is entered by `MAX_PASSES` exhaustion and left only by a human
typing `hpipe rewind`. The recovery table does carry the exit (design:513), so this is documentation,
not a hole in the mechanism. **Fix:** add the row — "`escalated` | human | `hpipe rewind` resets `pass`
| back to `escalated_from` | —" — and make the count fifteen.

---

## MINOR 5 — The wrapper's exit message is unconditional, so the singleton-guard path prints both "another supervisor is live" and "supervisor exited".

design:100-102: the command is `…; echo '[pipeline] supervisor exited — run hpipe status'; exec $SHELL`
and "The singleton-guard path prints `another supervisor is live (pid N, session S)` before dropping to
the shell." Both messages come from the same pane in the same second, and the second one is false — no
supervisor exited, a duplicate declined to start. **Fix:** have `main.ts` exit `3` on the guard path and
make the wrapper `… || true; [ $? = 3 ] || echo '[pipeline] supervisor exited — run hpipe status'`, or
simply move the message into `main.ts` where the exit reason is known.

---

## MINOR 6 — `boot_id` has no macOS source, on a design that declares `platforms = ["macos", "linux"]`.

design:257 puts `boot_id` in the pid file and design:545 makes it part of liveness. Linux has
`/proc/sys/kernel/random/boot_id`; macOS does not:

```
$ ls /proc/sys/kernel/random/boot_id
ls: /proc/sys/kernel/random/boot_id: No such file or directory
$ sysctl -n kern.boottime
{ sec = 1788479324, usec = 183064 } Thu Sep  3 17:48:44 2026
```

**Fix:** name both sources in the §State bullet — `sysctl -n kern.boottime` on macOS,
`/proc/sys/kernel/random/boot_id` on Linux — or drop `boot_id` entirely, since the `started_at_ms` +
process-start-time comparison design:545 already specifies is sufficient to defeat pid reuse.

---

## MINOR 7 — The reconcile's `plugin pane open` omits `--plugin` and `--entrypoint`, both of which the verb accepts.

design:125: "`plugin pane open --workspace <id> --placement tab --no-focus`". The verb's full signature
is `--plugin <ID> --entrypoint <ID> --placement <…> --workspace <ID> --target-pane --direction --cwd
--env --focus --no-focus` (`plugin pane open --help`, 0.9.0). Whether `--plugin`/`--entrypoint` default
usefully when invoked from inside the owning plugin's own hook is not something the design should rely
on implicitly, particularly once a second `[[panes]]` entry ever exists. **Fix:** write the command as
`plugin pane open --plugin "$HERDR_PLUGIN_ID" --entrypoint supervisor --workspace <id> --placement tab
--no-focus`.

---

## MINOR 8 — The verdict rule is called "`CLAUDE.md:28-30` verbatim" and is a paraphrase that resolves a real ambiguity in one direction.

design:425-427: "**`BLOCKER` means: any BLOCKER finding, or any MAJOR that reverses a decision, changes
scope, or needs a judgment only the user can make.** … That is `CLAUDE.md:28-30` **verbatim**, including
its qualifier." The source reads:

```
28| **When a review clears — no hard blockers (no BLOCKER/MAJOR that reverses a decision, changes scope,
29| or needs a judgment only the user can make) — advance to the next step automatically:**
```

The qualifier attaches to "**BLOCKER/MAJOR**" jointly, so the source can equally be read as qualifying
BLOCKERs too. v3's reading (BLOCKER unqualified, MAJOR qualified) is the sensible one and I would keep
it — but it is an interpretation, not a transcription, and calling it verbatim is the same
cite-precision failure round 2's MINOR 1 flagged one level down. (The other seven citations in v3 —
`CLAUDE.md:36-37`, `:46`, `:66`, `:76`, `:88-89`, `:92-94`, `:95-97` — were each checked line by line
and are **all correct**.) **Fix:** "That is `CLAUDE.md:28-30`, reading its qualifier as attaching to
MAJOR."

---

## MINOR 9 — The trailer cannot encode the qualifier it is now gated on, and `MAJORS:` on a `CLEAR` verdict is unspecified.

design:414-423 shows `VERDICT: CLEAR` bare, and `VERDICT: BLOCKER` with `BLOCKERS: n` / `MAJORS: n`.
The gate (design:425-426) turns on *whether a MAJOR reverses a decision / changes scope / needs the
user* — a property of individual findings that a count cannot carry. In practice the plugin must trust
the `VERDICT:` line and treat the counts as display, which is fine; the document should say so, and
should say whether a `CLEAR` trailer carries `MAJORS: n` (design:426's "with MAJORs and MINORs fixed
inline" implies the next prompt wants to know there are some). **Fix:** one line under the trailer
block — "counts are informational; the `VERDICT:` line is authoritative because only the reviewing
agent can apply the qualifier. A `CLEAR` trailer still carries `MAJORS: n`, and the next phase's prompt
names the verdict file so the open MAJORs are fixed inline."

---

## MINOR 10 — The supervisor's drain is not specified as crash-safe, and abandoned `.tmp` files are never collected.

design:83 and design:260-262: "glob `queue/*.json`, read, unlink; dedup". The order of *ledger write*
and *unlink* is what decides at-least-once versus at-most-once, and the document does not state it: if
the supervisor unlinks first and dies, the event is gone; if it writes the ledger first and dies, the
dedup (design:451) makes the replay harmless. Separately, a hook killed between `open` and `rename`
leaves a `queue/*.json.tmp` forever — design:262 correctly notes it is invisible to the glob, but
nothing ever removes it. **Fix:** state "ledger entry is written and fsynced **before** the unlink;
replay is idempotent via the ledger", and have the startup hook delete `queue/*.json.tmp` older than
one hour.

---

## MINOR 11 — Nothing removes `~/.local/bin/hpipe` on unlink. Open since round 1.

design:491-492 ("idempotently symlinks … replacing a stale link") and the Recovery row at design:517
("`herdr plugin unlink stein.pipeline`; worktrees, branches, PRs and issues are plain git/GitHub
objects"). Round 1's m2 was marked **cosmetic** by round 2 with the note "nothing still removes
`~/.local/bin/hpipe` on unlink"; v3 does not address it, so a dangling `hpipe` stays on `PATH` pointing
into a plugin root that may no longer exist. **Fix:** add to the Recovery row — "`unlink` leaves
`~/.local/bin/hpipe`; remove it by hand, or set `HPIPE_LINK=0`" — or have the `status` action detect
and report the orphan.

---

## Audit of rounds 1–2 fixes

### Round 2's 21 findings against v3

**Genuinely fixed: 14. Cosmetic: 2. Displaced: 5.**

| R2 | Finding | Verdict | Evidence |
| --- | --- | --- | --- |
| B1 | Startup hook cannot open the pane; restart leaves ghost + duplicate | **Fixed — verified live** | design:105-126. I expected this to fail and it does not. Cold start (`workspace list` → `[]`, `pane list` → `[]`): `workspace create --label pipeline --no-focus` **rc=0**, then `plugin pane open` **rc=0**, pane `w1:p2`. Warm restart with a snapshot: the hook sees the restored workspace *and* the ghost, and both calls succeed. The `workspace create` first step is precisely what clears `no_active_workspace`. Ghost reaping is implementable (`pane close w1:p2` → `{"type":"ok"}`; restored ghost confirmed a plain `-zsh` still labelled "Probe supervisor"). Residue → MAJOR 2 (pid source), MINOR 2, MINOR 3, MINOR 7 |
| B2 | Dead supervisor's pane vanishes; the pane-over-daemon rationale is false | **Fixed** | design:94-103 withdraws the "visible corpse" claim in as many words and makes `hpipe status` the detector; the wrapper is in the manifest at design:246. Residue → MAJOR 3 (`$SHELL` unset), MINOR 5 (unconditional echo) |
| B3 | Edge predicates given to runs, withheld from tasks | **Displaced** | The *data* is fixed and well done — design:292 task `phase_entered_at`/`head_sha_at_entry`/`pass`, design:303-304 verdict keys `<task_id>-task-review-spec-<pass>`, design:348 `headRefOid != head_sha_at_entry`. The *rule* that consumes `pass` was not written → **MAJOR 4**. And the edge rule still misses 5 of 14 rows → **MAJOR 5** |
| B4 | Agent-idle condition removed from the whole table | **Fixed** | design:342-355 restores `actor idle` on the artifact rows, design:359-362 adds the delivery-time double re-read, and the arithmetic is corrected — I recounted: 14 rows, 10 orchestrator-owned, both now accurate. Over-corrected into a universal that 3 rows break → MAJOR 5, and into simultaneous advances the digest cannot carry → MAJOR 6 |
| B5 | Global plugin state vs per-session pane ids; two servers running | **Displaced** | §Sessions (design:128-144) is the right architecture and `HERDR_SESSION` **is** injected into startup, event and pane processes (measured in session `pipe3`) — better than `plugins.mdx:254-261` documents. But it is **unset in the default session** (measured) → **MAJOR 1** |
| M1 | `gh pr view --json merged` does not exist | **Fixed** | design:167 is now a verified-facts row naming `state`, `mergedAt`, `headRefOid`, and design:352 uses `state == "MERGED"`. Re-executed: all three are in `gh pr view --json`'s field list, and `merged` is still absent |
| M2 | Queue rotation loses a post-rename append | **Fixed** | design:260-267 replaces rotation with one file per event plus `.tmp`→`rename`, and explains *why* rotation was lossy rather than just restating the fix. Residue → MAJOR 7 (no ordering), MINOR 10 (crash window, `.tmp` GC) |
| M3 | "any MAJOR" × `MAX_PASSES` makes escalation the default; escalate has no exit | **Fixed** | design:425-427 restores the qualifier, design:434-435 makes `escalated` a phase with `escalated_from` and has `rewind` reset `pass`, design:513 is the recovery row. Residue → MINOR 4 (no table row), MINOR 8 ("verbatim"), MINOR 9 (trailer), and the task-level twin is missing → MAJOR 4 |
| M4 | Settle check mis-described; agent-status re-check dropped | **Cosmetic** | Both halves are present — honest file description at design:394-396, actor re-read restored at design:359-362 — but they share one config key, which is structurally the same conflation the finding was about → MINOR 1 |
| M5 | `queued` gate bypassed by `hpipe task`'s own output; no ids; no cycle check | **Displaced** | Withholding (design:369-370), `task_id` printed (design:497), cycle rejection (design:372), prefix globs stated as a heuristic (design:375-377) — four of five. The deadlock detector became a `status` mention → **MAJOR 8**, and moving delivery to the worker opened a new hole → **MAJOR 9** |
| M6 | `core`-first implemented without the `dist` rebuild | **Fixed** | design:379-382 adds the conditional line to `prompts/task.md` and cites `CLAUDE.md:95-97`, which I verified reads "let it land and rebuild `dist`" |
| M7 | Stall probe fires on every healthy run | **Fixed** | design:439-446 restricts it to file phases by name, gives `execute` its own `TASK_STALL_MINUTES` (design:529), and the test plan asserts "**never** on `execute`" (design:571). `queued` is still uncovered, which is MAJOR 8's territory |
| M8 | PID liveness defeated by reuse; `status` reports a phantom | **Fixed** | design:257 is the full record, design:545 requires pid + start time + session, design:498 prints all four states, design:515 names the file. Residue → MAJOR 2 (one `pid` for two processes), MINOR 6 (`boot_id` on macOS) |
| m1 | Two `CLAUDE.md` citations wrong | **Fixed** | design:315 `CLAUDE.md:66` ✓ ("open a GitHub issue per task"), design:427 `CLAUDE.md:28-30` ✓. All seven other citations checked line by line and correct |
| m2 | `placement = "tab"` lands in the active workspace; nothing creates the workspace | **Fixed** | design:159 verified-facts row, design:120-121 creates it and closes the stray root pane. Residue → MINOR 2, MINOR 3 |
| m3 | Action still called `ci-pane` | **Fixed** | design:237-240 and design:186 are `supervisor`; `grep -n "ci-pane"` finds nothing in v3 |
| m4 | `rewind` takes no task selector; `abort` has no inverse | **Fixed** | design:500 `[--task <id>]`, design:501 `hpipe resume`, design:514 recovery row |
| m5 | 32-command row asserts an unverified absolute; smoke assertion dropped | **Fixed** | design:548 softened to "in normal operation; asserted by the smoke test", and design:573-575 adds the `plugin log list` → zero `plugin_command_limit_reached` assertion |
| m6 | `WAKE_ON` mixes statuses and events; `released` never handled | **Fixed** | design:470-472 separates statuses from events and includes `unknown`; design:164 and design:348 make a release mark the task `failed`; design:555 is the failure row |
| m7 | `digest.md` orphaned; `{{agent_file}}` unchecked | **Fixed** | design:452-453 wires `prompts/digest.md` into the coalesced message; design:385-387 rejects a `--surface` with no agent file |
| m8 | Teardown unconditional; `GH_BIN` undocumented | **Fixed** | design:288 `keep_worktree` on the task record, design:497 `--keep-worktree`, design:354 skip-to-`done`, design:484 cites `CLAUDE.md:88-89` ✓; `GH_BIN` row at design:536 |

### Round 1's findings that round 2 marked cosmetic or displaced

| R1 | R2 verdict | v3 verdict | Evidence |
| --- | --- | --- | --- |
| B2 — no clock anywhere | Displaced | **Fixed** | The supervisor's lifecycle problems that the clock displaced into (R2 B1/B2/B5, M8) are each addressed in v3; what remains are the corrections above |
| B4 — task ordering and collision rule dropped | Cosmetic | **Fixed** | `queued`, `depends_on`, `files`, `surface`, cycle rejection, prompt withholding and the `dist` rebuild are all present (design:347, 364-382). The gate is now binding rather than advisory |
| B6 fix #3 — agent-status re-check | Displaced onto a file check | **Fixed** | design:359-362, restored as round 1 specified ("re-read … and require it still to be `idle`/`done` after `SETTLE_MS`"). Shares a key → MINOR 1 |
| B7 — level-triggered predicates livelock | Displaced (runs only) | **Mostly fixed** | Task records now carry their own edge state (design:292, 300-304). Five rows remain level-triggered → MAJOR 5 |
| M3 — read/truncate races appenders | Cosmetic (rotation with a false justification) | **Fixed** | One file per event; the false justification is replaced with the correct explanation (design:264-267) |
| M4 — `gh pr checks --json conclusion` | Displaced into `pr view --json merged` | **Fixed** | Both rows now carry verified field lists (design:166-167), re-executed against gh 2.96.0 |
| M7 — CI supervisor may not exist when needed | Displaced into B1 | **Fixed** | Reconcile verified live |
| M8 — binary verdict discards MAJOR | Cosmetic | **Fixed** | The qualifier is restored with its reasoning (design:425-432) |
| M9 — prompting a mid-turn agent | Displaced | **Partly fixed** | design:359-362 gates delivery on a double idle read and design:505-506 keeps `hpipe start` printing. Still unverified against a real Claude Code pane — open question 2, unchanged for three rounds |
| m2 — `hpipe` symlink lifecycle | Cosmetic | **Not addressed** | → MINOR 11 |
| m4 — `agent_detected` fires on release | Cosmetic (no handler) | **Fixed** | design:164, design:348, design:555 |

### Re-verification of v3's "Verified herdr facts" table (design:151-173)

Independently re-executed. Every row holds. Newly confirmed this round, and worth promoting into the
table because v3's mechanisms now depend on them:

- `workspace create --label <t> --no-focus` **succeeds during startup-hook execution on a cold start**,
  and `plugin pane open` succeeds immediately after — this is the fact that makes §Startup
  reconciliation work, and it is currently only implied.
- `HERDR_SESSION` is injected into startup, event and pane plugin processes for **named** sessions and
  is **unset in the default session** (MAJOR 1). `plugins.mdx:254-261` does not document it at all.
- `SHELL` is **not** injected by herdr; it arrives by inheritance from whatever launched the server
  (MAJOR 3).
- `pane list` / `pane get` expose **no pid**; `pane process-info --pane <id>` returns `shell_pid` and
  `foreground_processes[].pid`, and for a wrapped command `shell_pid` is the **wrapper**, not the
  supervisor (MAJOR 2).
- Plugin pane commands run with `cwd = HERDR_PLUGIN_ROOT` (measured), so the manifest's relative
  `bun run src/supervisor/main.ts` resolves correctly. ✓
- A restored plugin pane keeps its `label` in `pane list` (`"label":"Probe supervisor"` on a plain
  `-zsh`), so label-based ghost detection is sound. ✓
- Workspace labels are **not** unique (MINOR 3).
- `gh pr view --json` offers `state`, `mergedAt`, `closedAt`, `headRefOid`, `updatedAt`; `gh issue view
  --json` offers `closed`, `closedAt`. No `merged` on either. ✓
- `herdr worktree remove --workspace <ID> --force` ✓, `pane close <pane_id>` ✓, `workspace close
  <workspace_id>` ✓, `agent get <target>` ✓, `agent prompt <TARGET> <TEXT>` ✓, `agent start <NAME>
  --kind <KIND> --pane <ID>` ✓ — every herdr verb v3 invokes exists with the flags v3 uses.

**Not re-litigated**, per round 2: APFS mtime granularity and clock skew; `HERDR_PANE_ID` /
`HERDR_SOCKET_PATH` in pane shells; the 32-concurrent cap; `agent start` adopting an existing pane.

---

## Open questions (not ranked as findings)

1. **What does Claude Code do with an `agent prompt` that lands mid-turn?** Unverified for three
   rounds. v3 reduces the exposure considerably (delivery is now gated on a double idle read,
   design:359-362, and `hpipe start` prints rather than injects, design:505-506), but design:410 still
   accepts "an agent writes a complete artifact and keeps going" as residual. It remains the single
   highest-value thing to test before the state machine is built on it.
2. **Is `HERDR_SESSION` set in the default session's *pane shells*?** Measured unset in a default-session
   *plugin* process. Pane shells were not tested, because testing them means creating a pane in the
   user's live session. MAJOR 1's fix makes the answer irrelevant, which is the reason to take the fix.
3. **On a cold start under the TUI, does the startup hook run before or after herdr creates its own
   first workspace?** Measured headless (`herdr server`), where no workspace pre-exists. The ordering
   decides whether MINOR 2 is visible in practice.
4. **Is the 32-concurrent-command cap per plugin or per server?** Open since round 1. Matters only if a
   second plugin is installed.
5. **Does `worktree.removed` fire for a workspace closed via `workspace close` rather than `worktree
   remove`?** Open since round 2; design:486-487 depends on it to mark a hand-removed worktree
   `orphaned`.

---

## Verdict

Ten MAJORs and eleven MINORs, and **no BLOCKER**.

That is a real change in kind from rounds 1 and 2, not a softer reviewer. Both earlier rounds found
claims that were *false about herdr* — mechanisms the document asserted and the binary refused. I went
looking for more of those, with a live probe built specifically to break the startup reconcile, and it
held: `workspace create` clears `no_active_workspace` on a cold start, the reopened pane works, the
ghost is reapable, and the label survives a restore. The `gh` field names are right this time,
including the one that was wrong twice. The run/task asymmetry that defined round 2's audit is closed
in the state shape, and the arithmetic round 2 corrected is now accurate.

The class pattern is not gone, but it has changed shape: v3's remaining defects are **universal claims
that its own tables contradict**. "Every orchestrator-owned predicate is actor-idle and artifact-fresh"
— three rows are not. "Every predicate compares against `phase_entered_at`" — five rows do not.
"`MAX_PASSES` … before escalating" — tasks have the counter and no cap. "One coalesced message … the
phase just entered" — ten task rows can now enter phases together. Each is a sentence that was true
when written and was not re-checked against the rows added beside it. And the one new architectural
dependency, `HERDR_SESSION`, was verified in a named session and generalised to the unnamed one, which
is the session the user actually works in.

None of these reverses a decision, changes scope, or needs a judgment only the user can make. MAJOR 4
and MAJOR 8 come closest — both require choosing what happens to a stuck task — but in both cases the
run-level rule already in the document supplies the obvious mirror, so they are corrections, not
questions. MAJOR 9 is the one to fix first regardless of rank: restoring v2's "prompt the orchestrator
to dispatch" costs four words and closes a hole that would otherwise surface as tasks that register and
never start.

Applying design:425-426's own gate honestly — any BLOCKER, or any MAJOR that reverses a decision,
changes scope, or needs the user — this clears, with the MAJORs and MINORs fixed inline.

VERDICT: CLEAR
