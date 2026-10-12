# Review: usage-limit awareness design (pass 2)

Pass 2 closes the blocker. The lift step now runs before the stall step, and nothing changes the one definition of "limited" until the
re-arm is saved. A probe against the real `taskStallCandidates` confirms the B1 scenario no longer escalates. Two new majors need design
changes before planning:
- **M1.** The `stale` guard is never cleared in the flow it was written for. After a nudge, or a time lift that comes too early, a pane
  rejected again with the same text is never marked again.
- **M2.** `queuedWorkerPrompt` has a fifth caller that the design misses. Because of it, the first digest the orchestrator gets after
  the reset says "YOUR move" for every worker that was just resumed.

**Setup**
- The design was read at `12ca17c` on `feat/usage-limit-awareness`. The code is the same commit: `bb48694` plus the parser commit `a459508`.
- Baseline in a `git archive` copy: `bun test` gave `1431 pass, 0 fail`, and `bun run typecheck` was clean.
- Probes are in `scratchpad/review2/repo/test/zz-review2-probe.test.ts`, 8 tests, all passing. Each one calls the real functions and
  checks what the finding below claims.

**Evidence from outside the repo**
- The Claude Code 2.1.296 bundle, read with `strings` (`/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude`). It contains:
  - the reset formatter `$R`;
  - the limit messages `Vw`;
  - the auto-continue strings `ft`.
- The orchestrator transcript `ee8ac7a1-….jsonl` holds two `herdr pane read` captures: 11:21:22Z (`wD:p1`, `wE:p1`) and 16:21:41Z
  (`wG`/`wH`/`wJ`).

## Pass-1 findings

| Finding | State | Notes |
|---|---|---|
| B1 | closed | Lift before stall with one definition holds. P3: the re-arm literal turns the due `escalate` candidate into no candidate in the lift tick, and into `probe` at probe 0 once 45 min have passed. One gap is left (m5). |
| M1 | closed | Peek, `saveOrReapply` with a `RunEffect`, and keeping the mark on a throw all match `ledger.ts:138-162`. The claim about the advancing loop's copy is wrong for one case (m5). |
| M2 | closed | Drained events for every pane, a read for each due stall candidate, and seeded marks at boot. |
| M3 | closed | The `stale` mechanism added to answer it is broken in practice (M1). |
| M4 | mostly closed | Covered: every label, time-only for any kind, the year form, first sight, no time lift on `null`. Still open: the 15 min band (m2) and the rendered forms (m3). |
| M5 | closed | Covered by the guards. `autoContinues` is underspecified (m4). |
| m1 | partly closed | `--all` still reaches idle workers that were never limited (m1). |
| m2 | partly closed | Correct while the pane is held. Wrong in the tick after the lift (M2). |
| m3 | not closed | It names four callers; there are five (M2). |
| m4, m5, m7, m8 | closed | m7's leftover gap is stated in §12. |
| m6 | closed on paper | The guard cannot fire in the case that actually happens (m8). |
| m9 | partly closed | The "real captures" were filtered when they were taken (m3). |

## What holds up

- **The tick order is sound.** In order: limit step after `saveEventedRuns`, before wake lines and delivery; lift step after the delivery
  settle; stall step on `savedRuns` (`main.ts:514`). Because of this, every digest, footer and stall evaluation in a tick sees one state of
  the mark.
- **`pipeline.nudge` is safe on today's supervisor.**
  - P2 sends an unknown kind carrying a task's `pane_id` through the real `tickEvents`, `applyEvents` and `readyPanes`. The result is
    `{changed: false, wake: []}`, and the run is byte-identical.
  - The CLI already builds the supervisor's queue path, `join(ctx.stateDir, 'queue', ctx.session)` (`cli.ts:1366`, `:1520-1523`).
  - The event must carry `session: ctx.session`, because `applyEvents` drops any event from another session (`tick.ts:348`).
