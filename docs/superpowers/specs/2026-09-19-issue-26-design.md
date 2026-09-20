# A verdict path assigned once under a stable key — design (#26)

Pass 3, revised in place after its review cleared. Written against this worktree at `91fc730`
(branch `fix/26-verdict-overwrite`), building on
`docs/superpowers/research/2026-09-19-issue-26-research.md` and governed by the `Ruling` section on
issue #26 (2026-09-19) **as clarified by the orchestrator** after the third review.

Four reviews stand behind it, in order:

| Review | Verdict | Where it landed |
|---|---|---|
| `…/issue-26-spec-review-pass0-preserved.md` | BLOCKER (1/3/6) | rewrote pass 0 into pass 1 |
| `…/issue-26-spec-review-pass1-preserved.md` | BLOCKER (1/2/5) | triggered the ruling; pass 2 |
| `…/issue-26-spec-review-0.md` | BLOCKER (1/1/6) | triggered the clarification; pass 3 |
| `…/issue-26-spec-review-1.md` | **CLEAR** (0/2/4) | both MAJORs and all four MINORs applied below |

The first two filenames are this issue's own bug, hand-worked-around at `b43b73f`. Every claim about
current behaviour carries a `file:line` or the command that produced it.

**Modelled on** `src/lib/gating.ts` for a pure `src/lib/` module imported by both `src/cli.ts` (`:5`)
and `src/supervisor/tasks.ts` (`:4`); `src/lib/predicates.ts:1` for a `src/lib/` module that stats the
filesystem; `counterFor`/`bumpCounter` (`src/lib/machine.ts:7-21`) for the shape of a per-phase
counter on the record; and the artifact-adoption write-back at `src/supervisor/tasks.ts:264-267` for
recording a resolved path onto the record so later reads cite it. No new pattern is introduced.

## What the clarification changed

The pass-2 review's BLOCKER stood up: I had specified `reserveVerdict` to walk from the **lowest free**
ordinal and `recordedVerdict` to return the **highest recorded** one, and those agree only on a
gap-free map — which is not what a legacy record or a `git mv` preservation produces. The reviewer's
proposed fix was to align the two selection rules.

The orchestrator's clarification rejects that framing and is a better answer:

> There must be exactly ONE lookup on the read side, and it is a dictionary lookup, not a scan. The
> reader takes the key it is asked about and returns `artifacts.verdicts[key]` — no 'lowest free', no
> 'highest recorded', no scanning the map. […] If the reader has to pick between candidates at all,
> the design has not yet done what the ruling asked. The key itself must be stable for the thing being
> reviewed.

So the defect was never the *selection rule*; it was that the read side had a selection rule at all.
**BLOCKER 1 is not patched, it is made structurally impossible**: under this pass the reader cannot
disagree with the reserver, because the reader never chooses.

| Pass-2 component | Status |
|---|---|
| `recordedVerdict` — "highest ordinal present" | **Deleted.** The read is `verdicts[key]`, one dictionary lookup. |
| "lowest free ordinal" as a *key* rule | **Deleted.** It survives only as the reserver's choice of *filename*, which no reader consults. |
| The map as the thing that prevents re-issue (pass-2 A11) | **Replaced** by a monotone key. |
| The `existsSync` probe | **Kept**, and now provably safe: it picks a filename, never a key (A2). |
| `cmdRewind` reserving (pass-2 C3, A3) | **Kept.** |

The clarification's last sentence is the whole design: *"if phase plus pass is not stable across a
resume, that is the thing to fix, not the selection rule."* I checked which half is unstable:

- **Across a resume, `phase` + `counterFor` is already stable.** `deliverPendingAnswers`
  (`src/supervisor/tasks.ts:314-343`) calls `enterTaskPhase` at `:341`, which re-stamps
  `phase_entered_at` (`src/lib/machine.ts:94`) but never touches `passes`. That is why pass 1's
  `phase_entries` broke and `passes` does not: a resume is not a pass.
- **Across a rewind, it is not stable** — `src/cli.ts:353` and `:360` clear `passes`, so the key
  regresses onto a key already in the map. That is issue #26 itself, expressed as a key collision.
- **And a `CLEAR` never advances it** — `src/lib/machine.ts:117-118` returns before `bumpCounter`, so
  a review that cleared and is then rewound onto reuses its key too.

The ruling already licensed the remedy: *"If a new counter is genuinely needed, it must be incremented
where a **new review** is commissioned, not where a phase is re-entered."* That is C1.

## Problem

The verdict path is derived, on every read, from a counter that `hpipe rewind` clears.

    src/supervisor/deliver.ts:101-103
      const key = `${task.phase}-${counterFor(task, task.phase)}`
      return task.artifacts.verdicts[key]
        ?? join(REVIEWS_DIR, `issue-${task.issue}-${key}.md`)

    src/cli.ts:353   task.passes = {}
    src/cli.ts:360   run.passes = {}

