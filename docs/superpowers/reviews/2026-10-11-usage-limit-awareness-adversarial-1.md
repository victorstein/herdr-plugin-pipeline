# Review: usage-limit awareness design (pass 1)

The design has one blocker: when a limit lifts, any task already at the top of its stall ladder escalates at the
reset minute. That is the t4–t6 outcome from the incident, just moved to 16:20Z. Five more gaps need design changes
before it can ship.

**Setup**
- The design was read from `feat/usage-limit-awareness`, against code at `3389164`.
- Baseline: `bun test` gave `1402 pass, 0 fail`.

**Evidence from outside the repo**
- The installed Claude Code 2.1.296 bundle, read with `strings`. This is the version that wrote the 2026-10-11
  transcripts: the 429 record carries `"version":"2.1.296"` and `apiError:"usage_limit_reached"`.
- The berean-os worker transcripts.
- The orchestrator's own `herdr pane read` capture of a limited worker, at 11:21:23Z.

## What holds up

- **A held send leaves its outbox entry untouched.**
  - `flushDeliveries` returns before settling a held send (`src/supervisor/courier.ts:719`).
  - A held answer doesn't spend `delivery_attempts` (`src/supervisor/tasks.ts:556`). `announceDecisions` simply
    retries (`tasks.ts:586`).
  - A held orchestrator digest marks a catch-up as owed, because `courier.ts:718` runs before the held check. That is
    the right outcome.
  - `pruneOutbox`/`isCurrent` drop an entry only when its record's `phase_entered_at` moves
    (`src/lib/outbox.ts:12-14, 55-60`). That is the drop you want for a resume entry, and nothing else drops one.
- **Every supervisor send goes through the one `send = makeCourier(...)`** (`src/supervisor/main.ts:205`):
  - outbox entries, digests and catch-ups (`main.ts:422`);
  - answers and decisions (`main.ts:355`);
  - probes (`main.ts:210, 495`);
  - escalations, which are queued to the outbox (`main.ts:509-511`).

  `checkSubmission` only reads. The only path that bypasses the courier is the CLI's `dispatch --task` (m6).
- **The ladder pieces fit.**
  - The re-arm literal matches `bindWorkerPane` (`src/lib/unstarted.ts:177-180`).
  - It omits `undeliverable_since`, so a streak that was frozen during the limit is cleared.
  - A `usage_limit` hold resets `boundedProbeSend`'s deferral count (`courier.ts:264-265`).
  - Skipping a candidate writes nothing, so `stallStateFor`'s stamps are never disturbed.
- **Status plumbing works as described.** `hpipe status` learns about holds from `delivery.<session>.json`
  (`cli.ts:15` → `observePanes` → `readPaneHolds`). `until` survives because `readPaneHolds` passes `health.panes`
  through raw (`src/lib/delivery-health.ts:52-54`).
- **Rejecting `owePhasePrompt` for resume is right.**

## Findings

### B1 — BLOCKER: the lift isn't atomic, and a task at the top of its ladder escalates at the reset

**The window.**
- §2 says `limitedUntil` is "Null once now >= until".
- §2 also says `expiredLimits` returns an entry only once `until + grace` has passed.
- §4's `limited(pane)` has nothing to ask but `limitedUntil`.

So for 60 ticks after `until` (`TICK_MS: 1000`, `src/lib/config.ts:29`), stall candidates are no longer skipped and
the courier sends again. The resume hasn't happened yet.

**Busy workers reach the escalate rung on their own.**
- Probes are sent whatever the agent's status (`src/supervisor/stall.ts:509-519`).
- Only the escalate action checks for `working` (`stall.ts:521-528`).
- Nothing resets `probes` except a new phase entry (stamps, `stall.ts:142-153`) or a pane bind.

So a worker that stays busy through any phase longer than 135 min climbs to the escalate rung.

**Probed.** A scratch test (since deleted) drove `taskStallCandidates` and `applyStalls` over a `pr-review` task:
- With the pane kept `working` for 190 min, the ladder ended at `{"probes":3,"holds":1}`, with probes at 45, 90 and
  135 min.
- The first evaluation with the pane `done`, 226 min later, escalated the task (`ESCALATE@417m`).

**What the design does with that.** Inside the window:
1. The candidate is due (`stall.ts:76`) and its action is `escalate` (`stall.ts:82`).
2. herdr reports `done`, so `escalate()` runs.
3. 60 s later the resume step finds the task in `escalated` (actor `human`) and skips it.

That is t4–t6 again, at 16:20Z instead of 15:34Z. Probes and held prompts also go out during the window. They land in
a pane whose real reset can be up to 59 s after the displayed minute, because `$R` prints minutes only and `resetsAt`
is in epoch seconds.