- **The bundle confirms the parsing premises.**
  - The label table `aoe` matches the design.
  - Time-only when `i <= 24` hours from the moment the line is rendered, otherwise the date form.
  - The formatter is fixed to `en-US` with `hour12: true`, so the output does not depend on the user's locale.
  - The zone suffix is always present for the `RA(b, !0)` call.
- **The real screens fit the walk.**
  - In `wE:p1` the `⏺ Agent "…" failed: … You've hit your …` line sits above the `⎿` line, so the bottom-up walk stops at the `⎿` first.
  - The 16:21Z panes show `❯ Still working? …` between two `⎿` limit lines.
  - The status lines (`[Opus 5.5 …] │ Ctx …`, `⏵⏵ bypass permissions …`) are below the box.
- **`withoutFaintText` really does drop the `⎿`** (P6), so the new `withoutEscapes` is needed.
- **The on-disk claims hold** in the direction that actually happens. After an upgrade the CLI is new and the supervisor is old
  (`bin/hpipe` resolves the installed copy at call time). No `phases.ts` or `schema_version` change is needed.

## Findings

### M1 — MAJOR: `stale` is cleared only by a reading the supervisor never takes, so the same text after a nudge or time lift is never marked

**The claim.** §2 says: "The same text printed *again* after a new rejection is marked, because the delivery that caused the rejection
turned the pane `working` first, and that reading cleared `stale`." §10 tests exactly this against `UsageLimits` alone.

**What the wiring does.**
- The resume is sent in tick N+1's delivery. herdr's `--until working` confirms it (`herdr.ts:137-144`), and Claude answers with a
  429 about 1 s later.
- The hooks queue `working` and then `done`. Tick N+1 still has its lift step, beads sync, board upkeep and stall step to run, then
  `Bun.sleep(TICK_MS)`. So tick N+2's `drain` (`queue.ts:30-52`) reads both events.
- §3.1 says: "The status comes from the pane's last event in the batch." P4 drains a real queue holding that pair, and the last event
  per pane is `done`.
- The reading is therefore `done` plus the stale text, which matches neither "mark" nor "clears `stale`".
- The courier's later pre-send reads and the stall step's `limited()` see the stale text too, and answer "not limited".
- The courier's confirmed send is the one point that knew the pane went `working`, and it is not fed to `observe`.

**When this happens.**
- An early `hpipe nudge`. §9 itself invites one: for `until: null` (a monthly spend limit, a team budget, or an unparsed line) status
  says the line "waits on you" and offers `hpipe nudge --task`. A human impatient during a 3 h 46 min outage would do the same.
- A time lift while the server still rejects requests.

**What follows, for the rest of the outage.**
- The pane is unmarked and its ladder re-armed. Probes go in and count as rungs, and an outage longer than about 2 h 15 min left after
  the nudge escalates (the t4–t6 outcome).
- The resume has been used up, so nothing resumes the pane at the real reset.
- A stalled send is retried into the limited pane at backoff cadence.

**Fix.**
- Clear `stale` on any `working` event for the pane anywhere in the drained batch, and on any courier send to the pane that herdr
  confirmed. Equivalently, record `liftedAt` and treat a limit line read after a confirmed send or a `working` event as new.
- Make §10's wiring test deliver the rejected resume as one batch `[working, done]`.

### M2 — MAJOR: the fifth `queuedWorkerPrompt` caller turns the wake-up digest into "YOUR move" for every resumed worker

**Five callers, not four.** §6 says "All four of its callers want that" and lists `tasks.ts:78`, `:318`, `:355` and `unstarted.ts:125`.
The fifth is `undeliveredPhasePrompt` (`status.ts:89`), behind `moveFor` at `status.ts:188`. If it ignores a queued resume, it falls
through to the clauses that follow:
- `status.ts:194`: `YOUR move: worker idle with nothing at <path>`;
- `status.ts:197`: `YOUR move: worker idle with N uncommitted paths — have it commit and push`.