That path is handed to an agent verbatim as `{{verdict_path}}` (`src/supervisor/tasks.ts:55`,
`src/supervisor/deliver.ts:253`) by five prompts (`prompts/spec-review.md:7-9`,
`prompts/plan-review.md:9`, `prompts/pr-review-intent.md:11`, `prompts/pr-review-quality.md:11`,
`prompts/branch-review.md:23`), one of which requires it committed and pushed
(`prompts/spec-review.md:16-17`), so the loss lands on the branch.

Verified on `fix/15-stall-escalation`: `git log --oneline --diff-filter=M fix/15-stall-escalation --
docs/superpowers/reviews/issue-15-spec-review-0.md` → `f672bfe`, `--stat`
`314 insertions(+), 348 deletions(-)` on a 662-line file — a whole-file replacement. **Four** manual
`git mv` repairs now: `432f4d7`, `944210d`, `ddd5086` (research `:119-129`), and `b43b73f` on this
branch, which freed the path this pass's own review was written to. 13 rewinds across four live
ledgers in three days.

**The defect has two faces, and the issue text only describes one.** The clobber is what the issue
reports. The other is a *wedge*: after a rewind the key regresses onto a file older than
`phase_entered_at`, `isFresh` (`src/lib/predicates.ts:10-20`, read at `src/supervisor/main.ts:196`)
can never accept it, and the row waits for the stall ladder. Measured on this task, on 2026-09-19:
`phase: spec-review`, `passes: {}`, `phase_entered_at` 22:56:44, `issue-26-spec-review-0.md` mtime
16:56:38 — six hours stale, `artifacts.verdicts: {}`. That measurement is specifically a rewind
**onto** the review row — this run's own t1 history reads
`22:56:44 rewind -> spec-review | manual rewind` — which matters, because the two faces are not
closed to the same degree:

- **The clobber is closed everywhere.** No commissioned review is ever handed a filename another
  review holds.
- **The wedge is closed for a rewind onto a producer row** (`spec`, `plan`, `implement`), where the
  following transition renders a prompt and reserves immediately.
- **For a rewind onto a review row the wedge is made non-destructive, not shorter.** The reserved
  path does not exist yet, so `isFresh` is false there too (`statSync` throws →
  `src/lib/predicates.ts:17-18`), `advanceTask` returns `null` (`src/lib/machine.ts:151`) and
  `src/supervisor/tasks.ts:172-173` `continue`s without rendering. The row still waits for the human
  or the stall ladder; what the fix removes is the overwrite at the end of that wait. A6 owns this
  cost, and it is the documented escalation recovery rather than an edge case.

On this very task that wait was 18 minutes and ended with a human `git mv` (`b43b73f`, 23:02:30) and
a transition at 23:14:56. Under this design the `git mv` becomes unnecessary; the 18 minutes do not.

## Goal

The path a live agent was handed never moves under it, and two different reviews never share a
filename. Both hold across a resume, across `hpipe rewind`, across a `CLEAR`, and on the records
already on disk.

## Non-goals

- No `schema_version` bump. The one new field is optional and absent-safe; `isCurrentSchemaRun`
  (`src/supervisor/main.ts:32-34`) stays satisfied.
- No change to `passes`, `counterFor`, `bumpCounter`, `advanceLoopingRow` or any transition function.
  `passes` remains the escalation budget (`src/lib/machine.ts:120-126`, `:78-81`), rewind keeps
  clearing it, and `README.md:100` stays true (A9).
- **No bump on `enterTaskPhase`/`enterRunPhase`.** That was pass 1's BLOCKER and the ruling forbids it.
- No change to `hpipe status` (A6), no rename of the five `*-preserved.md` files.
- No edit to `README.md`, `prompts/dispatch.md`, `src/hooks/`, `src/lib/config.ts` or
  `test/config.test.ts` — sibling-owned. Per the ruling my `src/cli.ts` work is confined to
  `cmdRewind`; t2 holds the `cmdTask` header lines near `:255-269` and rebases onto my merge.
- Not #22's rewind validation; the phase check already landed at `src/cli.ts:311-321`, and C3 relies
  on it (A10).

## Architecture

### C1 (load-bearing) — a key that advances only when a review is commissioned

One new optional field, mirroring `passes` (`src/lib/types.ts:90`, `:119`):

    Task.verdict_seq?: Partial<Record<TaskPhase, number>>
    Run.verdict_seq?:  Partial<Record<RunPhase, number>>

`verdict_seq[phase]` is **the number of reviews commissioned for that phase**. It is incremented by
the reserver and by nothing else — not by a transition, not by a resume, not by a rewind's counter
reset. The key is:

    verdictKey(phase, seq) = `${phase}-${seq}`

