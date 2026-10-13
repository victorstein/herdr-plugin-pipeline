# Usage-limit awareness — design

Pass 2. Written against `fix/live-run-bugs` at `bb48694`. It answers findings #13 (rest), #14 and #15 of
`docs/superpowers/notes/2026-10-11-berean-os-live-run.md`, and every finding of
`docs/superpowers/reviews/2026-10-11-usage-limit-awareness-adversarial-1.md` (traced in §11). Effort by tier
(#13, first part) shipped separately on `fix/effort-by-tier`.

## Evidence

On the 2026-10-11 berean-os run, Claude's session limit stopped every agent twice: 10:07–11:20Z and
12:34–16:20Z. The plugin saw both outages only as silence.

- **Each worker went idle on a rejected request.** herdr reported it `done`. Fifty such 429s occurred across 18
  worker transcripts from 2026-09-16 to -30, so this isn't rare. What the screen showed, from the orchestrator's
  `herdr pane read` at 11:21:23Z (text form):

      ⎿  You've hit your session limit · resets 5:20am (America/Managua)
         /upgrade to increase your usage limit.
      ✻ Worked for 0s · done 4:07 AM
      ❯ Still working? — run berean-os-…, phase plan (t1, perf/r20-fast-entry-refresh)
        …
      ⎿  You've hit your session limit · resets 5:20am (America/Managua)
         /upgrade to increase your usage limit.
      ✻ Brewed for 0s · done 4:52 AM
      ❯

  A background reviewer's failure renders differently, as assistant output:
  `⏺ Agent "Adversarial spec review pass 0" failed: … You've hit your session limit · resets 5:20am (America/Managua)`.
- **The stall ladder ran on.** Every probe was typed in and rejected on arrival, yet counted as a rung. The
  3 h 46 min outage escalated t4, t5 and t6 at 15:34–15:39Z.
- **Every delivery to the orchestrator was wasted**: 18 rejections in the first outage, 33 in the second. The gate
  saw them as delivered, because the text *was* submitted.
- **Nothing resumed at the reset.** Both times the orchestrator same-phase-rewound every task (#14), which clears
  `passes`, re-reserves verdicts and writes `manual rewind` history.
- **Claude Code's own auto-continue did not fire**, although `autoContinueAtUsageLimit` is `true` in the user's
  settings: no worker screen shows "continuing automatically". The supervisor has to drive the resume.

Claude Code 2.1.296 (the version that wrote those transcripts) renders the line as
`⎿ You've hit your <label> · resets <when> (<zone>)`, with the `⎿` dim and the text in the error colour.
`<label>` is one of `session limit`, `weekly limit`, `Opus limit`, `Sonnet limit`, `Fable limit`,
`usage credit limit`, `limit`, `usage limit`. `<when>` is a time (`5:20am`) whenever the reset is 24 h or less
away, whatever the label; otherwise a date (`Sep 22 at 3am`), with the year when it differs
(`Jan 2, 2027 at 3:30 AM`). The assistant glyph is `⏺` on macOS and `●` elsewhere.

## Decisions

| | |
|---|---|
| What is limited | a **pane**, detected from its own screen. Not the account, and not the run |
| What counts | the last `⎿ You've hit your …` line above the input box, with no assistant output below it, on a pane herdr reports idle or done (§1) |
| One definition | a pane is limited from the moment it is marked until the lift step (§5) has saved its re-arm. The courier, the stall skip and status all ask the same `UsageLimits.isLimited` |
| Where it is read | a status event for the pane (any pane, the orchestrator's too), the courier's pre-send screen read, a due stall candidate's recipient and actor, and every 2 min for a marked pane (§3) |
| Effect while limited | every send to the pane is held (`held: 'usage_limit'`); stall candidates whose recipient or actor is limited are skipped: no rung, no hold, no escalation |
| Lift | at the reset + 90 s, or early when the pane is seen to move on, or on `hpipe nudge`. One step, before the stall step, re-arms every ladder the pane carries and saves it; only then is the mark removed (§5) |
| Resume | a `usage-resume` prompt only when the worker is provably still where the limit stopped it (§5); otherwise re-arm only. One note to the orchestrator per run, only when something resumed or its own session was stopped |
| State | in the supervisor's memory, persisted in `delivery.<session>.json` so a restarted supervisor keeps when each limit was first seen (§2) |
| Manual | `hpipe nudge --task <id>` / `--all`: queues the same resume, re-arms, and releases the supervisor's hold; changes no phase, passes, verdict or history (§7) |
| Not here | a cap on concurrent workers (needs config the CLI reads; separate PR); staggered wake-ups (spreading the restart doesn't lower total use); probes counted against a busy worker (pre-existing, see §12) |

Rejected, unchanged from pass 1:

- **Reading Claude's transcript JSONL.** It carries the exact error time, but its path depends on
  `CLAUDE_CONFIG_DIR` and Claude's internal layout. The screen is the interface the plugin already depends on.
- **A run-wide or session-wide flag.** Panes can belong to different accounts, and one pane's screen proves
  only that pane is limited. Every pane on the same account hits the limit on its next request anyway.
- **Resuming by re-sending the phase prompt (`owePhasePrompt`).** It restarts the phase from the top, and a
  review phase would dispatch a second reviewer next to the one the limit cut off.

Rejected in pass 2:

- **A time-based `limitedUntil` (pass 1).** It made the pane unlimited a grace period before the resume and
  re-arm, and a task at the top of its ladder escalated in between (B1).
- **Lifting a limit whose reset can't be read after a fixed fallback.** A fallback lift resumes into a pane that
  may still be limited and re-arms a ladder that can then never climb (M4). Such a mark is held until the
  screen moves on or the operator nudges, and status says so.

## 1. Parsing (`src/lib/usage-limit.ts`, pure)

    export interface LimitLine {
      label: string          // 'session limit', 'weekly limit', 'Opus limit', 'limit', …
      when: string | null    // '5:20am', 'Sep 22 at 3am', 'Jan 2, 2027 at 3:30 AM'; null when the line has no reset
      zone: string | null    // 'America/Managua'
      text: string           // the line, trimmed, for logs, status and the notes
    }
    export function limitLineOn(screen: string): { line: LimitLine | null; boxSeen: boolean }
    export function resetAt(line: LimitLine, firstSeenAt: number, localZone?: string): number | null
    export function autoContinues(screen: string): boolean

**`limitLineOn`** takes the screen with its escape sequences removed but its faint text kept (`withoutEscapes`,
new beside `withoutFaintText`): `withoutFaintText` would strip the dim `⎿` this anchors on.

1. Find the input box with the same rule matching `inputBoxText` uses (the frame logic moves to
   `src/lib/screen.ts`, exporting `inputBoxBounds(lines)`; `inputBoxText` is rebuilt on it). No box → `boxSeen:
   false`, `line: null`. The box can hold a human's draft and the status line under it is user-defined, so
   neither may mask or fake a limit.
2. Walk the lines above the box's top rule, from the bottom up:
   - `^\s{0,2}⎿\s+You've hit your (.+?)(?: · resets (.+?))?\s*$` → the limit. If the line opens a `(` it doesn't
     close (a narrow pane wrapped it), the next line is appended first. `when (zone)` splits on the last
     ` (`…`)`.
   - `^[⏺●]\s` → assistant output came after any limit: `line: null`.
   - anything else (blank, `✻ …`, `/upgrade …`, `❯ …` user turns and their continuations, deeper `⎿` tool output)
     → keep walking.

   Quoted copies don't match: tool output nested under a tool call is indented past two spaces, and a background
   agent's failure is a `⏺` line, which ends the walk. A tool result whose own first line is the exact message would
   match, but only if the turn then ended with no assistant output after it, and the caller also requires idle.

**`resetAt`** dates `when` in `zone`, or in the supervisor's local zone when the line has none. It uses `Intl` zone
offsets, two passes for DST, as today. The anchor is when this supervisor lineage **first saw** this pane show this
text (§2), never the time of the current read.

| `when` | Reset |
|---|---|
| time only (`5:20am`, `10pm`, `3:30 AM`) | the first occurrence after `firstSeenAt − 15 min`. For `session limit` only: if that is more than 5 h after `firstSeenAt`, the occurrence before it (already past), because a session window is 5 h |
| date without year (`Sep 22 at 3am`) | the year that puts it nearest `firstSeenAt` |
| date with year (`Jan 2, 2027 at 3:30 AM`) | exact |
| none, unknown zone, or unparseable | `null` |

The 15 min tolerance covers a line first seen just after its own displayed reset, for instance a re-rejection
because the server's reset was a little later than the minute shown. It then dates to the reset just passed, not
to tomorrow.

**`autoContinues`**: the screen shows Claude's own `continuing automatically` notice. The lift then re-arms but
never resumes, since Claude does it.

## 2. State (`src/supervisor/usage-limits.ts`, new)

    interface PaneLimit {
      line: LimitLine
      resetsAt: number | null    // null: unreadable, never lifted by time
      since: number              // first seen
      checkedAt: number          // last reading that confirmed it
      autoContinue: boolean
      release?: 'moved-on' | 'nudge'
    }

    class UsageLimits {
      isLimited(pane): boolean
      get(pane): PaneLimit | undefined
      observe(pane, reading: LimitReading, now): void
      due(now): string[]
      lifted(pane, now): void
      nudge(pane): void
      needsRead(pane, now): boolean
      forgetGone(livePanes): void
      holds(): Record<string, PaneHold>
      snapshot(): PersistedLimits
      revision: number
    }

    interface LimitReading { status: AgentStatus; line: LimitLine | null; boxSeen: boolean; autoContinue: boolean }

**`observe`**, the only way a mark is made, kept or released:

| Pane | Reading | Result |
|---|---|---|
| unmarked | status `idle`/`done`, `line` set, not the pane's `stale` line | mark. `since` is the persisted first sight of this (pane, text), else `now`. If `resetAt` is already more than 90 s past, the line is old: no mark |
| unmarked | anything else | nothing; a reading that is not the `stale` line clears `stale` |
| marked | status `working` | `release = 'moved-on'` |
| marked | `idle`/`done`, `boxSeen`, `line` null | `release = 'moved-on'` |
| marked | `idle`/`done`, `line` with different text | re-mark with the new line (new `since`, new `resetsAt`) |
| marked | same text, or inconclusive (`blocked`, `unknown`, no box, failed read) | confirm: `checkedAt = now` only when it was the same text |

**`stale`** (pane → text) answers M3's "an old line read again is not a new limit". It is set by `lifted` when the
lift was by time or by nudge, the two lifts that leave the line last on screen. It is cleared by the first reading
that shows the pane moved on (working, a different line, or none). So the line that was just lifted is never marked
again. The same text printed *again* after a new rejection is marked, because the delivery that caused the rejection
turned the pane `working` first, and that reading cleared `stale`.

**`due(now)`**: marked panes with `release` set, or with `resetsAt !== null && now >= resetsAt + LIFT_GRACE_MS`
(90 s: the message shows minutes only, and the real reset can be up to 59 s after the displayed minute).

**`lifted(pane, now)`** removes the mark, sets `stale` for a time or nudge lift, bumps `revision` and logs once:
`usage limit in w4:p1 lifted (reset 10:20am (America/Managua)); its ladders restarted`.

**`holds()`** reports `{ code: 'usage_limit', since, failures: 0, until: resetsAt, reset: '<when> (<zone>)' }`.
`DeliveryGate.holds()` merges these in last: a limited pane reports `usage_limit` whatever else is wrong with it,
because nothing else can be fixed while the limit stands. Its stuck or failing state shows again once the mark is
lifted. Every mutation bumps `revision`, and the supervisor's health write checks `gate.revision + limits.revision`.

**Persistence.** `delivery.<session>.json` gains `limits: { [pane]: { text, since, resets_at } }` for live marks
and `stale` lines. At boot the supervisor reads the file whatever pid wrote it, and seeds every mark with
`checkedAt: 0`, so the first tick re-reads each one. `forgetGone` drops panes herdr no longer lists. That is the
whole of M2's restart answer, and it is what keeps `since` anchored on first sight across restarts (M4, m7).

## 3. Reading (`readLimit`, `src/supervisor/usage-limits.ts`)

    readLimit(io, pane, status?): Promise<LimitReading | null>   // null: herdr's read failed ('' screen)

It reads the styled screen (`paneReadStyled`, 40 lines), and the status unless the caller already holds a fresh one.
It runs in four places, so no limited pane goes unread for long:

1. **The limit step**, new, early in the tick (right after events are applied and saved, before wake lines and
   delivery). It reads:
   - every pane with a drained `pane.agent_status_changed` event, any pane including the orchestrator's (read from
     `drained`, not from wake lines, so `applyEvents` dropping orchestrator events (`tick.ts:349`) and skipping
     unchanged statuses doesn't matter). The status comes from the pane's last event in the batch;
   - every marked pane whose `checkedAt` is older than `RECHECK_MS` (2 min), seeded marks included;
   - every pane named by a drained `pipeline.nudge` event (§7), which calls `limits.nudge(pane)` instead.

   Reads run concurrently per pane. Because this step comes before delivery, this tick's digests already see the
   mark, and a wake line about a limited worker reads "paused by Claude's usage limit".
2. **The courier**, which already reads the screen for the input box. `boxHold` reads it once and checks the limit
   first. Only when a limit line is there does it ask herdr for the status, so the common send costs no extra call.
   A mark → `{ ok: false, code: 'usage_limit', held: 'usage_limit' }`, before the stuck-input check and before any
   box clearing. A pane already marked is held before `admit`, without a read, and spends no budget.
3. **The stall step.** `StallDeps.limited(pane)` returns `isLimited(pane)`, or, when the pane was not read in the
   last `FRESH_MS` (60 s), reads it, observes, and answers from the result. Asked for the candidate's `paneId` and
   `actorPaneId`, before the probe and before the escalation's status check. This is what catches a limit no
   event or send revealed, such as the 1.1 s 429 blip that never flipped herdr to `working`, or a supervisor
   restarted after the panes went idle.
4. **The lift step** (§5) reads each due pane once for the resume guard.

## 4. The stall ladder (`src/supervisor/stall.ts`, `main.ts`)

`applyStalls` gets `limited: (pane: string) => Promise<boolean>` in `StallDeps`. A candidate whose `paneId` or
`actorPaneId` is limited is skipped outright: no probe, no hold, no escalation, nothing written. A probe can't be
answered, and an escalation would be a quota pause dressed as a stall.

The probe dep also maps `held === 'usage_limit'` to `deferred: true`, for the race where the courier marks the pane
on the probe's own send.

## 5. The lift step (`liftLimits`, `src/supervisor/usage-limits.ts`; called from `main.ts`)

It runs after delivery has settled and before `savedRuns` is computed for the stall step
(`main.ts:514`). This fixes B1: in any tick, the stall step sees a pane either still marked or already re-armed and
saved.

    for each run in this tick's runs that a due pane touches:
      effect = liftEffect(lifts, rendered)          // pure; applied to the tick's copy, then saved
      outcome = saveOrReapply(stateDir, run, [effect])
      reapplied or thrown → unsaved.add(run)        // the stall step skips the stale copy
    for each due pane: limits.lifted(pane) only if every run it touched saved or reapplied

A throw leaves the mark in place, so the lift is retried next tick (M1). The tick's in-memory copy of a run the
advancing loop could not save is still fine to pass: the save fails stale, and the effect is reapplied to a fresh
read.

Before the effects are built, the step reads each due pane (`readLimit`) and works out `resume` for it:

    resume = release !== 'moved-on'
          && reading !== null && isAgentReady(reading.status)
          && reading.line !== null && !reading.autoContinue

So the pane must still be idle with the limit line last (M5 (b), (c)). It also pre-renders a `usage-resume` text for
each worker task bound to a due pane, and loads the `usage-lifted` template, so the effect itself stays synchronous.

**`liftEffect(run)`**, evaluated against whichever copy it is applied to:

- **Re-arm** every record (the run and each task) whose stall recipient (`probeRecipient`) or actor pane
  (`actorPaneFor`, exported from `stall.ts`) is a lifted pane:
  `stall = { at: phase_entered_at, run_at: run.phase_entered_at, last_probe_at: now, probes: 0, undelivered: 0, holds: 0 }`.
  This is the `bindWorkerPane` literal (`unstarted.ts:177-180`); it drops `undeliverable_since`.
- **Resume a worker** with `pane_id` = a lifted pane, only when every one of these holds; otherwise it is re-armed
  only:
  - `resume` holds for the pane;
  - `taskRow(task.phase).actor === 'worker'`;
  - `task.phase_entered_at <= limit.since`, so the phase didn't change during the limit (M5 (a));
  - `task.phase` equals the phase the text was rendered for;
  - `queuedWorkerPrompt(run, task) === null`: a queued phase prompt restarts it on its own;
  - no current `kind: 'resume'` entry for the task, whether from the supervisor or from `nudge`;
  - `unbriefedWorker(run, task) === null` (M5 (d)).

  `enqueue(run, { to: 'worker', taskId, text, kind: 'resume' })`.
- **Note the orchestrator**, at most once per run per lift, and only if a worker in this run was resumed or the
  orchestrator's own pane was lifted with `resume`. `enqueue(run, { to: 'orchestrator', taskId: null, text })` with
  `usage-lifted.md`:

      # Usage limit lifted — run {{run_id}}

      Claude's usage limit ({{reset}}) has reset.{{own}}{{resumed}}

      Do not rewind them: a rewind restarts a phase from the top. If one is still idle in a few minutes,
      `{{hpipe}} nudge --task <id>`.

  - `{{own}}`: " It stopped your own session too: pick up what you were doing when it hit."
  - `{{resumed}}`: " Told to carry on where they stopped, their stall clocks restarted: t4 (pr-review),
    t5 (pr-review)."
  - The note is keyed to `run.phase_entered_at` (`outbox.ts:44`), so a run transition in the same tick prunes it.
    It is informational, and losing it there is acceptable (m5).

Every send that follows, including the resume itself, still goes through the courier with every guard
(a new limit, stuck input, budget).

`usage-resume.md` (no `{{since}}`, so `nudge` can render it too; m1):

    # Usage limit lifted — {{phase}} ({{task_id}}, {{branch}})

    Claude's usage limit stopped this session, and it has reset. Carry on with `{{phase}}` from where you
    stopped. Do not start the phase over: what you already committed, pushed or wrote stands. If a
    subagent you dispatched was cut off by the limit, dispatch it again with the same brief and the same
    `effort:`, and wait for it within this turn.

## 6. The outbox (`src/lib/outbox.ts`, `types.ts`)

- `OutboxEntry.kind?: 'resume'`. Absent means a phase prompt. `enqueue`'s input takes it.
- `queuedWorkerPrompt` matches only entries without `kind`. All four of its callers want that (m3):
  - PR detection in `implement` (`tasks.ts:318`): a queued resume is not a phase prompt the worker hasn't read, so
    a PR it opened is real;
  - artifact adoption (`tasks.ts:355`): same;
  - the uncommitted-work check (`tasks.ts:78`): same;
  - the handoff text (`unstarted.ts:125`): a resume is not the brief.

  `queuedResume(run, task)` is new, for the dedupe in §5 and §7.
- `pruneOutbox` already drops a resume whose task left the phase (`isCurrent`).

## 7. `hpipe nudge` (`src/cli.ts`)

    hpipe nudge --task <id> | --all

It works under `retryingOnStale`, the same as `rewind`. For each task:

| Refused / skipped | Message |
|---|---|
| not in a worker row | `t4 is in merge, which waits on the orchestrator; nothing to nudge` |
| no pane | the existing `startWorkerCommand`/`dispatchWorkerCommand` advice |
| unbriefed | the existing `briefCommand` advice |
| herdr reads it `working` | `t4's agent is working; nothing to nudge` (`--all` skips it silently) |
| a phase prompt is queued | `t4's pr-review prompt is queued and restarts it; nothing to nudge` |
| a resume is already queued | `t4: a resume is already queued for w4:p1` |

Otherwise it queues `kind: 'resume'` with `usage-resume.md`, re-arms the task's ladder (writing `task.stall` from
the CLI has precedent in `recordWorkerPane → bindWorkerPane`, `cli.ts:785`), and saves. It then writes a
`pipeline.nudge` event (`EventKind` gains it) with the pane id into the session's queue directory, which the
supervisor drains (`main.ts:222`). The supervisor's limit step calls `limits.nudge(pane)`. The lift step then
re-arms again (harmless), finds the resume already queued, and marks the line `stale` so it isn't re-marked
before the resume lands. Output, one line per task:

    t4: resume queued for w4:p1 (pr-review); the supervisor's usage-limit hold on it is released

The clause after `;` appears only when `delivery.<session>.json` shows a `usage_limit` hold on that pane.

`--all` covers every task the table doesn't skip. It touches no phase, `passes`, verdict reservation or history.

The skill's recovery table gains:

| Workers idle after Claude's usage limit | The supervisor resumes them at the reset. If one is still idle a few minutes after, `hpipe nudge --task <id>`. Never `rewind` to the same phase for this. |

## 8. `dispatch --task` (`src/cli.ts`, m6)

Before claiming the bead, it reads the pane (`paneReadStyled`) and its status. If `limitLineOn` finds a limit and the
agent is idle, it refuses without sending:

    the agent in w4:p1 is stopped by Claude's usage limit (resets 10:20am (America/Managua)); nothing was sent — run this again after the reset

## 9. Status (`src/lib/status.ts`, `src/lib/outbox.ts`)

- **`moveFor`, worker row**: a `usage_limit` hold on the task's pane comes **before** `undeliveredPhasePrompt`
  (`status.ts:188`), which would otherwise call it "YOUR move" (m2):
  - `nothing for you — paused by Claude's usage limit, resets 10:20am (America/Managua); the supervisor resumes it then`
  - with `until: null`: `paused by Claude's usage limit, whose reset could not be read; once it has reset,
    \`hpipe nudge --task t4\``. This one waits on you.
- **`deliveryWarnings`** (`outbox.ts:229`):
  - a recipient whose pane holds `usage_limit`:
    `⚠ usage limit in w4:p1: 2 prompts for t4's worker held 37m until it resets (10:20am (America/Managua)) — nothing to do`;
  - in the trailing loop, a `usage_limit` hold with nothing owed:
    `⚠ usage limit in w1:p1 (the orchestrator) for 37m, resets 10:20am (America/Managua) — digests wait for it`.
  - Neither falls through to "never attempted — the supervisor is not reaching delivery".
- A task in an orchestrator row keeps its "YOUR move" clause while the orchestrator is limited. That is still true
  after the reset, and the ⚠ line above it says why nothing is moving.
- `show` prints `paused:     usage limit until 10:20am (America/Managua), since 12:34Z` under `effort:`.

## 10. Tests

- `usage-limit.test.ts` (rewritten):
  - fixtures from the real captures: the 11:21:23Z worker screen, and the 16:21:44Z one with a probe between two
    limit lines;
  - every label in the bundle's table;
  - time-only for a weekly limit;
  - dated with and without a year;
  - a wrapped line;
  - `⏺` and `●` after the line, which mean no limit;
  - a `⏺ Agent … failed: You've hit…` line alone, which is no limit;
  - a draft in the box or a `⏺` in the status line, which neither masks nor fakes one;
  - no box, which reads `boxSeen: false`;
  - the 15 min tolerance;
  - the 5 h session rule either side;
  - a DST change;
  - an unknown zone or no reset, which give `null`;
  - `autoContinues`.
- `UsageLimits`:
  - every row of the `observe` table;
  - `stale` set by time and nudge lifts, cleared by moving on;
  - the same text after a `working` reading is marked again;
  - `due` with and without `resetsAt`;
  - persistence round-trip, a seeded mark re-read on the first tick, and the first sight kept across a restart;
  - `holds()` precedence over stuck and failing;
  - `revision` on every change.
- Courier:
  - a marked pane holds without a read and without budget;
  - a limit line on an idle pane marks and holds before the box is touched;
  - a limit line on a `working` pane doesn't mark.
- Stall:
  - a limited recipient or actor yields no rung, hold or escalation;
  - `limited` reads a stale pane once;
  - B1's scenario: a task at `probes: 3` whose pane's reset has passed is neither probed nor escalated in the lift
    tick, and starts from zero after.
- `liftEffect`:
  - every resume guard alone;
  - re-arm by recipient and by actor;
  - one orchestrator note per run, none when nothing resumed;
  - the effect reapplied to a fresh copy;
  - a thrown save keeps the mark.
- Outbox: `queuedWorkerPrompt` ignores a resume, shown through PR detection in `implement` and through adoption.
- `nudge`:
  - queues, re-arms, and writes the event;
  - leaves `phase`, `passes`, `verdict_seq` and history unchanged;
  - every refusal;
  - `--all` skips working panes.
- `dispatch --task` refuses a limited pane.
- Status:
  - the paused clause wins over `undeliveredPhasePrompt` and idle-with-nothing;
  - both ⚠ lines;
  - `until: null` waits on you.
- **Wiring** (per `project-di-hides-wiring-bugs`). The limit step and the lift step are exported functions that
  `main.ts` only calls. One test drives them in `main.ts`'s order against a real ledger in a temp dir, with a fake
  herdr whose screen and status are scripted:
  1. `agent:done` with the limit on screen marks the pane;
  2. the outbox entry and the probe are held;
  3. the reset passes;
  4. the lift saves the resume and the re-arm;
  5. the next delivery sends the resume.

  A second test restarts in the middle, re-seeding from the health file.
- **Live** (m9): the smoke runbook gains a step for the next real limit, which comes often (50 in two weeks):
  - capture `herdr pane read <pane> --format ansi --lines 40` and `--format text`, plus `herdr agent get <pane>`;
  - check them against the fixtures, and add them.

  Until then the styled fixtures are built from the bundle's rendering (dim `⎿`, error colour).

## 11. Review findings → this design

| Finding | Answer |
|---|---|
| B1 window before the lift | one definition (§2), held until the lift step has saved the re-arm (§5); the lift step runs before the stall step |
| M1 lift lost on a failed save | peek with `due`, `RunEffect` through `saveOrReapply`, mark cleared only on a landed save, `unsaved` on reapply (§5) |
| M2 undetected and restarted | stall candidates read their panes (§3.3); drained status events for every pane (§3.1); persisted marks re-read at boot (§2) |
| M3 trusted blindly, false positives | mark only on idle/done (§2); re-read every 2 min and on every status event, release when moved on (§2, §3); `nudge` releases (§7); anchored match above the box (§1) |
| M4 other forms, day choice, fallback | any label, time-only for any kind, dated with year (§1); dating anchored on persisted first sight (§1, §2); no time lift for `null` (Decisions) |
| M5 blind resume | the guards in §5, plus `autoContinues` |
| m1 nudge | no `{{since}}`; `--all` skips working panes; dedupe both ways (§7) |
| m2 status | paused clause first; both `deliveryWarnings` lines; `holds()` precedence; `revision` (§2, §9) |
| m3 `queuedWorkerPrompt` | resume entries excluded, all four callers named and tested (§6, §10) |
| m4 detection input | unstripped screen, `⎿` anchor, both glyphs, above the box (§1) |
| m5 orchestrator | its events read (§3.1); its own resume in the note; note pruning accepted; no note when nothing resumed (§5) |
| m6 `dispatch --task` | refuses (§8) |
| m7 old line | first sight persisted, the 5 h session rule, `stale` (§1, §2); remaining gap in §12 |
| m8 on-disk | §12 |
| m9 live check | real captures as fixtures now, the runbook step for ANSI (§10) |

## 12. On disk, compatibility, known gaps

- **On disk.** `OutboxEntry.kind`, `PaneHold.until`, `PaneHold.reset` and `DeliveryHealth.limits` are all optional,
  and `pipeline.nudge` is a transient queue event. So no `schema_version` bump and no `phases.ts` change. An older
  supervisor delivers a `kind: 'resume'` entry like any other. An older supervisor drains a `pipeline.nudge` event
  and ignores it (`applyEvents` matches no task kind for it), so `nudge` against an old supervisor queues the resume
  but can't release a hold, which an old supervisor never has. The CLI is updated before a supervisor is restarted
  (`project-plugin-install-doesnt-restart-supervisor`), so an old `hpipe status` never reads a new supervisor's
  `usage_limit` hold.
- **Known gap: a stale line first seen by a fresh supervisor lineage.** For example, a weekly limit's time-only
  line still last on a pane, read for the first time more than 15 min after its reset, by a supervisor with no
  health file. It dates to the next occurrence and holds the pane up to 24 h (a session line: up to 5 h). Status
  shows the hold and its reset, and `hpipe nudge` releases it.
- **Known gap: a reset that can't be read** holds the pane until its screen moves on or the operator nudges. Status
  lists it under "waiting on you" (§9).
- **Pre-existing, not changed here.** Probes are sent to a `working` pane and count as rungs (`stall.ts:523-533`),
  so a worker that stays busy for 135 min reaches the escalate rung, where only the `working` check holds it. The
  lift's re-arm resets that ladder; the general behaviour is a separate question.

## 13. After the pass-2 review

`docs/superpowers/reviews/2026-10-11-usage-limit-awareness-adversarial-2.md` found the design CLEAR, with 2 majors and 8 minors.
The implementation answers them as follows. Where this section and §1–§12 disagree, this section holds.

| Finding | Answer in the code |
|---|---|
| M1 `stale` never cleared | `UsageLimits.noteActivity` runs for every `working` event in a drained batch, not only the last, and for every prompt herdr confirmed (`makeCourier`). It clears `stale`, so a resume rejected again is marked again. A marked pane seen working and then stopped on the same line stays limited |
| M2 fifth `queuedWorkerPrompt` caller | `status.ts` reads a queued resume like a queued phase prompt (`undeliveredWorkerPrompt`): "nothing for you — its resume after Claude's usage limit is queued for …", or "YOUR move" only when it is held or failing. Tested through `parkedFooter` |
| m1 `nudge` without a limit | `nudge` needs the limit line still on the pane or the supervisor's `usage_limit` hold, and refuses otherwise |
| m2 15 min tolerance | A line read within 15 min of the pane's last activity is fresh, dated with a 1 min tolerance, so a reset just under a day away is tomorrow's. A line with no such evidence keeps the 15 min tolerance |
| m3 rendered forms | Parsed by segment, from the 2.1.296 bundle: `You've hit your <label>` then `· resets <when>`, `· your <limit> resets <when>` (team and org budgets, dated by the named limit), `· progress saved`. The credit blocks `You've reached your …` and `You're out of …` count too. A wrap at any space or inside the zone is joined. The year form `Jan 2, 2027 at 3:30am` parses. Fixtures are the captures with their blank lines and box rules rebuilt. §1's reason was wrong: a tool result's first line is also two columns in, and the idle requirement is what rules it out |
| m4 auto-continue | Read in the same walk from the last notice below the limit line: armed only if that notice is `continuing automatically` (any case). A cancelled or finished wait counts as not armed. Still uncaptured: whether these notices start with `⏺`, and what herdr reports for an armed wait. The runbook's §4d.5 records both |
| m5 the lift's runs | `liftLimits` reads every driven run from disk, not the tick's copies, and saves those. A run that sat out the tick is re-armed, and a run whose advancing threw is not saved with half-done changes. The tick's copies of the runs it touched sit out the stall step |
| m6 read cost | Re-reads are scheduled from the last reading, conclusive or not. Only panes that belong to a run are read. A pane whose last event is `working` is not read. `forgetGone` ignores an empty pane list |
| m7 persisted record | `delivery.<session>.json` keeps `limits.marks` and `limits.stale` apart |
| m8 `dispatch --task` | Kept for a pane reused by a rewind. A fresh agent's brief rejected by the limit is recovered by the resume: the brief is the last thing in its context, and "carry on" acts on it |

Also changed from §9: `hpipe show` prints no `paused:` line, because it does not read the supervisor's holds. `status` and the digest
carry the clause.
