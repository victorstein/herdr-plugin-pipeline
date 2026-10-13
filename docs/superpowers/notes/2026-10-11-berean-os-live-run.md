# Live run notes: berean-os, 2026-10-11

Working notes on plugin hiccups seen during a real run. They are candidates for fixes, not a backlog yet.

- **Run:** `berean-os-20261011-responsiveness-fixes-from-the-device-bas-y98z`, herdr session `berean-os`
- **Plugin:** 2.0.0, the Beads release, installed from GitHub at 03:05 CST (09:05Z) the same day
- **Shape:** 7 tasks (t1–t7, beads `berean-o-1`…`7`). t3 is heavy, the others standard. All seven were dispatched at registration, 09:36–09:40Z.
- **Evidence:** the orchestrator transcript is
  `~/.claude/projects/-Volumes-stein-Documents-development-personal-berean-os/ee8ac7a1-b19a-4362-aa9f-09503dce7080.jsonl`.
  Worker transcripts are under `~/.claude/projects/-Volumes-stein--herdr-worktrees-berean-os-perf-*`. Plugin state is in
  `~/.local/state/herdr/plugins/stein.pipeline/`. Times are UTC.

## Fix plan

Grouped into PRs, in order. Each PR names the findings it closes.

1. **Effort by tier** (#13, part): workers start with `--effort` by tier (light `medium`, standard `high`, heavy
   `xhigh`), and every review subagent is dispatched with `effort:` by tier (light/standard `high`, heavy `xhigh`).
   The model stays inherited, so workers keep the user's 1M Opus. `show` and `task` print the effort.