**Stable across a resume**, because no prompt is rendered and so nothing reserves (verified above).
**Never regresses**, because nothing decrements or clears it — including `cmdRewind`, which clears
`passes` and leaves `verdict_seq` alone. **Advances on every commission**, including after a `CLEAR`,
which is the case `passes` cannot express.

### C2 — `src/lib/verdict-path.ts`: one speller, one read, one reserver

`src/cli.ts` cannot reach `src/supervisor/`, which is why this is a `src/lib/` module:

    $ grep -rn "supervisor/" src/ | grep -v "^src/supervisor/"
    (no output)

`src/cli.ts:4-21` imports only from `./lib/` (`:2-3` are `node:fs`/`node:path`);
`src/supervisor/deliver.ts:2-10` only from `../lib/`.

    export const REVIEWS_DIR = 'docs/superpowers/reviews'   // moved from src/supervisor/deliver.ts:95

    /** The ONE place a verdict filename is spelled. Always REPO-RELATIVE. */
    export function verdictFilename(prefix: string, phase: string, ordinal: number): string

    /** The ONE place the prefix is chosen: `issue-${task.issue}` or `run.run_id`. */
    export function verdictPrefix(run: Run, task: Task | null): string

    /** The ONE base a verdict path resolves against. Absolute. */
    export function verdictBase(run: Run, task: Task | null): string   // task?.checkout_path ?? run.repo_root

    /** THE READ. One dictionary lookup, no scan, no candidates. REPO-RELATIVE or null. */
    export function verdictFor(record, phase): string | null {
      const seq = record.verdict_seq?.[phase] ?? 0
      if (seq === 0) return null                       // nothing commissioned yet — A1
      return record.artifacts.verdicts[verdictKey(phase, seq - 1)] ?? null
    }

    /** THE WRITE. Chooses a filename once, records it under the next key, never revisits. */
    export function reserveVerdict(run: Run, task: Task | null, phase: string): string

`reserveVerdict`:

0. `record` is `task ?? run`; the prefix and base come from `verdictPrefix`/`verdictBase`, so
   neither is chosen at a call site (pass-3 MINOR 1).
1. `const seq = record.verdict_seq?.[phase] ?? 0` — the key is `verdictKey(phase, seq)`, and it has
   never been used, because `verdict_seq` never regresses.
2. Choose the **filename**: the lowest `ordinal >= seq` whose `verdictFilename(prefix, phase, ordinal)`
   is neither present on disk under `base` nor already a value in `record.artifacts.verdicts`
   (bounded, A8).
3. Write `record.artifacts.verdicts[verdictKey(phase, seq)] = <filename>` and
   `record.verdict_seq[phase] = seq + 1` (creating the map if absent).

**Why the probe can no longer desynchronise anything (the pass-2 BLOCKER).** It selects a *filename*;
the *key* comes from `verdict_seq`. The reader looks up the key and returns whatever filename was
recorded under it. Freeing a low name on disk — the `git mv` workaround, four times in this repo's
history — can change which filename a *future* reservation picks, and can never change what an
existing key resolves to. Step 2's map-value check additionally stops a freed name from being handed
out twice, so an earlier key never comes to point at a later review's file.

### C3 — read everywhere, reserve at exactly three sites

`artifactPathFor` (`src/supervisor/deliver.ts:97-107`) becomes a read, for both branches:

    if (task) {
      const row = taskRow(task.phase)
      if (row.artifact) return task.artifacts[row.artifact]                       // unchanged
      if (row.signal !== 'verdict') return <today's derivation>                    // unchanged, A5
      return verdictFor(task, task.phase)
        ?? join(REVIEWS_DIR, `issue-${task.issue}-${task.phase}-${counterFor(task, task.phase)}.md`)
    }
    if (runRow(run.phase).signal !== 'verdict') return <today's derivation>        // unchanged, A5
    return verdictFor(run, run.phase)
      ?? join(REVIEWS_DIR, `${run.run_id}-${run.phase}-${counterFor(run, run.phase)}.md`)

The `??` branch is the **only derivation left**, and only for a record in flight at upgrade whose
agent already holds today's path (A1). Every reader reaches it: the tick's freshness check
(`src/supervisor/main.ts:193-198`), `absoluteArtifactPath` (`src/supervisor/deliver.ts:110-115`), the
stall probe (`src/supervisor/stall.ts:203`), and both `{{verdict_path}}` renders.

`reserveVerdict` is called from three sites, guarded on `signal === 'verdict'`:

| Site | Guard | Why |
|---|---|---|
| `src/supervisor/tasks.ts:46-60` (`promptForTaskPhase`) | `taskRow(task.phase).signal` | the task render |
| `src/supervisor/deliver.ts:246-255` (`promptForRunPhase`) | `runRow(run.phase).signal` | the run render |
| `src/cli.ts:372` (`cmdRewind`, before `saveRun`) | both, per branch | the only commission with no render (A4) |