**Fix.**
- Use one definition of "limited" for the courier, the stall skip and status, and hold through `until + grace`.
- Run expiry, resume and re-arm in the same tick, before `applyStalls` (`main.ts:515`). No evaluation should ever see
  a pane that is neither limited nor re-armed.

### M1 — MAJOR: the expiry is consumed before the save, and the save discipline is unspecified

**The problem.**
- `expiredLimits` "removes and returns" (§2) before anything is persisted.
- "Both are queued in the same save" doesn't say which save, or which concurrency discipline.
- After delivery, each run is in one of two states. Either it is in `unsaved` with a stale in-memory copy
  (`main.ts:402, 437`), or it has been saved.
- A plain `saveRun` loses to a CLI write with `StaleRunError`.
- `saveOrReapply` with no effects rethrows (`src/lib/ledger.ts:145`).

**Consequence of a lost save.**
- The resume and the re-arm are gone for good.
- Nothing re-marks the pane, because the screen now shows a reset in the past and §1 reads that as "resumable now".
- The same tick's `applyStalls` sees an unlimited pane with its old ladder, which is B1 again.

**Fix.**
- Peek at the expiry first, and commit it only after the save.
- Fold the resume into the settle save at `main.ts:425-444`, as a `RunEffect` passed to `saveOrReapply`. Drop the
  `continue` at `:430` when a resume is due.
- Guard the effect on all of these: the same `phase_entered_at`, the same `pane_id`, and no current resume entry
  already queued.
- Clear the gate entry only on `saved` or `reapplied`. Keep `unsaved.add(run)` on `reapplied`, so the stall step skips
  the stale copy.

### M2 — MAJOR: undetected limits still escalate, and a restarted supervisor doesn't re-detect them

**Escalation never reads a screen.**
- The escalate branch asks herdr for status only (`stall.ts:521-530`).
- Whether a candidate is skipped depends entirely on the gate's in-memory map.
- That map is filled only by a courier send or a wake line.

**Why "a restarted supervisor re-detects from the screen" doesn't hold.**
- After a restart the map is empty.
- An idle, limited worker with nothing owed to it is never read. Its escalate-rung tasks escalate (as in B1), and
  nothing resumes it at the reset.
- Restarts during an outage are realistic: installing the plugin doesn't restart the supervisor, so people restart it
  by hand.

**Wake detection is narrower than it looks.** A wake line needs all three of these:
- a *change* of status (`src/supervisor/tick.ts:443`);
- a status listed in `WAKE_ON` (`tick.ts:451`, configurable at `config.ts:30`);
- a pane that isn't the orchestrator's (`tick.ts:349`).

**Transcript case.** In the 2026-10-11 transcript, a worker sat idle while its background reviewer ran. Its
notification-triggered request went from 10:13:43.712Z to the 429 at 10:13:44.861Z, about 1.1 s. If herdr never
reports `working` for that blip, the status stays `done` and no wake line fires. That is the `pr-review` pattern of the
tasks that escalated in the incident.

**Fix.**
- `limited(pane)` should read the actor's screen whenever the gate has no fresh reading, for both probe and escalate
  candidates (at most once per pane every few minutes).
- Detect from the drained `agent_status_changed` events, not from wake lines.

### M3 — MAJOR: once marked, a limit is trusted blindly until `until`, and nothing can clear it

**Nothing touches the mark before `until`.**
- `makeCourier` holds on `limitedUntil` "without reading the screen" (§2).
- `hpipe nudge` queues through the same gate, so its entry is held too.
- Restarting the supervisor re-reads the same screen and marks the pane again.

**Early lift.** Claude's own rate-limit menu invites lifting a limit early. The strings include "Upgrade your plan",
"Add funds to continue with", `tengu_rate_limit_options_menu_select_extra_usage` and `…select_low_priority`; the 429
itself carried `lowPriorityOffer`. A `/model` switch also escapes a per-model limit. After any of these, the run stays
held for up to 5 h (days for a weekly limit), with its stall ladder off.

**False positives.** The regex isn't anchored to how the real line is rendered. Across `~/.claude/projects`, the exact
string turns up as quoted text:
- in failure summaries of background subagents: "…resets 5:20am (America/Managua) (error type rate_limit, HTTP 429…)";
- in this design's own text, inside an agent's transcript;
- in the orchestrator's pane reads of workers.

Two concrete paths:
- A read taken mid-turn, before the next `⏺` appears, marks the pane.
- An agent's final message that quotes the line in an indented continuation marks the pane even at idle, because the
  only `⏺` is above the quote.