2. **Usage-cap awareness** (#13 rest, #14, #15, #22): the supervisor reads "hit your session limit · resets X" in a pane,
   holds that task's probes until X, tells the orchestrator once, and re-sends the phase prompt after the reset, staggered.
   `hpipe nudge` for the manual case. An optional cap on concurrent workers. No probes for `blocked-on-files` while the
   holder moves.
3. **Confirmed bugs** (#3, #16, #21, #10, #9, #7): actions resolve the focused pane's repo; CI is pending until the head
   SHA's runs finish, and a new head invalidates the result; `release` only for a failed holder; exit code in the
   supervisor wrapper; softer "tick not saved"; legacy runs collapsed.
4. **Board** (#2, #19, #20, #11): named board tab; bv history from the target repo; `blocked-on-files` in BLOCKED with the
   holder as a blocker edge; a question shows as `needs-you` with its first line, not as blocked.
5. **Orchestrator guidance** (#1, #4, #8, #12, #6): ask on a permission denial; list the allow rules up front; land
   prerequisites before registering; one escalation per question; hint at an unwired `bin/bootstrap`.
6. **Later, each needs a design:** #5 (`dispatch` runs the block itself), #17/#24 (before-merge conditions), #18 (append-only
   paths), #23 (single-release mode).

**Status (2026-10-11, local branches, not pushed; Alfonso: push when all is done).** Six finished branches merge
together with one trivial import conflict (`src/lib/unstarted.ts`: effort-by-tier adds `tierOf`, usage-limit adds
`StallState`); the combined tree passes 1,525 tests and typechecks.
- 1 → `fix/effort-by-tier`: done.
- 3 → `fix/live-run-bugs`: done (#16, #21, #22, #3, #7, #9, #10).
- 5 → `fix/orchestrator-guidance`: done.
- 4 → `fix/board-clarity`: #2 and #20 done; #11 left as is (Alfonso: "perfect").
- #19 → `fix/bead-store-history` (`61f39c3`, from `3389164`): the store is its own git repo tracking only
  `.beads/issues.jsonl`, committed after each export and when the board opens. **bv was not run** (licence rider: no agent
  may execute it), so whether the history pane now loads is a human check: smoke runbook deferred check 8.
- 2 → `feat/usage-limit-awareness` (stacked on `fix/live-run-bugs`): done. Design pass 2 reviewed CLEAR (2 majors, 8
  minors), all answered in the code and in the design's §13. `hpipe nudge` added. A wiring test drives the supervisor's
  steps against a real ledger. The live check (capture a really limited pane raw) is runbook §4d.5.
- #23 → `feat/single-pr-mode` (from `bb48694`): Alfonso asked for a per-run "one PR at the end" mode. Decided: tasks land
  by merging into a batch branch (no per-task PR); beads close on landing; red final CI is patched by the orchestrator
  (big defects become fix tasks); landing gate YES (a task must contain the batch head before it lands). Design pass 1
  reviewed BLOCKER (mainly the gate, decided after it was written); pass 2 in progress. Not implemented yet.

**Status (2026-10-13).** Shipped together as one PR from `feat/live-run-fixes-2026-10`.
- `integration/live-run-fixes` merges the six branches above.
- `feat/single-pr-mode`: `--single-pr`, `hpipe submit`, `hpipe batch-check`, the `land-queue`/`sync`/`merge`
  landing rows and the `ship`/`ship-ci`/`ship-merge` run rows; two adversarial code reviews answered.
- `feat/review-tuning`, from the review-value research in `docs/superpowers/research/2026-10-12-review-value.md`:
  Alfonso chose all four changes (a narrower BLOCKER and at most five MINORs; heavy runs one combined `pr-review`; a
  cheaper plan review at lower effort; a small, well-planned change skips its PR review). One independent review.
- `fix/smoke-12-polish`, `fix/smoke-14-findings`, `fix/smoke-15-findings`: papercuts and wording from the smoke runs,
  and the supervisor saving only when the run changed. Its first cut never saved the CI result, so `ci`/`ship-ci`
  could not clear; unit tests passed throughout and smoke run 14 found it.
- `fix/berean-trial-findings`: a pane running background work (a subagent, shell or monitor) counts as busy; only a
  subagent holds a phase back, for at most 10 minutes; `hpipe nudge` carries on a worker stopped with uncommitted
  work; merge commands pin the head CI passed on; the branch review stays in the repo but out of git; done notices
  clean up stale refs and worktrees with submodules. One independent review, answered.
- `fix/smoke-16-findings`: prompts end the turn on a background subagent instead of waiting in it; a review row waits
  for its verdict commit; a push after `batch-check` sends the run back to `ship`.
- Live runs: smoke runs 12–16 on `victorstein/hpipe-smoke` (single-PR landing, clean and conflicting syncs, a push
  after the land prompt, the review skip, per-task CI, background work, the merge head guard), and a real berean-os
  feature run on the trial build: the tag chip picker, five tasks in single-PR mode, shipped as PR #270 and released
  as 1.30.0 after Alfonso's on-device check.
- Not yet seen live: the review row's wait for its verdict commit, and a push after `batch-check` in `ship-merge`.
- Deferred, each needs a design: #5 (`dispatch` runs the block itself), #17/#24 (before-merge conditions, including a
  way to hold for the owner between green CI and merge), #18 (append-only paths).

## Reported by Alfonso

### 1. The orchestrator doesn't stop to ask when a permission is denied

At 09:34:03 the auto-mode classifier denied `git push` + `gh pr create` ("Unrequested Commit in a Connected
App"). At 09:34:20 it denied `hpipe status` with the same reason. The orchestrator said nothing to the user and
went on writing briefs. Alfonso spotted the denials and approved them at 09:34:56.

Why it happens: the harness's denial text says "get as much of the rest of the task done as you can, then STOP
and explain". An orchestrator always has more work queued, so it never reaches the "then stop" part.

Fix direction: the skill and `prompts/intake.md` should say to ask on the spot when something is denied. The
message should name the command, why the run needs it, and the allow rule that would cover it. Also see #4.

### 2. The board is hard to find

The board opens as tab `2` of the `pipeline` workspace. herdr labels tabs by number, so its tab shows `2`. Only the
pane title says `Board: berean-os 94785e`. The orchestrator couldn't find it either. At 09:37:21 it listed tabs,
saw labels `1`, `1`, `2`, decided no board was open, and invoked the board action, which hit #3.

Fix direction:
- After `pluginPaneOpen` in `src/supervisor/boards.ts:40`, run `herdr tab rename <tab> "Board: <repo>"`. Do the same for the supervisor tab.
- Have `hpipe start` and `hpipe status` print a `board:` line with the workspace and tab.
- The skill's "`Board: …` tab is gone" row describes a tab label that never exists.

## Found in the logs

### 3. Bug: "Open board" and "Set up Beads for this repo" resolve the plugin's own repo

herdr runs action commands (`bun run src/actions/board.ts`) from the plugin root. The GitHub install
(`~/.config/herdr/plugins/github/stein.pipeline-<hash>`) is a git checkout itself. `repoContext()`
(`src/lib/repo.ts:17`) shells out to git in that cwd, so `repoKey` comes out as the plugin checkout. The slug misses,
and `board.ts:30` reports "this repo has no Beads store yet". That happened at 09:37:25 (plugin log `plugin-log-34`),
seconds after `hpipe start` had created the store. `beads-setup.ts` has the same flaw. Under `plugin link`
it would set up Beads for the plugin's dev repo.

The focused pane's context is right there: herdr passes `HERDR_PLUGIN_CONTEXT_JSON`, carrying
`focused_pane_cwd` and `worktree.repo_root` (`repo_key` is the `.git` path, so don't hash it as-is). Both
actions should resolve the repo from that.

### 4. Auto-mode will block the orchestrator's merges

At 09:41:27 the orchestrator ran `gh pr merge 253` and it went through. Its very next command (`git pull --ff-only`, worktree
remove, branch delete) was denied as "Merge Without Review". The pipeline's design has the orchestrator merge
every PR, so a run will hit this at every merge. Earlier, `herdr agent start`/`prompt` were also flaky under the
classifier (global memory `automode-classifier-blocks-herdr-agent-commands`).

Separately, the orchestrator told the user "GitHub then refused my next command". It was Claude Code's
classifier, not GitHub.

Fix direction: the README and skill should list the allow rules a run needs (`git push`, `gh pr create`,
`gh pr merge`, `herdr worktree create`, `herdr agent start`, `hpipe *`). `hpipe start` should ask for them up front,
not halfway through the run.

### 5. Dispatching N tasks means N × 4 commands the orchestrator types by hand

Each task's `dispatch, in order:` block is `worktree create` → bootstrap → `agent start` → `dispatch`, with
the pane id fished out of JSON. For seven tasks the orchestrator scripted a loop. At 09:38:36 it broke because zsh
doesn't word-split `$spec`. The retry used a bash heredoc with inline `python3` JSON parsing. Nothing stray was
left behind, but this is fragile, hand-written glue. Candidate: `hpipe dispatch --task <id>` (or `--all`) runs
the block itself.

### 6. `bootstrap: none` when the repo has `bin/bootstrap`

berean-os has `./bin/bootstrap` but no `.claude/pipeline-bootstrap`, so every task printed `bootstrap: none`. At
09:36:57 the orchestrator guessed it should run `./bin/bootstrap` in each worktree itself, and it did. Two fixes:
berean-os should add `.claude/pipeline-bootstrap`, and `hpipe task` could hint when a conventional bootstrap script
exists but isn't wired.

### 7. `hpipe status` is buried under legacy-run warnings

Nine finished runs from the pre-Beads plugin each print a three-line "started by an earlier plugin version and is
ignored here" block. At 09:35:12 the orchestrator ran `hpipe status | head -30` and saw only those. Collapse
finished legacy runs to one summary line, or hide them.

### 8. The task base is pinned before a prerequisite PR merged

The run started while the docs PR (#253: research, roadmap, baseline) was still in CI. Every task's base is
`1ba1cd34`, which doesn't have those docs. The briefs tell workers to `git show docs/252-responsiveness-baseline:…`,
a local branch. At 09:41:37 the orchestrator's cleanup tried to `git branch -D` that same branch. The classifier
denial is the only reason it survived. This is mostly orchestrator judgment, but `prompts/intake.md` could say: land
anything the briefs depend on before registering, because `base:` is fixed at registration.

### 9. Supervisor: "this tick not saved … its prompts are dropped"

Printed right after registration (09:36–09:40). The old crash log shows it dozens of times during the
2026-09-30 runs. It's by design (optimistic concurrency; the tick is redone next time). Still, "prompts are
dropped" reads like data loss in a pane the user watches. Worth softer wording, or only logging it when it repeats.

### 10. A dead supervisor leaves no exit reason

The pre-upgrade supervisor exited with only `[pipeline] supervisor exited — run hpipe status`. That wrapper
(`herdr-plugin.toml:93`) doesn't print the exit code. Its pane then sat for 11 days as a shell in a deleted directory (the
old plugin dir), where the user's shell rc crashed npm. The new startup cleaned it up correctly (ghost pane
`wC:p4`). Low priority: print `$code` in the wrapper.

### 11. The board doesn't say what a blocked card is waiting for

Alfonso had to ask why `berean-o-1` was blocked. The card's label line is cut off at
`blocked-,hpipe:aw` (the full labels are `blocked-on-decision, hpipe:awaiting-human`). Nothing on the card says it's waiting
on Alfonso, or on which question. Shorter labels would help, e.g. `hpipe:needs-you`. So would putting the open decision's question
into the bead's notes, or a status the board shows untruncated.

Alfonso's read: "it was blocked asking for a question". A pending question isn't a block. It's the one card that needs
the human. On the board it lands in the red BLOCKED column next to genuinely stuck work (failed sibling,
held files), so it reads as "something broke", not "answer me". Candidates:
- a distinct state or column for "question for you";
- the question's first line on the card;
- having the board point at where the question is waiting. Here that was a dialog in the orchestrator pane (`w1:p1`).

### 12. An escalated decision was bundled with an unrelated question

The orchestrator escalated d1 at 09:46:13. It then asked about it in one `AskUserQuestion` dialog together with its
merge-policy question (#4). t1 can't move until both tabs are answered and submitted, and while the dialog is open every supervisor
delivery to `w1:p1` fails with `agent_blocked` (6 attempts by 09:52; the hold itself is correct). `prompts/escalate.md`
could say: ask each escalated decision on its own, so answering it unblocks the worker straight away.

### 13. No say over worker effort or model, and no awareness of the usage cap — **must fix (Alfonso: "this is bad, has to be fixed")**

**It recurs.** Across earlier berean-os runs, workers hit `You've hit your session limit · resets <time>` (HTTP 429) 50
times across 18 worker transcripts, on 2026-09-16, -17, -18, -19, -20, -27 and -30.
(`grep -l '"apiErrorStatus":429' ~/.claude/projects/-Volumes-stein--herdr-worktrees-*/*.jsonl`)

**Levers that exist:**
- `claude` takes `--effort <level>` and `--model <model>` per session. The dispatch block's
  `agent start … -- --dangerously-skip-permissions` (`prompts/dispatch.md:11`) can carry them.
- `src/lib/models.ts:7` already pins `IMPLEMENT_MODEL`. Its comment shows the "inherit the user's default" choice was
  deliberate, so the fix reverses a decision rather than filling a gap.

**Reviewers too (checked 12:15Z):** every adversarial reviewer subagent ran on `claude-opus-5-5` at `effort: xhigh`. That's
22 reviewer transcripts so far, 37–169 assistant turns each. Only implement's coding subagent differs (`claude-sonnet-5-5`,
`medium`), because `prompts/implement.md:11` tells the worker to dispatch with `model: {{implement_model}}`
(`src/lib/tier-prompt.ts:57`). The review prompts (`spec-review.md`, `plan-review.md`, `pr-review*.md`) only say "dispatch the
reviewer as a subagent", so reviewers inherit the worker's Opus/xhigh. The usage cap also cut 5 reviews off mid-run (their
transcripts end in a `<synthetic>` error: t2, t3, t4, t6, t7). The rewind (#14) re-ran each one from scratch, so that xhigh
spend was wasted.

**Fix sketch:**
- Reviewers get `model:` and `effort:` the same way implement does: a `{{review_model}}` / `{{review_effort}}` in each review
  prompt, set by tier (e.g. light/standard reviews at `high`, heavy at `xhigh`).
- Worker effort by tier, with config to override: light → medium, standard → high, heavy → xhigh.
- An optional cap on concurrent workers, so dispatch queues past N.
- The supervisor reads a worker pane showing "hit your session limit · resets X" and records the task as rate-limited until X,
  instead of stall-probing it. It tells the orchestrator once.

At 10:05 Alfonso asked the orchestrator "what effort level are the agents using?". It had to work it out from
`~/.claude/settings.json`. The workers are bare `claude` started with `--dangerously-skip-permissions`, so they inherit the user's
default: Opus 5.5 1M, effort `xhigh` through `modelSettings`. The plugin pins only implement's coding subagent (to Sonnet).
Seven xhigh Opus workers had the 5-hour window at 76% after ~30 minutes, with implement and PR review still to come.

Candidates:
- per-tier or per-phase `--effort`/`--model` on `agent start` (light tasks or review passes don't need xhigh);
- a `hpipe status` line that says what the workers run at;
- a cap on concurrent workers.

Also watch what happens if the cap is hit mid-run. Workers would go silent, and the plugin only sees that as stalls (probe at
45 min, escalation after 3 unanswered probes). Nothing tells the orchestrator "rate-limited, resumes at HH:MM".

### 14. No command to wake idle workers, so the orchestrator rewound all seven

After the usage-cap pause, Alfonso told the orchestrator "Time to wake up the rest of the agents" (11:21:06). The skill
has nothing for this case. The orchestrator ran `hpipe rewind --help` (one usage line), then read the installed plugin's
`src/cli.ts` (rewind, `owePhasePrompt`) to learn that a rewind to the *current* phase re-sends that phase's
prompt to a bound worker. It then ran `rewind <run> plan --task t1` and `rewind <run> spec-review --task t2…t7`. All seven were
`working` 40 s later, so it worked. But it's the heaviest tool used for the lightest job:
- **Counters cleared:** `passes = {}` on every task. t5 had already been through one spec-review round, and its pass count is gone.
- **Reviews re-commissioned:** every review gets a newly reserved verdict filename (`…-spec-review-1.md`; t5's became `-2.md`).
- **History noise:** every task's history gets a `manual rewind` entry, as if something had gone wrong.

The orchestrator also saved a global memory note about the workaround (`tools/hpipe/session-limit-stall-recovery.md`), so the
next orchestrator will reach for rewind again.

Fix direction:
- `hpipe nudge --task <id>|--all` re-sends the current phase prompt and touches no state. Better still, the supervisor does this
  itself when a pane's cap resets (see #13).
- The stall probe should say why the worker may be silent. t1's probe said "This phase has been open 45 minutes" (it was
  ~66) and nothing about the session limit visible in that same pane.

### 15. Waking everyone at once just burns the next window

All seven xhigh workers restarted together at 11:21Z. The last window lasted 31 minutes under the same load, so expect the next
cap around 11:50–12:00Z unless something changes. A concurrency cap (#13) or staggered resumes would spread the load.

### 16. Bug: the CI gate passes before the build has even started

`ci` for t1 cleared in 10 s: `pr-review → ci` at 11:47:17Z, `ci → merge` at 11:47:27Z, recorded as `ci: "pass"`. Seventeen seconds
later the orchestrator checked the PR's head commit (`bc9efd04`, pushed during pr-review) and found `CI (build) queued`,
`PR Title Lint completed success`, `mergeStateStatus: UNSTABLE`. `ciBucket` (`src/lib/gh.ts:14-18`) reads `gh pr checks`. A
workflow that is still queued has no check row yet, so the only listed check was the finished title lint, and the result was
`pass`. Only the orchestrator's own habit of checking CI on the head commit kept a PR with an unbuilt head from being presented as
ready to merge.

**Second form (18:03Z):** after t3 cleared CI, the orchestrator pushed a hand-off commit (`924e0aec`) onto its branch. The plugin
still reported green, for the previous head `9e06c261`, while the new head's build was queued. The orchestrator again caught it
only by checking itself. The `ci` result isn't tied to the head SHA it was measured on.

Fix direction: treat the head SHA's workflow runs (`gh run list --commit <sha>`) that are queued or in progress as pending, and store
the SHA with the result so a new push invalidates it. Or
require a configured or branch-protection set of checks to be present before `pass`. Or both.

Alfonso suggested a "waiting on CI" status. The state machine already has one: the `ci` row (`src/lib/phases.ts:152`, between
the PR reviews and `merge`). This bug made t1 skip through it in 10 s, so it never showed. Once it's fixed, the task sits visibly in
`ci` until the head build finishes, and the orchestrator no longer needs its own "watch the head build" step at merge. Also
worth having: `hpipe status` and the board name what CI is waiting on (e.g. `ci: Build x4pro running`), not just the bare phase.

### 17. A decision's condition for merging lives only in prose

t1's d1 answer says "the PR lists the device checks … if a ghost shows, fall back to (b)". The orchestrator's escalation had
recommended "verified on device before merge". At 11:47 the orchestrator planned to merge #255 as soon as CI passed, and no
device check was run. Nothing in the pipeline records a condition that must hold before merging, like a human check or a
device test, so it depends on the orchestrator remembering. Candidate: `hpipe answer … --before-merge "<check>"`, which holds `merge`
until the human confirms.

### 18. One shared docs file serializes three otherwise independent tasks

`docs/file-formats.md` is the repo's on-disk format registry. Every task that adds a cache must add a section to it. t3 declared
it at registration. t7's research found it needs it (09:50). t6's plan widened into it and took the lock at implement
(~12:05Z), so t3 and t7 will each wait in `blocked-on-files` for t6's full implement → review → CI → merge, and then for each
other. The edits are appends to separate sections, the kind of conflict a rebase handles in seconds. Candidate: let a repo mark
paths as append-only or merge-resolvable (e.g. in `.claude/pipeline-*` config), so they don't count toward the file lock.

### 19. The board's history view always fails: bv runs outside any git repo

bv's status bar shows `✗ History load failed: extracting events: git log --raw failed: fatal: not a git repository (or any of
the parent directories): .git` (Alfonso, ~12:20Z). The board starts bv with `cwd` set to the store
(`src/board.ts:90`, `beadsHome(stateDir, slug)` = `~/.local/state/herdr/plugins/stein.pipeline/beads/<slug>/`). That directory is
deliberately not a repo: `beadsSpawnEnv` (`src/lib/beads-project.ts:51`) even sets `GIT_CEILING_DIRECTORIES` to the beads root so
git can't discover one upward. bv's history feature correlates beads with git commits (`--robot-history`: "bead-to-commit
correlations"), so with no repo it fails every time. The Beads spikes (`docs/superpowers/research/2026-10-02-beads-spikes.md`)
caught bd's "not a git repository" warning but never exercised bv's TUI history.

The useful history is the *target* repo's commits: workers' branches and PRs referencing `berean-o-N`. `project.json`
already records `repo_root`. Spike: run bv with `cwd = repo_root` and `BEADS_DIR` pointing at the store, without a ceiling
that excludes `repo_root`, and check that bv loads the store from `BEADS_DIR` and not from a `.beads/` it finds in the repo. If
bv can't do that, hide or disable the history pane rather than show a red error forever.

### 20. The board's BLOCKED column is inverted: questions go in it, real waits don't

At ~12:20Z t2, t3 and t7 sat in `blocked-on-files` behind t4 and t6. On the board they show as **IN PROGRESS**: their beads are
`[in_progress]` with only a `blocked-on-files` label. Alfonso asked "shouldn't the tasks be blocked?". Earlier, t1's *question* (d1)
put `berean-o-1` in the red **BLOCKED** column (#11). That's backwards from how a human reads it.

Cause: `desiredBead` (`src/lib/bead-desired.ts:104-123`, spec §5's table) gives Beads status `blocked` only to a task with an
unanswered escalation. Every other held phase, `blocked-on-files` included, maps to `in_progress`. The vocabulary also differs
everywhere: the phase says `blocked-on-files`, the orchestrator tells the user "queued", and the board says "in progress".

Fix direction:
- `blocked-on-files` (and waits on `--depends-on`) → status `blocked`, with the **holder's bead as a blocker edge**.
  `desiredBead` already emits `blockedBy: dependencyBeads(task, run)`, so adding the file-lock holder lets bv show "blocked by
  berean-o-4" natively.
- An escalated question → not `blocked`. Keep it `in_progress` (or `open`) with a short, prominent label such as `needs-you`, and
  the question's first line in the bead (#11).

Alfonso confirmed the requirement (12:25Z, board screenshot): the cards say `blocked-` but sit under IN PROGRESS (6) while
BLOCKED (0) is empty. "That is what the blocked column is for, and they should also say which task they are being blocked by."
bv also cuts card labels to about 8 characters (`blocked-`, `implemen`), so the blocker must not live in a label. A real blocker
edge (rendered by bv) or the bead's own text has to carry "blocked by berean-o-4 (t4, implement)". Phase labels short enough to
survive the cut would help too (e.g. `impl`, `files`, `ci`).

### 21. Bug: `hpipe status` tells the orchestrator to `release` an escalated holder

During the second outage, t4 and t6 escalated while holding files that t2, t3 and t7 waited on. Every digest then carried
`t2 … [blocked-on-files 212m] — YOUR move: \`hpipe release --task t4\`` (15:36Z, 15:38Z). The source is
`src/lib/status.ts:206-213`: any file holder that `hasStoppedMoving` (escalated counts) gets a release recommendation. The skill
says the opposite ("Task `escalated` → `hpipe rewind …`; `release` is NOT for this"), and so does the berean-os memory the orchestrator
relied on. It declined at 16:21: "I didn't take the supervisor's `hpipe release` suggestion … it only fits a task you're
abandoning". If it had followed the suggestion, t4's lock would have been dropped mid-PR and t2 would have started implementing
over files t4 was still changing. Fix: recommend release only for a `failed` holder. For an escalated holder, point at the
holder's own rewind and escalation.

### 22. `blocked-on-files` tasks keep nagging the orchestrator

A task waiting on a sibling's files is stall-probed like any other phase, and the probe goes to the orchestrator. t2 and t3 got
6 probes each and t7 got 5, about every 45 min, from 12:48Z to 16:48Z. The orchestrator's replies were "This is a standing nudge, with nothing to
act on" (16:33Z) and "The nudge is expected" (16:48Z). During the outage every one was typed into the rate-limited orchestrator and
rejected (15 wasted prompts). `status.ts:207-209` admits the row "probes it to the cap and then goes quiet forever". Fix: don't
probe `blocked-on-files` while the holder is moving. Probe the *holder's* stall instead, which it already has.

### 23. The batch shipped as six releases, and #258 is missing from every release note

The berean-os memory `single-release-for-a-batch` (which the orchestrator read at 09:33:31) says Alfonso wants a batch to ship as **one**
release. It also warns that back-to-back merges race release-please and drop entries from the notes. The pipeline merges one task at a
time, so the run cut v1.29.10 through v1.29.15 (six releases). #257 and #258 were merged ~40 s apart (16:35:42, 16:36:18), and
**#258 ("close the reader menu without re-rendering the page") appears in none of the six release notes**. v1.29.11 lists
only #257. The code shipped, but the changelog lies by omission. The memory's workaround (stack every task's PR onto one
integration branch, merge once with a `BEGIN_COMMIT_OVERRIDE` block) is something the plugin has no mode for, and it clashes with
`merge` holding the `--files` lock. Candidates:
- a run-level `--single-release` / integration-branch merge mode;
- or at minimum, the supervisor holds the next merge until the previous merge's release-please run has settled.

### 24. The run finished with its device verification never done

#17 played out to the end. The orchestrator deferred t1's ghost check to "a combined build once more fixes have landed". At
17:34Z it built `main` for the device, waited 20 min for the device to show up on USB, and never flashed it (17:55Z). The run then went
to `done` at 18:27Z with no record that any device check from the decisions is still owed. Nothing in `hpipe status` or the beads
says so either.

## Watch log

- **09:46Z:** t5 reached `spec`. t1 raised decision d1 (FAST vs HALF on entry). The orchestrator escalated it to
  the user. The orchestrator's merge-policy question (#4) is still unanswered.
- **09:50Z:** t4 → `spec`. t7's worker raised itself `standard → heavy` from research, which worked as designed. The reason
  given is a new on-disk cache with a format version under data-dev's surface (`SdPaths`, `docs/file-formats.md`).
  Two things to watch:
  - The task stays on `--surface ui`, and there's no way to add or change a surface after registration.
  - `docs/file-formats.md` is in t3's `--files`, so once t7's plan widens its files, it will queue behind t3 at implement.
- **09:52Z:** d1 on t1 was answered once the bundled dialog was submitted. t1 → `spec` → `spec-review`. t3 → `spec` at 09:54. t4 and t7 →
  `spec-review` by 10:00.
- **10:00Z:** t6 raised d1 in `spec`: a new on-disk search-fingerprint record. data-dev's rules make any new format a user call.
  The orchestrator escalated it 15 s later and Alfonso answered by 10:02:21. t6 → `spec`. This is how the flow should look, start to finish.
- **"tick not saved" count (#9):** 3 by 10:00Z.
- **10:07:39Z: session limit hit** ("resets 5:20am America/Managua" = 11:20Z), about 31 minutes after the first dispatch. The
  orchestrator (twice) and t1's worker hit it first. t1 had just gone `spec-review → plan`. Watching for:
  - what happens to supervisor prompts delivered to a rate-limited pane: submitted, then immediately 429'd;
  - whether stall probes fire during the outage and count as "unanswered";
  - whether anything wakes the agents after 11:20Z.
- **The outage, 10:07–11:20Z.** What the plugin did:
  - **Every agent hit the cap within 11 minutes** (10:07:39–10:18:10). Each worker went idle on its last request, and herdr reported each one as `done`.
  - **The orchestrator took 18 usage-limit errors**, 10:07–10:53. Every supervisor digest was typed in, submitted, and immediately
    rejected. The supervisor's delivery health stayed clean (`panes: {}`) because the text *was* delivered. Nothing
    tells the supervisor that a submitted prompt was never processed.
  - **Each worker got exactly one stall probe during the outage** (10:43–10:53, about 66 minutes after its last activity). It was
    rejected the instant it landed and still counts as `probes: 1`, i.e. unanswered. The second probe is due about 45 minutes later
    (≈11:28–11:38Z), after the reset, so the plugin would have woken the workers by accident 8–18 minutes late. A longer outage
    burns all three probes and escalates every task, which turns a quota pause into seven escalations.
  - **At 11:21Z `hpipe status` misread the pause.** t1 showed "YOUR move: worker idle with nothing at …/plan.md (its branch added
    no document to adopt)". The real cause was the usage cap, and the worker wasn't finished. The other six showed "worker's move:
    waiting for its review verdict" while doing nothing.
  - **Resume, 11:21Z:** all seven woke after same-phase rewinds (#14). t1 went plan → plan-review → implement (11:31Z, holding
    `BibleSearchActivity` ahead of t6) → PR #255 → pr-review (11:42Z). The plugin's `ci` cleared in 10 s while the head build was
    still queued (#16).
  - **11:53:47Z, first merge:** after its own head-commit CI wait, the orchestrator merged #255 (`106dfc4b`). It wasn't denied this
    time. The device ghost check from d1 was *deferred*: the orchestrator said it would "flash a combined build for you to
    verify once more fixes have landed" (#17 in action). It also merged while the branch was behind main (release 1.29.9 had
    landed since its base). That's fine for a squash merge, but nothing re-ran CI against the new main.
  - **~12:00–12:10Z, implement fan-in:** t1 merged and was torn down cleanly (worktree, workspace and bead all closed). Then
    plan widening collapsed the parallelism. t4, t5 and t6 are implementing. t2 waits on t4 (`EpubReaderActivity.cpp`). t7 waits on t6
    (`docs/file-formats.md`, #18). t3 waits on both (`EpubReaderActivity.*` and `docs/file-formats.md`). Seven tasks registered with
    disjoint `--files` became three implementing at once. Widening at plan time is the plugin working as designed, but
    the orchestrator's up-front `--files` were nowhere near the real footprint. `hpipe status` names the holder clearly.
  - **12:31Z:** t5 raised d1 in `implement`: approve a fast-forward push to the `victorstein/freeink-sdk` fork's `berean` branch. The orchestrator escalated it
    12 s later and Alfonso approved by 12:31:59. Clean.
  - **12:34:14Z: second session-limit hit**, "resets 10:20am America/Managua" = **16:20Z, a 3 h 46 min outage**. This window
    lasted 74 min (11:20 → 12:34), against 31 min for the first, with at most 3 tasks implementing instead of 7 researching. t5 had just
    opened PR #257 (`implement → pr-review`). Prediction to verify: worker stall probes come about every 45 min and escalate
    after 3 unanswered, i.e. roughly 2¼ h, so t4, t5 and t6 should **escalate during the outage**. That turns a quota pause into
    escalations the human must rewind (#13).
  - **The prediction held.** t4, t5 and t6 each got 3 worker probes (13:19–14:53Z), every one rejected on arrival, and **escalated
    at 15:34–15:39Z**. The three "Escalated" prompts and 15 orchestrator nudges about the waiting tasks (#22) were also typed into
    the rate-limited orchestrator and rejected: 33 rejected requests between 12:34 and 16:19Z.
  - **16:20Z reset, recovery by accident.** Nothing resumed on its own. A stall probe for escalated t4 landed at 16:21:32Z,
    a minute after the reset, and that probe woke the orchestrator. It worked out the cause from the panes ("your 5-hour session
    limit again … not from the work"), declined the status line's `release` advice (#21), and resumed t4, t5 and t6 with
    `rewind … pr-review` (the same blunt tool as #14). It also added the second occurrence to its global memory note.
  - **16:35–16:37Z, merge burst:** #257 (t5), #258 (t4) and #259 (t6) merged within 95 s. The orchestrator checked each head's CI and
    ran `git merge-tree` against main, but the back-to-back merges dropped #258 from the release notes (#23).
  - **17:01Z, CI-red loop worked:** #262 (t2) failed cppcheck (`useStlAlgorithm` in the new `CoverBandCache.cpp`). The supervisor
    sent t2 back to implement on its own, and the fix, re-review, CI and merge followed (17:22Z). That's the designed loop with
    no orchestrator involvement.
  - **17:20–18:08Z:** #263 (t7) and #266 (t3) merged. At 18:02Z the orchestrator pushed a test-registration hand-off commit onto t3's
    branch, and the plugin's "green" was for the head before that push (#16, second form). zsh word-splitting broke one of its
    commands again (18:02:30Z, #5).
  - **18:10Z, branch review:** 6 recorded discoveries were filed as beads `berean-o-8`…`13` (worked). The orchestrator ran the
    whole-branch reviewer as a *background* subagent and got a stall probe 15 min in (18:25Z) while it was legitimately waiting. The verdict was
    CLEAR (1 major, 6 minors) and the run reached `done` at 18:27:23Z.
  - **Totals:** 7/7 merged, 6 releases (#23), 0 device checks (#24), 2 usage-cap outages (≈1 h 13 min + 3 h 46 min, about 5 of the
    run's 8 h 50 min), 8 "tick not saved" lines (#9).
  - **Nothing resumed by itself.** At 11:21Z Alfonso had to tell the orchestrator to resume all the agents. Watch next how the orchestrator
    does that, given the "never type into a worker's pane" rule.