Both render sites build `common` **before** the `switch` (`src/supervisor/tasks.ts:49-60`,
`src/supervisor/deliver.ts:250-255`), so `verdict_path` is computed for every phase and the guard is
not optional. It tests `signal`, not `artifact === undefined`: `ci` (`src/lib/phases.ts:122-124`),
`merge`, `close`, `implement` and the blocked rows all lack an `artifact`.

**Ordering at the render sites, which pass 2 left implicit** (pass-2 MINOR 5): `reserveVerdict`
returns repo-relative, and both sites need absolute — `src/supervisor/tasks.ts:55` is
`absoluteArtifactPath(run, task) ?? ''` and `src/supervisor/deliver.ts:248` joins `run.repo_root`. So
the required order is **reserve first, then read through `absoluteArtifactPath`**, and the render must
never use `reserveVerdict`'s return value directly. `src/cli.ts:13` currently imports `taskRow` but
not `runRow`; C3's run branch needs both.

### C4 — `cmdRewind` reserves when it rewinds *onto* a verdict row

A rewind onto a review row renders no prompt — `advanceTask` returns `null` for a row whose verdict is
not fresh (`src/supervisor/tasks.ts:270-275`, `src/lib/machine.ts:147-156`), so
`src/supervisor/tasks.ts:172-173` `continue`s before the render at `:175` — yet the human has
commissioned a new review. That is
the ruling's own criterion. Rewinding to `spec` commissions nothing and reserves nothing; the
following `spec → spec-review` transition renders and reserves.

`cmdRewind` has what it needs at `src/cli.ts:372`: the phase is already validated against the row
table (`src/cli.ts:311-321`, A10) so `taskRow`/`runRow` cannot throw; `verdictBase` resolves
`task.checkout_path`, which is absolute (live ledger: task `t1` of
`herdr-plugin-pipeline-20260918-…-v0qh` → `/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-21-run-resolution`);
and `saveRun` at `:372` persists immediately. Its success text (`:373`) names the reserved path (A6).

### C5 — two documentation corrections

- `prompts/escalate.md:17` says rewind "resets the pass count for that phase"; `src/cli.ts:353` clears
  the whole map. Corrected. `test/prompts.test.ts` pins only the declared prompt set (`:12`) and
  `stall-escalate.md`'s variables (`:118-122`), so this breaks nothing.
- `src/supervisor/deliver.ts:91-94` asserts *"nothing ever populates `artifacts.verdicts`"*. This
  design is that writer. The conclusion still holds — `adoptableArtifacts` filters by prefix (`:180`,
  pinned by `test/deliver.test.ts:287-295`) — but the reason changes: it is called for artifact rows
  only (`src/supervisor/tasks.ts:254`), so the prefix filter is what keeps a review out of an artifact
  slot. Rewritten.

## Data and control flow

Values in `artifacts.verdicts` are **repo-relative**; `verdictBase` and `absoluteArtifactPath` are the
only joiners (A3).

Normal spec loop (`MAX_PASSES` is 2, `src/lib/config.ts:26`; `src/lib/machine.ts:121-123` escalates on
`count >= maxPasses`):

| Event | Reserve? | `verdict_seq` | key → filename |
|---|---|---|---|
| `spec → spec-review` renders | yes | 0 → 1 | `spec-review-0` → `…-spec-review-0.md` |
| `BLOCKER` → `spec` | no | 1 | — |
| `spec → spec-review` renders | yes | 1 → 2 | `spec-review-1` → `…-spec-review-1.md` |
| `count 2 >= 2` → `escalated` | no | 2 | — |

**A decision answered on a review row** — pass-1's BLOCKER: `deliverPendingAnswers` sends `answer.md`
and calls `enterTaskPhase` (`src/supervisor/tasks.ts:326-341`); `grep -c verdict_path prompts/answer.md`
→ `0`. No render, so no reserve, so `verdict_seq` is unchanged, so the key is unchanged and the reader
returns the path the agent is already writing. Inert by construction. `hpipe abort` + `hpipe resume`
onto `branch-review` (`src/cli.ts:500-516`) is inert the same way.

**`hpipe rewind <run> spec --task t1`** — the commonest rewind (research `:141-144`).
`taskRow('spec').signal` is `artifact`, so C4 reserves nothing; `passes` is cleared as today. The
`spec → spec-review` transition reserves: `verdict_seq` 2 → 3, key `spec-review-2`, and the probe
finds `-0`/`-1` on disk so the filename is `…-2.md`. The cleared counter is simply not consulted.

