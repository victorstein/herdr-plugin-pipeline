# Adversarial spec review — issue #13, pass 1

**Target:** `docs/superpowers/specs/2026-09-17-issue-13-design.md` (v2)
**Against:** issue #13 (`gh issue view 13`), `docs/superpowers/research/2026-09-17-issue-13-research.md`,
and pass 0 (`docs/superpowers/reviews/issue-13-spec-review-0.md`, `VERDICT: BLOCKER`, 1/1/6).
**Tree:** `fix/13-digest-content` @ `5bd3ca3`, worktree
`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-13-digest-content`, clean.
**Gates re-run here:** `bun test` → `414 pass / 0 fail / 903 expect() / 33 files`; `bun run typecheck`
→ exit 0. Both match §Whole-suite gate.
**Ledger reads re-dated:** berean-os ledger re-read **2026-09-17 14:23 local** (mtime 14:22:27) —
still **80** history entries, last still `t4 done -> blocked-on-decision` at
`2026-09-17T20:05:44.516Z`. Every dated figure in the spec's 14:12 read still holds at 14:23.

## Audit of the disposition table

I checked each of the eight claimed dispositions against the document and the tree.

| Finding | Claimed | Found |
|---|---|---|
| BLOCKER 1 | Accepted, option 1; new §C3 | **Delivered as a mechanism, not as an argument.** C3 is exactly pass 0's option 1 and is correctly wired. The *reasoning* that licensed taking it without the human is falsified by the run it cites — **BLOCKER 1 below** |
| MAJOR 1 (blocked tail on the stale cache) | Accepted in full | **Genuine.** Gate is `line.event === 'agent:blocked'` in flow step 3, A12 states the behaviour change, T10 pins it. One doc-comment contradiction left behind — **MINOR 1** |
| MINOR 1 (A4 duplication) | Accepted | **Genuine and complete.** A4 now settles format *and* duplication, names both existing copies (`status.ts:12-14` clamped, `stall.ts:70` unclamped — both verified) and says who converges them |
| MINOR 2 (rung 3 "copied") | Accepted | **Genuine.** "mirrors … but renders through `hpipeCommand`"; `status.ts:25`'s literal `hpipe` verified and handed to #14 as A13 |
| MINOR 3 (file count) | Accepted | **Half-applied.** One source file is right; the test enumeration is again incomplete — **MINOR 3** |
| MINOR 4 (rung 1) | Accepted | **Genuine.** Clause is `nothing for you — this task is finished`; T4 widened to assert the actor question |
| MINOR 5 (totality) | Accepted | **Genuine and complete.** Totality dropped, unreachability via `tasks.ts:159` verified, the lost `saveRun` at `main.ts:218` stated, `phases.ts:145-149` corrected |
| MINOR 6 (overstated ledger) | Accepted | **Genuine.** 4-of-6 divergence and the 76-invisible-transitions framing both reproduce at my read. One label in the same block is still wrong — **MINOR 2** |

### What else checks out

