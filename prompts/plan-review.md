# Adversarial review of your plan — {{branch}} ({{bead}}), pass {{pass}}

Your plan at `{{plan_path}}` is ready for review. You do not review it yourself. Hand the brief below
to a subagent with a fresh context, verbatim, and route its output — the plugin owns every word of
review instruction; you only carry it.

The reviewer writes its review to exactly this path:

    {{verdict_path}}

Dispatch the reviewer as a subagent with `effort: {{review_effort}}` and
**wait for it within this turn**. Do not end your turn until the verdict file exists at the path
named above with a `VERDICT:` trailer as its last non-empty line. Backgrounding the subagent ends your
turn and leaves this pane reading idle while the review is still being written, and the supervisor
then treats a healthy worker as a stalled one.
If the dispatch is rejected for its effort, dispatch without `effort:`.

Commit and push the verdict file before ending your turn. A verdict that lives only in this worktree
is lost at teardown and invisible to every later review that has to read what was already decided.

## The reviewer's brief

Open the review with the line `Tier: {{tier}}`.

Review `{{plan_path}}` adversarially against `{{spec_path}}`.

Read the plan; do not apply it or build it. Every step starts with a failing test the implementer
runs, and the build follows within minutes, so an error the plan's own red/green steps or the build
would show at once — a compile error, a broken command, a wrong expected count — is theirs to hit, not
yours to report. Spend the review where nothing downstream looks:

- **Spec coverage.** Does every spec requirement map to a step, and does any step quietly drop or
  narrow one?
- **Behaviour the tests cannot see.** Logic a step writes that no test in the plan would exercise:
  UI and device paths, workflow scripts, concurrency, error and fallback paths, data that persists.
- **The file lock.** Does every file a step touches appear on a `FILES:` line at column 0 outside
  any code block, as a repo-relative path or a directory prefix ending in `/` (not a glob)? Those
  lines are the file lock the pipeline enforces before implementation; a touched file missing from
  them is a MAJOR, fixed inline by adding it.
- **Steps that would mislead the implementer.** A step that, followed faithfully, leads to the wrong
  code or a hollow test: "fix the constant, never loosen the assertion" on a constant that is right,
  a guard that can never trip, a re-run that tests nothing.

The plan ends at implementation: a step that pushes, opens a PR or runs `{{hpipe}} submit` is a
MINOR, fixed inline by deleting it.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, each as claim →
problem → evidence → concrete fix, most severe first.

A **BLOCKER** is a defect that would ship, or a product or scope decision only the owner can make. A
**MAJOR** changes shipped behaviour or a verification outcome; a wrong rationale behind a correct
conclusion, comment drift or citation drift is **MINOR**. A process question — permission to edit a
shared file, a departure from the spec the worker already flagged, rebasing onto a base that moved —
is at most a MAJOR, fixed inline or raised with `{{hpipe}} decide`, and never a reason for another
review pass.

Report at most five MINORs, most consequential first; skip wording and line-citation drift unless it
would mislead the implementer or the tester.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The review ends with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 3

`BLOCKER` means at least one BLOCKER finding. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it.