**`hpipe rewind <run> spec-review --task t4`, legacy record** — the case that made pass 1 a BLOCKER.
`verdict_seq` absent → 0, so the key is `spec-review-0`, which is free *as a key* even though the map
is empty and `…-0.md` sits on disk from the earlier `CLEAR`. The probe starts at ordinal 0, rejects it
(on disk), takes 1, and records `verdicts['spec-review-0'] = '…-spec-review-1.md'`, `verdict_seq = 1`.
The reader returns `…-1.md` from that one key, forever, whatever later happens on disk. **If the
orchestrator then `git mv`s `…-0.md` aside, nothing moves** — which is precisely what pass 2 got
wrong.

**The second instance the issue never names** (A12): `pr-review-intent` clears at counter 0, then
`pr-review-quality` returns `BLOCKER`, bumps **its own** counter and sends the task to `implement`
(`src/lib/phases.ts:111-116`, `:109-110`, `src/lib/machine.ts:120-126`); `implement` clears back to
`pr-review-intent`, whose counter is still 0, so today the second intent review overwrites the first
with **no rewind involved**. `ci`'s `onBlocker: 'implement'` (`src/lib/phases.ts:122-124`) is a third
route to the same re-entry. Under C1 each re-entry renders a prompt and therefore commissions a new
review, so the key advances. `ls docs/superpowers/reviews/ | grep pr-review | wc -l` → 12 over six
issues, consistent with the loop never firing *or* a silent clobber; this is a reachable loss, not an
observed one.

Run-level `branch-review` follows the same flow with `run.artifacts.verdicts`, the `run.run_id`
prefix, and `run.repo_root` as the base.

## Error handling

| Condition | Behaviour |
|---|---|
| `verdict_seq` absent or 0 for a verdict row (a record in flight at upgrade) | `verdictFor` returns `null`; C3's `??` yields today's `counterFor`-derived path, so the agent already writing it is undisturbed (A1). |
| `verdict_seq` present but the key is missing from `verdicts` | `verdictFor` returns `null` and the same fallback applies. Unreachable — step 3 writes both together before `saveRun` — but specified rather than left to throw. |
| `reserveVerdict` on a non-verdict row | Never called; all three sites guard on `signal === 'verdict'`. `ci`, `merge`, `close` and `implement` lack an `artifact` and would pass an `artifact === undefined` test (`src/lib/phases.ts:122-124`). |
| A candidate filename is on disk but in no key | Step 2 skips it. This is the legacy and `git mv` case, and the only reason the probe exists. |
| A candidate filename is a value in the map but absent from disk (reserved, not yet written) | Step 2 skips it, so a freed name is never handed to a second agent. |
| `task.checkout_path === null` | `verdictBase` yields `run.repo_root` — the **main checkout**, which carries every merged sibling's reviews, so the probe may skip an ordinal that is free in the worktree where the file will actually be written. Harmless: skipping forward never loses a review, and the key is unaffected. `src/cli.ts:224` initialises it `null` and `src/supervisor/tick.ts:169` is the only writer, so the window is real. (Pass-2 MINOR 2 — pass 2 answered a different question here.) |
| `existsSync` on a missing or unreadable directory | Returns `false`, so the ordinal is accepted. No review there to lose. |
| The probe exhausts its bound (A8) | Records the **floor** filename (`ordinal === seq`) under the key and logs the exhaustion, so the reader and the prompt still agree. Pass 2 specified returning ordinal 0 and recording nothing, which reproduced its own BLOCKER (pass-2 MINOR 4). |
| `cmdRewind` given a phase in no row | Rejected before C4 runs (`src/cli.ts:311-321`), so the guard's row lookups cannot throw (A10). |
| A reservation written but the process then fails | `src/cli.ts:372` and `src/supervisor/main.ts:242` both `saveRun` after the write; a lost tick re-reads and the key resolves. Nothing is re-allocated. |
| A reservation is never delivered — the send fails, or a second `hpipe rewind` lands on the same row | The key and filename are spent and the gap is permanent. `saveRun` (`src/supervisor/main.ts:242`) runs *before* delivery (`:248-261`), and that loop drops a failed prompt rather than re-queueing it, rebuilding `pending` next tick. The row idles exactly as it does today, but today's derived path is reproduced on the next render and a reserved one is not. Numbering acquires gaps (`-0`, `-1`, `-3`); A13 does not prune them (pass-3 MINOR 3). |

## Assumptions

**A1 — the legacy fallback keeps today's derivation and is the only derivation left, and the reader
ignores `artifacts.verdicts` unless `verdict_seq` is set.** That second clause is a real narrowing of
a documented read: today `artifactPathFor` honours any recorded key (`src/supervisor/deliver.ts:102`,
`:106`), and after C2 a recorded entry with no `verdict_seq` is invisible. It is safe in production —
`grep -rn "verdicts" src/` shows the only writes are the `{}` initialisers at `src/cli.ts:229` and
`src/lib/ledger.ts:35`, so no record on disk has an entry — but it is the contract, and
`test/deliver.test.ts:156-161` is the test that documented the old one. **It must not be "repaired"
by teaching `verdictFor` to scan the map when `verdict_seq` is absent**: that puts a selection rule
back on the read side and undoes the clarification this pass exists to honour. A record
mid-review at upgrade has `verdict_seq` absent and an agent already writing `…-${counterFor}.md`;
returning `null` would make the freshness gate unsatisfiable and deadlock every in-flight review. The
branch stops being reachable for a row once it next commissions a review.