- **§Resolution's factual account of the misfiled decisions is exact.** `qc13`'s `t2` holds this
  task's BLOCKER-1 question (`fix/15-stall-escalation`, #15) and `t1` holds the sibling's smoke.md
  question (`fix/9-artifact-paths`, #9); both were asked `2026-09-17T20:05–20:13Z`, both answered
  `answered_by: orchestrator` with *"Misfiled onto this completed run … No action here"*, and both
  dragged a `done` task through `blocked-on-decision` and back (`history` tail, `20:21:59Z`).
  `grep -c 'BLOCKER 1' …-validate-the-silent-gates-rjms.json` → `0`, and that ledger holds **no
  decisions at all**. `gh issue view 13` carries the smoke.md ruling and **no** ruling on the scope
  question. The human genuinely never answered it.
- **The occupancy reconstruction reproduces.** Re-running it over `run.history`: ten
  orchestrator-owned intervals, max concurrent **2** — t5 merge 21m, t4 merge 7m, t1 merge 2m,
  t2 merge 1m, t3 merge open, plus four `close` intervals (0/0/1/2m) and one `blocked-on-decision`.
- **Rungs 1–6 are exhaustive and correctly ordered.** 20 rows in `TASK_ROWS`
  (`src/lib/phases.ts:89-141`) classify 1/3/1/3/8/4. Rung 1 before rung 2 is load-bearing because
  `done` carries `terminal: true` (`:140`).
- **C1's blast-radius claim holds.** `grep -rn "WakeLine\|applyEvents"` finds readers only in
  `src/supervisor/main.ts:122,125,128,212` and `test/tick.test.ts`; the wake-reading tests are
  `:53-60` and `:62-69` (`toHaveLength(0)`), the wake-producing ones `:71`, `:80`, `:98`, `:114`
  discard the return value. Nothing reads `.text`.
- **A3, A11's gate, C4, and the whole citation set.** Every in-tick mutator stamps
  `phase_entered_at` (`machine.ts:94`, `tasks.ts:341`, `teardown.ts:28,34`, `tick.ts:63,74`).
  `t1.files` / `t2.files` in the sibling ledger are exactly as quoted and `filesOverlap`
  (`gating.ts:19-21`) finds no pair. `prompts/digest.md` is a six-line dead duplicate; the 19
  `renderPrompt` call sites name no `digest`. `smoke.md:100` and `:164-165` are where the ownership
  ruling says they are. I re-checked `status.ts:12-14/:13/:23-25/:135/:136`, `types.ts:5/:71/:72/:111`,
  `config.ts:24/:25`, `queue.ts:30-52`, `badges.ts:14/:16`, `stall.ts:70/:157-159/:161-219/:298`,
  `tasks.ts:117-119/:159/:171-175`, `render.ts:11/:28-38`, `phases.ts:145-149` — all land.

The findings below are what survived.

---

## BLOCKER 1 — §Resolution overrides the human on a criterion C3 does not meet, and A10's measurement of the residual gap is falsified by the run it cites

**Claim.** §Resolution (spec:46-73): the `hpipe decide` question misfiled, *"So the question stands
unanswered by the mechanism — but **the issue itself answers it**"* — quoting *"If a digest never
has to be followed by `hpipe status`, it's right"* — and *"that … chooses between pass 0's three
options … Option 1 is taken."* A10 (spec:528-537) sizes the residual gap: *"the berean-os run
delivered ~50 digests over 20h — roughly one per 24 minutes — so quiet windows long enough to matter
are rare."*

**Problem.** Both halves fail on the same ledger the spec cites.

*The mean is not evidence about the distribution, and the distribution is knowable.* Over the run's
pre-abort span of 20h02m, **two windows containing zero transitions cover 86% of the wall clock**:

```
797m  2026-09-16T08:56:22.468Z -> 2026-09-16T22:13:06.395Z   (13h17m)
235m  2026-09-16T23:49:35.584Z -> 2026-09-17T03:44:34.471Z   ( 3h55m, ends at the abort)
```

All 79 transitions fall in the remaining ~2.8h. "Roughly one per 24 minutes" is an artifact of
dividing a burst by a span, and A10's conclusion — *"quiet windows long enough to matter are rare"* —
is the opposite of what the run shows.

*And the second of those two windows is inside the park C3 exists for.* t3 entered `merge` at
`2026-09-16T22:47:27.752Z` and the run was aborted at `2026-09-17T03:44:34.471Z` — a park of
**4h57m**, of which **3h55m (79%)** is the dead window. So on the one case the design is built
around, the footer would have ridden digests for roughly the first hour and then gone silent for the
rest, and the orchestrator would still have had to run `hpipe status` — which is the exact sentence
§Resolution used to pick option 1 over option 2.

*The covered rows are narrower than A9 implies, which shrinks the margin further.* Of the three rows
the footer covers, `blocked-on-decision` is already `stallable: true` (`src/lib/phases.ts:129`) and
is therefore already probed by `taskStallCandidates` at `TASK_STALL_MINUTES` (`src/supervisor/stall.ts:101`,
`src/lib/config.ts:28`), and `close` was measured at 0/0/1/2m. The footer's genuinely new coverage is
`merge` — one row.

*Caveat, stated so the finding is not overclaimed.* Transitions are a lower bound on wake lines, not
a count of them: a wake line needs only an `agent_status` change. I cannot prove zero digests in
those windows. But the ledger holds nothing that supports A10's implied cadence either, and the
burden is on the assumption. Separately, the 16h40m since the abort is out of reach of **any** digest
design — `run.phase: 'done'` carries `releasesPane: true` (`src/lib/phases.ts:72`), so
`pickOneAdvance` (`src/supervisor/tick.ts:109`) and `taskStallCandidates` (`src/supervisor/stall.ts:98`)
both skip the run — so I am not counting it against C3, and neither should the spec.

**Why this is a blocker and not a MAJOR.** Pass 0 ranked the scope call the human's. The spec agrees
(*"I agree it is one"*), then resolves it anyway on the ground that the issue's acceptance sentence
selects option 1. On the evidence above, option 1 does **not** satisfy that sentence for the
motivating case — it satisfies it for ~21% of the park — so the sentence does not select between
options 1 and 2, and the argument that licensed proceeding without the human collapses. The author
invited exactly this: *"It is recorded here in full so the next review can overrule it on the
record"*, and A10 says the gap *"is stated so it is reviewed"*. This is that overrule. Whether a
footer that covers one row for one hour of five closes #13, or whether #19 is a prerequisite, is a
judgment I do not get to make on the human's behalf either.

**Concrete fix.** Keep C3 — it is cheap, additive, in `deliver.ts` plus the already-declared
`main.ts`, and strictly better than nothing; nothing below asks for it to be removed. Change the
argument around it:

1. **Re-surface the scope question to the human**, with the measured numbers rather than the mean:
   *"C3 reports a parked `merge` task only on ticks that already produce a digest. On the run this
   issue was filed over that is ~1h of t3's 4h57m park; 3h55m of it falls in a window with zero
   transitions. Close #13 on that, or make #19 a prerequisite?"* Re-raise it against **this** run's
   ledger (`…-validate-the-silent-gates-rjms.json`) and confirm it landed there before relying on
   it, given #21.
2. **Rewrite A10's justification** to the measured distribution: drop *"roughly one per 24 minutes —
   so quiet windows long enough to matter are rare"*, state the two zero-transition windows and
   their share of the span, and state that the footer's new coverage is `merge` (and, if MAJOR 2 is
   taken, `escalated`) because `blocked-on-decision` is already on the stall ladder.