**Both records are set during every limit.** The pane is `done`, so the `research`/`spec`/`plan` branch re-sets `artifact_missing` every
tick (`tasks.ts:330`, `:367`). `noteUncommittedWork` records `uncommitted_work` for a worker cut off mid-`implement`.

**The tick after the lift.**
- Tick N lifts the hold and queues the resumes.
- Tick N+1 renders the orchestrator's catch-up digest (`main.ts:420`) and the footer the lift note carries (`main.ts:379`, `:419`).
- Both are rendered before that flush delivers the resumes.

**Probed.** P1 runs the real `actionFor` and `parkedFooter`.
- With the entry visible: `nothing for you — its plan prompt is queued for w7:p1`.
- With it filtered: `YOUR move: worker idle with nothing at /wt/docs/plans/p.md (its branch added no document to adopt)`.
- The footer gives `also waiting on you: - t1 … YOUR move: worker idle with nothing at …`.

That is the 11:21Z misread from finding #13 of the live-run notes. It lands at the moment the orchestrator wakes, beside the note that
says "Do not rewind them". The orchestrator in the incident answered exactly this with rewinds.

**Fix.**
- Name `status.ts:89` in §6.
- Give a queued resume its own clause, for example `nothing for you — resumed after Claude's usage limit; its resume is queued for
  w4:p1`.
- Test it through `catchUpDigest` and `parkedFooter`, not only `actionFor`.

### MINOR

**m1 — `nudge` acts without any evidence of a limit.**
- `--all` skips only panes herdr reads as `working` (§7). A review-phase worker that is waiting idle on its background reviewer reads
  `done`.
- Such a worker is told "Claude's usage limit stopped this session … If a subagent you dispatched was cut off by the limit, dispatch it
  again". That is the second-reviewer harm §Decisions rejects `owePhasePrompt` for.
- #14 asked for a general wake-up, so the orchestrator will reach for this command in exactly that situation.
- **Fix.** Refuse unless the pane's screen shows a limit line still last (the CLI reads it anyway for §8), or the health file shows a
  `usage_limit` hold.

**m2 — The 15 min tolerance misses fresh lines in both directions.**
- **A fresh weekly limit is missed.** Claude renders time-only whenever the reset is within 24 h of the rejection. P5a: a weekly limit
  hit at 10:05 that resets tomorrow at 9:55 dates to today's 9:55, 10 min before first sight, so it reads as an old line and is never
  marked. That is a full day of today's failure: probes, then escalation. Any limit other than the session one whose reset is 23 h 45 m
  to 24 h away is exposed.
- **A re-rejection right after a reset is left unmarked.** The case §1 cites is a re-rejection just after the reset. The rule dates that
  line to the reset just passed, so it too is left unmarked, with its resume already spent.
- **Fix.** Use the evidence the supervisor already has. A line first read on the same batch as a `working`→`done` pair, or right after
  a confirmed send, is fresh, and takes the next occurrence. Apply the tolerance only to a line with no such evidence.

**m3 — Rendered forms and fixtures.**
- **The year form is `Jan 2, 2027 at 3:30am`, not `… 3:30 AM`.** `$R` lowercases with `/[  ]([AP]M)/i`; Bun 1.3.14 prints
  exactly that. `3:30 AM` never appears.
- **Team and org limits render as `… · your session limit resets 5:20am (…)`** (`Vw`). §1's regex reads that as `when: null`, which
  holds the pane indefinitely.
- **A line wrapped before `(`** is not joined, because the line has no unclosed `(`. P5b: wrapped after `resets`, the parse gives the
  label `session limit · resets` and `when: null`. That needs a pane under about 49 columns.
- **A tool result's first line is not "indented past two spaces".** It renders as `  ⎿  …`, at the same depth as the limit line. The
  next sentence of §1 covers the consequence, but the stated reason is wrong.