**A2 — the key comes from `verdict_seq`, the filename from the probe, and they are allowed to differ.**
This is what makes the read a lookup rather than a search, and it is the whole answer to the pass-2
BLOCKER. A reader never learns an ordinal; it learns a key.

**A3 — every value in `artifacts.verdicts` is repo-relative, and `verdictBase` is the single source of
the base.** `src/supervisor/deliver.ts:113` is rewritten to call it rather than keep its own
`task?.checkout_path ?? run.repo_root`, so the expression is not copied to three new sites (pass-2
MINOR 5). `join('/w', '/abs')` → `/w/abs` is the corruption this prevents.

**A4 — `cmdRewind` reserving is a deliberate reading of "reserve at prompt-render time, and only
then".** A rewind onto a review row renders no prompt, so a literal reading leaves the defect open on
exactly the command this issue is about; the ruling's *"where a new review is commissioned"* resolves
it and it separately places my `src/cli.ts` work in `cmdRewind`. Still the assumption most worth
attacking.

**A5 — non-verdict, non-artifact rows keep today's meaningless derived path.** `ci`, `merge`, `close`,
`implement` and the blocked rows resolve to `issue-N-<phase>-0.md` today, which no prompt consumes
(`grep -n "verdict_path" prompts/` lists only the five review prompts). Changing it to `null` is scope
this issue did not ask for and would alter `absoluteArtifactPath` for six rows.

**A6 (rewritten after pass-2 MAJOR 1) — who learns the reserved path, truthfully.** Pass 2 claimed
`src/cli.ts:373` was the only carrier. It is not:

- `cmdRewind`'s success text is where the **human** learns it;
- `src/supervisor/stall.ts:203` renders it into the stall probe (`stallAwaiting` → `{{awaiting}}` at
  `src/supervisor/main.ts:279` → `prompts/stall-probe.md:3`), which is the only thing that
  automatically reaches the **agent**;
- so a rewind onto a review row is **expected to leave the row idle** until the human relays the path
  or the first probe fires at `TASK_STALL_MINUTES` = 45 (`src/lib/config.ts:28`), on a clock that
  `cmdRewind` restarts by re-stamping `phase_entered_at` (`src/cli.ts:355`, rebuilt at
  `src/supervisor/stall.ts:117-121`).

That is the accepted cost of not re-delivering the prompt, not a bug to report later. `hpipe status`
still prints `pass N` from `counterFor` (`src/lib/status.ts:102-105`); the ordinal is not shown there.

**And this is the main path, not an exotic one.** `prompts/escalate.md:15` is the standing
instruction after every 2-pass escalation — `{{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}` —
where `{{phase}}` is `task.escalated_from` (`src/supervisor/tasks.ts:87`), which
`src/lib/machine.ts:92` set to the review row the task escalated *from*. So the documented recovery
from every escalated review is exactly the rewind that leaves the row idle. This task's own history
is that instruction being followed. Live-verification steps 2 and 3 are therefore the primary check,
and step 1 (`rewind … spec`) is the case that is fully automatic.

**A7 — `{{pass}}` and the file ordinal are expected to disagree.** `pass` is
`String(counterFor(task, task.phase))` (`src/supervisor/tasks.ts:54`) and titles every review prompt
(`prompts/spec-review.md:1`). After a rewind or a loop re-entry a review headed *"pass 0"* can be
written to `…-2.md`. Nothing parses `{{pass}}` back, so this is cosmetic — but the reviews are the
audit trail this issue protects, so it is stated: the ordinal is file identity, `{{pass}}` is the
escalation budget (pass-2 MINOR 3). Ordinals may also have permanent gaps, because an undelivered
reservation is still spent — see the error table's last row.

**A8 — the probe is bounded at 64 ordinals**, degrading to the floor filename as the error table says.
It runs inside the supervisor tick; `src/supervisor/deliver.ts:139-148` is the `try`/`catch` that
guards the neighbouring `Bun.spawn` for the same reason (`:130-137` is its explanatory comment — pass-2
MINOR 4).

**A9 — rewind's documented behaviour does not change, so `README.md:100` stays true.** `passes` is
still cleared wholesale; the success text gains a clause.

**A10 — C4's row lookups rely on `cmdRewind`'s existing phase validation** (`src/cli.ts:311-321`). If
removed, C4 needs a throw-safe lookup; `runPhaseState` (`src/lib/ledger.ts:143-149`) is the in-repo
shape.

