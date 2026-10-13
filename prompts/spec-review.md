# Adversarial review of your spec — {{branch}} ({{bead}}), pass {{pass}}

Your spec at `{{spec_path}}` is ready for review. You do not review it yourself. Hand the brief below
to a subagent with a fresh context, verbatim, and route its output — the plugin owns every word of
review instruction; you only carry it.

The reviewer writes its review to exactly this path:

    {{verdict_path}}

Dispatch the reviewer as a subagent with `effort: {{review_effort}}`.
If the dispatch is rejected for its effort, dispatch without `effort:`. Whenever a subagent you
dispatch runs in the background, end your turn and carry on when its completion notice arrives. Never
poll for the verdict file or sleep while it runs: the supervisor counts this pane as busy while a
subagent of yours runs.

This phase clears once you are idle, with the verdict file committed and no subagent of yours running,
so commit the verdict last, once the review is handled. When the reviewer has finished, check that the
verdict file exists at the path named above with a `VERDICT:` trailer as its last non-empty line.

On a `BLOCKER`, commit and push the verdict file before you end that turn. On a `CLEAR`, fix the
MAJORs and MINORs it lists in that same turn, then commit and push the fixes with the verdict file
before you end it: nothing later asks for them. A verdict that lives only in this worktree is lost at
teardown and invisible to every later review that has to read what was already decided.

## The reviewer's brief

Open the review with the line `Tier: {{tier}}`.

Review `{{spec_path}}` adversarially against the brief for `{{bead}}` (`{{hpipe}} brief --task {{task_id}}`) and the
research note at `{{research_path}}`.

Be evidence-first: verify every claim against the code, the installed packages, the live `--help`
output and current docs — they drift. Cite `file:line` or exact command output for every finding.
Attack internal consistency, integration seams, and contradictions introduced by churn, not just the
happy path. Attack the labelled assumptions specifically; they are where the design's real choices
are. A wrong or half-applied fix from a prior pass is the highest-value finding there is.

Rank each finding **BLOCKER**, **MAJOR** or **MINOR**, each as claim → problem → evidence → concrete
fix, most severe first.

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
    BLOCKERS: 2
    MAJORS: 5

`BLOCKER` means at least one BLOCKER finding. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it: prose after the trailer reads as a file still being written.