3. **Stop claiming the acceptance sentence is met.** §Resolution should say option 1 was taken as the
   cheapest strict improvement *pending* the human, not because the issue chose it.

---

## MAJOR 1 — `DigestInput.footer` as a required field breaks three existing `buildDigest` call sites, contradicting the spec's own "must stay green"

**Claim.** §C3 Wiring (spec:356-362): *"`PendingPrompt` gains `footer?: string` **mirroring
`phaseNote?`** … `DigestInput` gains `footer: string`"* — the optionality is deliberately contrasted.
§Testing (spec:631-634): *"**Unchanged and must stay green:** `test/deliver.test.ts:33-51` and `:53-81`
… C3 adds a field; it must not disturb them."*

**Problem.** `buildDigest` is called directly from the test file with object literals at **three**
sites, none of which passes a `footer`:

```
test/deliver.test.ts:34   buildDigest({ run, eventLines, phaseNote: ' → pr-review-intent', nextPrompt: 'REVIEW THIS' })
test/deliver.test.ts:47   buildDigest({ run: mkRun(), eventLines: [...], phaseNote: '', nextPrompt: '' })
test/deliver.test.ts:124  buildDigest({ run, eventLines: [...], phaseNote: '', nextPrompt: '' })   // 'a blocked worker line inlines its pane tail'
```

A required `footer: string` makes all three `tsc --noEmit` errors — the repo's second gate
(`.claude/agents/plugin-dev.md` §"Conventions that are not negotiable"). So the sentence *"it must
not disturb them"* is false as written, and the spec's own rung-1 example of a compatibility claim
fails the `0aa1dbf` test it holds everything else to. The "unchanged" list also omits the third
digest test at `:121-130`, which is the one that pins the **pane tail** inlining — i.e. the exact
behaviour MAJOR 1 of pass 0 moved.

**Concrete fix.** `footer?: string` on `DigestInput` too, and `input.footer ?? ''` in `buildDigest`;
or keep it required and say plainly that all three `buildDigest` literals in `test/deliver.test.ts`
gain `footer: ''`. Either way, add `test/deliver.test.ts:121-130` to the unchanged-and-must-stay-green
list.

---

## MAJOR 2 — the footer excludes `escalated`, the one non-terminal row that no other mechanism reports, and `parkedFooter`'s `hpipe` parameter is dead as a result

**Claim.** §C3 (spec:330-353): the footer names *"every **non-terminal** task whose row has
`actor === 'orchestrator'`"*, via
`parkedFooter(run, covered: ReadonlySet<string>, now: number, hpipe: string): string`.
A9 (spec:518-526): *"It covers exactly the rows where the orchestrator has a move."*

**Problem.** `escalated` (`src/lib/phases.ts:130-131`) is `actor: 'human'`, carries **no**
`terminal`, and carries **no** `stallable`. So an escalated task:

- produces no wake line (its pane is hung — that is why the ladder escalated it),
- is skipped by `taskStallCandidates` (`src/supervisor/stall.ts:101`), so it is never re-probed,
- is announced exactly once, by `sendEscalation` (`src/supervisor/stall.ts:302`),
- and is thereafter visible **only** in `hpipe status`, which prints
  `⚠ tN escalated from X Nm ago — needs a human; \`hpipe rewind …\`` (`src/lib/status.ts:21-27`).

That is the same invisibility C3 was added to fix, in the row with the highest urgency, and it is the
row `hpipe status` warns about — so the footer omits precisely the line whose absence forces the
`hpipe status` the issue's acceptance sentence is about. The berean-os run had no escalation, so the
occupancy measurement in A9 cannot see this and does not disprove it.