**A11 — `reserveVerdict` is not idempotent, and the discipline is the call sites.** Calling it twice
for one commission burns a key and a filename. `promptForTaskPhase` is reached only on a real
transition (`src/supervisor/tasks.ts:171-178`), but **`promptForRunPhase` has two callers** —
`src/supervisor/deliver.ts:242` and `src/supervisor/main.ts:217`. The second is currently unreachable:
`runPhaseBefore` is captured at `src/supervisor/main.ts:184` *after* `evaluateRun` mutated `run.phase`
at `:182`. The other `run.phase` writers are three, not two: `src/cli.ts`;
`src/supervisor/stall.ts:371`, whose `stallDeps` block is constructed at `src/supervisor/main.ts:266`,
after `:215`; and **`enterRunPhase` (`src/lib/machine.ts:45-51`), which is the only one that could
fire inside the window this argues about** — it is reached only from `advanceRun`
(`src/lib/machine.ts:58`, `:65`, `:71-72`, `:77`, `:80`, `:82`), `advanceRun` only from `evaluateRun`
(`src/supervisor/deliver.ts:236`), and `evaluateRun` only from `src/supervisor/main.ts:182`, all
before `:184`. Nothing in `advanceTasks`, `deliverPendingAnswers` or `announceDecisions` writes
`run.phase`. Pass 2 named all three and pass 3 dropped one (pass-3 MINOR 2). Named here so a later change to the tick order does not
silently burn a key per tick (pass-2 MINOR 1, which pass 1 raised and pass 2 dropped).

**A12 — the `pr-review-intent` re-entry is fixed silently, and the PR says so.** Same defect, same
blast radius, no extra cost, but a reviewer comparing the issue text to the diff would otherwise find
unrequested behaviour.

**A13 — the map is never pruned.** It grows by one entry per review commissioned; pruning is what
would let a key be re-issued.

## Testing strategy

TDD: the red test first, run it, then the minimum code, run it again.

**The red test** — `test/cli-commands.test.ts`, beside the rewind tests at `:228-239`. Today, after
`cmdRewind(… 'spec-review' …)` clears `passes`, `artifactPathFor` derives
`docs/superpowers/reviews/issue-1-spec-review-0.md` (`src/supervisor/deliver.ts:101-103`), so this
fails. `mkTask` (`test/cli-commands.test.ts:37-47`) defaults `issue: 1` and the file already builds
temp dirs at `:18-25`:

    test('a rewind onto a review row does not re-issue a path an earlier review holds', …)
      // checkout carrying issue-1-spec-review-0.md, verdicts: {}, verdict_seq absent
      // expect(artifactPathFor(run, task)).not.toBe('docs/superpowers/reviews/issue-1-spec-review-0.md')

**Unit — `src/lib/verdict-path.ts`** (new `test/verdict-path.test.ts`, modelled on `test/gating.test.ts`):

- `verdictFor` returns `null` when `verdict_seq` is absent or 0, and the recorded path otherwise.
- **The contract test:** after `reserveVerdict`, `verdictFor` returns exactly what it returned —
  and, unlike pass 2's, it is run **from a map with a gap**: seed `verdict_seq: {'spec-review': 3}`
  with only `spec-review-2` recorded, reserve, and assert the reader agrees. Pass 2's version started
  from an empty map and would have shipped the defect.
- **The `git mv` test, pass-2 BLOCKER 1 made impossible:** reserve against a checkout holding
  `…-0.md`, delete `…-0.md`, reserve again, and assert the **first key still resolves to its original
  filename** and the second reservation did not take `-0`.
- The probe skips an ordinal on disk, and skips one that is already a value in the map.
- Two reservations yield different keys and different filenames; `verdict_seq` only ever increases.
- The bound records the floor filename under the key (A8).
- `verdictBase` returns `checkout_path` when set and `repo_root` when `null` (A3).

**Unit — `src/supervisor/deliver.ts`** (`test/deliver.test.ts`). The A1 fallback keeps `:148-154` and
`:227-232` green: both have empty maps and no `verdict_seq`, so both keep asserting on `counterFor`.

**`:156-161` goes red and is rewritten — pass 3 claimed it stays green and was wrong** (pass-3
MAJOR 1). It seeds `verdicts['branch-review-0']` on a `mkRun()` fixture that never sets
`verdict_seq`, so `verdictFor` takes its `seq === 0` early return, the A1 fallback wins, and the
derived path is returned rather than `custom.md`. The rewrite seeds
`run.verdict_seq = { 'branch-review': 1 }` alongside the entry and is renamed to what it now pins —
*a recorded verdict path is returned for the key `verdict_seq` names*. A companion test asserts the
converse, which is the new contract and is currently untested: **a seeded `verdicts` entry with no
`verdict_seq` is ignored and the A1 fallback applies.**