- **The "real captures" were filtered.** They were taken with `grep -v '^\s*$' | grep -v '───' | tail -22 | cut -c1-180`, so they have
  no box rules and no ANSI. P7: the real `inputBoxText` returns `null` on them. As fixtures they read `boxSeen: false`, so their box
  rules have to be rebuilt, and the runbook capture must be raw.

**m4 — Auto-continue is specified against a rendering nobody has captured.**
- The bundle's armed flow appends transcript notices after the limit:
  - `Usage limit reached · continuing automatically {when} · esc to cancel`;
  - the `waiting` variant, capitalised: `Continuing automatically …`;
  - `Usage limit has reset · press enter to continue`;
  - `Automatic continue cancelled …`.
- The armed flow also shows an `esc to cancel` status.
- A case-sensitive `continuing automatically` match misses the `waiting` variant.
- An unanchored match still fires after a wait that went stale or was cancelled. The resume is then skipped although Claude never
  continued.
- Whether these notices start with `⏺`/`●`, which ends the walk and leaves the pane unmarked, is unknown. So is whether herdr reads the
  armed wait as `working`, in which case nothing is marked and probes count.
- The setting defaults on when absent (`RSn`). The feature is gated on the server side, so this rendering can appear without any change
  on this side.
- **Fix.**
  - Decide `autoContinues` in the same bottom-up walk, from the last armed or reset notice.
  - Capture an armed pane in the runbook.
  - State what the supervisor does if the armed wait reads `working`.

**m5 — The lift step's set of runs.**
- **A run that sits out the tick.** "Every run it touched" is drawn from this tick's `runs`. A run that `saveEventedRuns` dropped after
  two lost saves (`tick.ts:505`) is not in `runs`, so the pane is lifted without that run being re-armed. On the next tick it comes back
  with its old ladder at the escalate rung: B1 again, in a corner.
- **A run whose advancing threw.** §5 says the advancing loop's unsaved copy "is still fine to pass: the save fails stale". That holds
  only for `unsaved`. A run whose advancing threw a generic error (`main.ts:414`, for instance a `render()` throw after `advanceTasks`
  moved phases) is in neither set, and its copy saves cleanly with its half-done changes. This already happens in the stall step's
  `persist`; the lift adds a second writer.
- **Fix.**
  - Compute the runs bound to a due pane from disk, or keep the mark when any of them is missing from `runs`.
  - Add the generic-catch run to `unsaved`.

**m6 — Read cost and pruning.**
- A marked pane whose readings stay inconclusive never advances `checkedAt`: no box, `blocked`, an `/exit`ed agent, a failed read. It is
  therefore re-read on every tick (1 s) for as long as it is marked. Keep a `readAt` separate from `checkedAt`.
- The limit step reads the screen for every status event, including:
  - `working` events on unmarked panes, where the status alone answers;
  - panes that belong to no run, such as the human's own Claude panes.
- The steady-state cost is otherwise small: one concurrent `pane read` per event-bearing pane.
- `forgetGone(livePanes)` must ignore an empty list, as `beginTick` does (`courier.ts:331-334`). Otherwise one failed `pane list` drops
  every mark, every first sight and every `stale` line.

**m7 — The persisted `limits` entry cannot tell a mark from a `stale` line.**
- §2 persists live marks and `stale` lines in one `{ text, since, resets_at }` per pane, then "seeds every mark" at boot.
- Without a `kind`, a restart turns a lifted line back into a mark. That re-arms a ladder that may have been climbing for a real stall,
  and holds the pane for a tick.

**m8 — The `dispatch --task` refusal (§8) cannot fire where it matters.**
- A freshly started agent has made no request, so it shows no limit line.
- The real case is different: the brief is typed into a fresh agent on a limited account, rejected, recorded as delivered, and
  `awaiting_brief` is cleared (`cli.ts:784-785`). The lift's resume then tells it to "carry on … do not start the phase over" with the
  rejected brief as its only context.
- Say that this is the intended recovery, or render the resume differently when the phase prompt was never answered.

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 2
MINORS: 8