**The signature is the tell.** Every row the footer does cover resolves to rung 4, `YOUR move`, which
renders no command. So `hpipe` is an **unused parameter** in `parkedFooter` as specified — the one
rung that needs it is rung 3, `escalated`, which the predicate excludes. `tsconfig.json` has no
`noUnusedParameters`, so this ships silently rather than failing the gate.

**Concrete fix.** Pick one and make the signature agree:

1. Widen the predicate to `!terminal && (row.actor === 'orchestrator' || phase === 'escalated')`,
   render rung 3's clause for the escalated row (which makes `hpipe` live and is where its `<phase>`
   fallback already applies), and extend T17/T18 with an `escalated` case asserting it **is** listed
   and carries the rendered `hpipe`, not the literal. Cost: at most one more line, on a row that by
   construction cannot recur.
2. Or keep the narrow predicate, **drop the `hpipe` parameter**, and add a sentence to A9 naming
   `escalated` as a deliberate exclusion with its reason — noting there that unlike
   `blocked-on-decision` it has no ladder behind it.

Option 2 is defensible; silence plus a dead parameter is not.

---

## MINOR 1 — `WakeLine.event`'s doc comment says `describeWake` adds the `agent:` prefix; the MAJOR-1 gate and T10/T14 require it added at push time

§C1's interface (spec:218) documents the field as *"What herdr reported. NEVER a phase completion —
`describeWake` scopes it."* But flow step 3's gate is `line.event === 'agent:blocked'`, T14 asserts
`wake[0].event` **is** `agent:done`, and T10 asserts `wake[0].event === 'agent:blocked'` — all of
which require the prefix present on the stored value. An implementer who follows the doc comment
stores `'blocked'`, the gate never matches, and the pane tail — *"the most actionable text in any
digest"* (A2) — silently stops being attached, which is the failure pass 0's MAJOR 1 was about. T10
would catch it, which is why this is a MINOR rather than higher.

**Fix.** *"The rendered trigger, already scoped: `agent:<status>`, `pane exited[, no PR]`,
`agent released`. Never a phase completion. The `agent:` prefix is applied here, at push, because
`src/supervisor/main.ts:125` keys the blocked-tail gate off it."*

## MINOR 2 — the occupancy block mislabels five of its ten intervals, dropping the only footer row currently on the record

§Problem (spec:133): *"… plus five `close` intervals of 0–2m"*. Reconstructed from `run.history` at
my 14:23 read there are **four** `close` intervals (t1 1m, t2 2m, t4 0m, t5 0m) and **one**
`blocked-on-decision` interval — t4, open since `2026-09-17T20:05:44.516Z`. Ten total is right; the
label is not. The interval it folds away is the one the spec's own §Ledger drift calls out as the
80th entry, and it is the second of the three rows C3 exists to report — the only one, besides t3's
`merge`, that a footer composed today would actually carry.

**Fix.** *"… plus four `close` intervals of 0–2m and one `blocked-on-decision` (t4, open since
2026-09-17T20:05:44.516Z)."*

## MINOR 3 — A11's test enumeration is incomplete again, in the same shape pass 0 flagged

A11 (spec:538-547): *"one source file, plus `test/tick.test.ts` and `test/prompts.test.ts` as tests
following the surface."* §Testing also adds T21–T23 to **`test/deliver.test.ts`**, and per MAJOR 1
that file needs a third edit besides. Pass 0's MINOR 3 was precisely *"naming exactly one of the two
test files is not [defensible]"*; v2 fixed the count from two to one and named two test files, and
then added a third test file without adding it to the list. The gate conclusion is unaffected —
`deliver.ts` is in the declared set, so its test follows the surface by the same issue-9 convention,
and I re-verified no `filesOverlap` pair against `t1.files`.

**Fix.** *"…plus `test/tick.test.ts`, `test/deliver.test.ts` and `test/prompts.test.ts`."*

## MINOR 4 — the gate that suppresses a footer-only digest is `main.ts:160`, not `deliver.ts:53`

§Error handling and A10 both attribute the "a footer never causes a delivery" behaviour to
*"`deliveriesFor` drops a pending whose `text` and `events` are both empty
(`src/supervisor/deliver.ts:53`)"*. `deliveriesFor:53` does do that, but it never sees the pending:
`addPending` returns first, at `src/supervisor/main.ts:160`
(`if (text.length === 0 && eventLines.length === 0) return`), inside the file C3 edits. The stated
behaviour is correct; the mechanism named is the second one. It matters because an implementer
revisiting A10's gap will look at `deliver.ts:53` and find changing it has no effect.

**Fix.** Cite `src/supervisor/main.ts:160` first, with `src/supervisor/deliver.ts:53` as the
backstop.

---

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 2