A worker on this very repo that `cat`s the new test fixtures between 5:20 and 10:20 local would be held until 10:20.

**Fix.**
- Mark a pane only when `isAgentReady` (`src/lib/machine.ts:30`).
- Re-check a mark on every status event for that pane, and at least every few minutes. Clear it when the line is gone
  or followed by assistant output.
- Let `nudge` clear a mark through the queue directory the supervisor already drains (`main.ts:222`).

### M4 — MAJOR: Claude Code 2.1.296 renders forms that §1 can't parse

**(a) Weekly time-only.**
- `$R` prints the time-only form whenever the reset is 24 h or less away, whatever the kind. The code is
  `if(n||i>24){…month:"short",day:"numeric"…}`, else `toLocaleTimeString`.
- So in its last day a weekly limit reads `You've hit your weekly limit · resets 10pm (America/Managua)`.
- Seen 12 h before the reset, the window `(seenAt−19h, seenAt+5h]` picks yesterday's 10pm. That is in the past, so the
  pane reads "resumable now" and nothing is held for up to 19 h.
- If the parser instead requires the date form for `weekly`, the line is unparseable and gets the 30-min fallback. A
  limited pane isn't re-read while it's marked (§2), so every fallback expiry sends a resume into a still-limited pane
  and re-arms the ladder. That's about 48 wasted prompts a day, and the ladder can never escalate.

**(b) Cross-year date.** When the reset falls in another year the date form gains a year: Bun formats it as
`"Jan 2, 2027 at 3:30 AM"`. `Mon D at h` doesn't accept that.

**(c) Other labels.** The bundle's label table is
`aoe={five_hour:"session limit",seven_day:"weekly limit",seven_day_opus:"Opus limit",seven_day_sonnet:"Sonnet limit",seven_day_overage_included:"Fable limit",overage:"usage credit limit"}`.
There are also `at("limit",…)` and `at("usage limit",…)`.
- Which form renders depends on the response headers.
- With `overageStatus:"rejected"` the code takes `at("limit",R,…)` ("You've hit your limit · resets …") unless an
  earlier branch catches it.
- On 2026-10-11 the earlier branch did catch it, only because `overageDisabledReason:"org_level_disabled"` was set (the
  `rate_limit_info` on the 429 record).
- The `(session|weekly)` regex misses every other form, and so does the whole design, which then falls back to today's
  failure.

**Fix.**
- Match `You've hit your (.+?) · resets (.+?) \(([^)]+)\)` on the rendered line shape (see m4).
- Choose the day by the *format* of the time, anchored on when this supervisor first saw that pane and text, not on
  `seenAt`. A time-only form means the next occurrence within 24 h of first sight.
- Never resume on a fallback expiry: re-read the screen and mark again instead.

### M5 — MAJOR: the resume is sent blind

§5 queues a resume for every expired worker pane in a worker row. Four cases break that:

- **(a) The phase changed during the limit.**
  - PR detection moves `implement → pr-review`; red CI moves `ci → implement` with `ci-red`. Both queue a fresh phase
    prompt, which is delivered at `until` (B1).
  - The resume then lands on top: "Do not start the phase over… If a subagent you dispatched was cut off by the limit,
    dispatch it again."
  - That is the second-reviewer harm the design cites when rejecting `owePhasePrompt`.
- **(b) Claude Code may already have continued.** 2.1.296 has its own auto-continue at the reset. The strings include
  "Usage limit reached · continuing automatically {when} · esc to cancel", "Wait here, then continue automatically when
  the limit resets", "Press ⏎ to continue after reset" and `tengu_rl_checkpoint_auto_continue_queued`. It's
  server-flagged or user-armed.
- **(c) A human or the orchestrator has already continued the pane.**
- **(d) An unbriefed worker would take the resume as its first instruction.** That is the #105 harm `owedABrief`
  exists to prevent (`stall.ts:56-62`).

**Fix.** Send a resume only when all of these hold; otherwise re-arm only.
- `task.phase_entered_at <= limit.since`;
- no current phase entry is queued for the task;
- `unbriefedWorker` is null;
- the agent is idle, and the limit line is still its last transcript activity.

### MINOR

**m1 — `hpipe nudge`.**
- The CLI has no `{{since}}`. That value lives in supervisor memory or in `delivery.<session>.json`, and `render()`
  throws on an unresolved token (`src/lib/render.ts:11`). Say where nudge gets it, or drop the token.