Also here: a recorded path wins over `passes` entirely, and the run-level reservation uses the
`run_id` prefix from `verdictPrefix`.

**A note on this class of error, because it is now three passes old.** Pass 0 asserted three tests
would move that did not; pass 1 asserted `test/cli-commands.test.ts:228-239` stayed green when its
own seed would have thrown; pass 3 asserted `:156-161` stayed green on a condition the fixture does
not meet. Every one was a claim about a fixture I did not re-read while writing the claim. The
implementer should run `bun test` against each named test **before** trusting any "stays green" line
in this document, and treat the list as a hypothesis rather than a finding.

**Unit — `src/supervisor/tasks.ts`** (`test/tasks.test.ts`): `:301-312` passes today by coincidence of
ordering — it reads `absoluteArtifactPath` before rendering, and `designArtifacts()` (`:242-247`) plus
a non-existent `checkout_path` make both yield ordinal 0. A new test makes the invariant explicit:
render first, then assert `absoluteArtifactPath` equals the path the prompt names (C3's ordering).

**Unit — `src/cli.ts`** (`test/cli-commands.test.ts`): `cmdRewind` reserves and reports for a verdict
row; reserves nothing for `spec`; still clears `passes` (`:228-239` green); leaves `verdict_seq`
untouched by the counter reset; and does not throw when `verdicts` is empty.

Filesystem tests use `tempDir`/`commitIn` from `test/helpers/git-worktree.ts`, as
`test/deliver.test.ts:255-300` does.

**Gates:** `bun test` and `bun run typecheck` green before push, with the measured numbers quoted in
the PR body. Baseline: 503 pass, 0 fail, 1265 expect() calls, 34 files; `tsc --noEmit` exit 0. CI is a
PR-title lint only (`.github/workflows/pr-title-lint.yml`), so these are run by hand.

**Live verification**, required by `.claude/agents/plugin-dev.md` because this changes delivery. The
installed plugin is pinned to a GitHub commit (`herdr plugin list` → `…@be181757…`), so this is not
live until the release lands. After it does:

1. `hpipe rewind <run> spec --task <t>` with `…-spec-review-0.md` and `-1.md` committed: the
   re-rendered prompt names `…-2.md`, the ledger shows key `spec-review-2`, and `-0`/`-1` are
   untouched in `git status`.
2. `hpipe rewind <run> spec-review --task <t>` onto the row, last verdict `CLEAR`: the command's
   output names the reserved path and the ledger agrees. The case no unit test proves end to end.
3. **Immediately after step 2, confirm the row does _not_ advance on its own**, that the first stall
   probe at 45 minutes names the reserved path, and that the earlier verdicts are untouched — A6's
   accepted cost, observed deliberately rather than reported later as a stall bug (pass-2 MAJOR 1).
4. Raise a decision on a task in `spec-review`, answer it with `hpipe answer`, and confirm
   `verdict_seq` and the resolved path **do not move**. This is pass-1 BLOCKER 1, the thing the ruling
   exists to prevent.
5. `hpipe status` still prints `pass N` from the escalation budget, not the ordinal (A6, A7).

Any difference between this runbook and what is observed is a finding, not a test to make pass.

## Rejected alternatives

**A read side that picks among candidates** — pass 2's `recordedVerdict` = "highest ordinal present",
paired with a "lowest free" reserver. Rejected by the clarification and by pass-2 BLOCKER 1: two
selection rules can disagree, and on a legacy or `git mv`'d map they do, which hands the agent one
file and the supervisor another. Aligning the rules would have worked; removing the read-side rule is
better, because it cannot be got wrong later.

**Key on a count of phase entries** (passes 0 and 1). `enterTaskPhase` has callers that are resumes,
so the watched path moves under a live agent — this issue's bug in a new form, and what the ruling
upheld.

**Key on `passes` alone** (today). `hpipe rewind` clears it (`src/cli.ts:353`, `:360`) so the key
regresses, and a `CLEAR` never advances it (`src/lib/machine.ts:117-118`).

**Key on `phase_entered_at`.** Unique per entry, but `enterTaskPhase` re-stamps it on a resume
(`src/lib/machine.ts:94`), so it is exactly as unstable as pass 1's counter.

**Refuse to write an occupied path and stop.** Deadlocks the row: `isFresh` is measured against the
re-stamped `phase_entered_at`, so only an overwrite advances it.

**Reserve on every read.** Makes `artifactPathFor` mutate; it is called every tick from the freshness
check (`src/supervisor/main.ts:193-198`), so the path would advance once per second.

**Teach `hpipe status` the ordinal**, or **make `cmdRewind` re-deliver the prompt**. The first adds a
second number to a line whose `pass N` already means the escalation budget; the second turns a ledger
edit into pane I/O, which is the supervisor's job and arguably #22's scope. A6 records the cost of
declining both.