- `--all` resumes workers that are busy and were never limited. Limit it to idle panes.
- Dedupe both ways against the supervisor's own resume entry.
- Otherwise the CLI already has what it needs: `enqueue` (`cli.ts:29`), `retryingOnStale` (`cli.ts:59`) and the run
  resolver.
- Writing `task.stall` from the CLI is safe and has precedent (`recordWorkerPane → bindWorkerPane`, `cli.ts:785`). A
  concurrent supervisor bump replays on top of the re-arm through `stallEffectFor`, which is acceptable.

**m2 — Status placement.**
- The paused clause must come before `undeliveredPhasePrompt` (`src/lib/status.ts:194`). That function returns
  "YOUR move: its X prompt has not reached…" for *any* hold (`status.ts:106`), so a limited worker would show up under
  "waiting on you" and in the digest footer.
- The ⚠ block isn't in `status.ts`; it is `deliveryWarnings` in `outbox.ts:229-298`.
  - A `usage_limit` hold with nothing attempted falls through to "never attempted — the supervisor is not reaching
    delivery; check its pane" (`outbox.ts:277-279`).
  - A hold with nothing owed prints nothing, because `outbox.ts:289-296` handles only `stuck_input`.
- Specify how `holds()` ranks a pane that is both limited and stuck or failing (`courier.ts:474-486`).
- `expiredLimits` must bump `revision`.
- Tasks in orchestrator rows still read "YOUR move" while the orchestrator is paused.

**m3 — `queuedWorkerPrompt` is not status-only.** It also gates:
- PR detection in `implement` (`tasks.ts:318`);
- artifact adoption (`tasks.ts:355`);
- the uncommitted-work check (`tasks.ts:78`);
- the handoff text (`unstarted.ts:125`).

Excluding resume entries is right for all four, but the design should say so and test the `implement` and adoption
cases.

**m4 — Detection input and heuristic.**
- What's actually on screen, from the 11:21:23Z capture:
  - `  ⎿  You've hit your session limit · resets 5:20am (America/Managua)`
  - `     /upgrade to increase your usage limit.`
  - `✻ Worked for 0s · done 4:07 AM`
  - `❯ Still working? …`
- The `⎿` is the dim `MessageResponse` prefix (`$e`: `["  ","⎿ \xA0"]`, `dimColor`), and the text is drawn in the
  `error` colour. So the limit line itself never starts with `⏺`.
- `withoutFaintText` strips the `⎿` anchor. Detect from the unstripped screen, and anchor on
  `^\s{0,2}⎿\s+You've hit your`. Quoted copies won't match that: nested tool output is indented further, and subagent
  failure summaries have a different prefix.
- The assistant glyph is platform-dependent: `uo=O()==="macos"?"⏺":"●"`.
- Look for assistant output only in transcript lines above the input box's top rule, reusing `inputBoxText`'s rule
  matching. The box can hold a human's draft and the status line is user-defined, so a `⏺` in either would mask a real
  limit.
- Transcript user messages also render as `❯ …`. That's harmless here.

**m5 — The orchestrator.**
- Its events are dropped (`tick.ts:349`), so a limit there is only ever detected by a send.
- When its own turn was cut off, the note tells it "Nothing for you to do". It should say to finish what it was doing.
- The note is keyed to `run.phase_entered_at` (`outbox.ts:44`), so an unrelated run transition prunes it.
- Skip the note when nothing resumed.

**m6 — `dispatch --task`.** It types the brief with a direct `agentPromptConfirmed` (`cli.ts:1636`, `:736`), bypassing
the gate. It should read the screen first and refuse with the reset time.

**m7 — The "known gap" is understated.** A limit line still at the bottom of the screen more than 19 h later holds the
pane for up to 5 h with its ladder off, then sends a pointless resume. Example: a worker idling in `ci` whose `ci-red`
prompt arrives the next day. M4's first-seen memory closes this as well.

**m8 — On-disk format.**
- `OutboxEntry.kind` and `PaneHold.code`/`until` change what's on disk. Both are optional, so no `schema_version` bump
  is needed, but CLAUDE.md requires the spec to say so.
- The supervisor isn't restarted on install, so versions mix. An old `hpipe status` reading a new supervisor's
  `usage_limit` hold prints "never attempted — the supervisor is not reaching delivery".

**m9 — The live check.**
- "Putting the message on a pane's screen" exercises the quoted-text path, not the real rendering (the dim `⎿`, the
  `error` colour, herdr reporting `done`).
- Limits are frequent: 50 in two weeks. Capture `herdr pane read --format ansi` and `--format text` from a pane that is
  really limited, and use them as the fixtures.
- The smoke runbook should state what herdr reports for that pane.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 5
