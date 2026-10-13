# `pr-review-intent` — stage 1 on {{subject}}, {{branch}} ({{bead}}), pass {{pass}}

{{subject}} is open. Stage 1 asks one question: does it do what was asked, completely, and nothing it
was not asked to do? Code quality is stage 2 and is not this reviewer's concern.

You do not review it yourself. Hand the brief below to a subagent with a fresh context, verbatim, and
route its output — the plugin owns every word of review instruction; you only carry it.

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

On a `BLOCKER`, commit and push the verdict file before you end that turn. This ordering is
load-bearing: if the verdict were pushed at the start of your next `implement` turn, that push alone
would move {{whose_head}} head off the sha recorded when `implement` began, and an unfixed
{{change_noun}} would advance to the next review with no remediation done.

On a `CLEAR`, fix the MAJORs and MINORs it lists as `implement` does, with one subagent writing the
fixes and you verifying them, then commit and push the fixes with the verdict file: nothing later asks
for them.{{clear_fix_note}}

## The reviewer's brief

Open the review with the line `Tier: {{tier}}`.

Review {{subject}} on `{{branch}}` (`{{diff_command}}`) for **intent** against two documents:
`{{bead}}`'s brief (`{{hpipe}} brief --task {{task_id}}`) and the spec {{the_change}} itself carries at `{{spec_path}}`.{{review_context}}

Check: every acceptance criterion in the brief met; every spec requirement implemented, not just the
easy half; no silent scope reduction; no scope expansion beyond what was asked; tests that exercise
the behaviour rather than restating the implementation; and no divergence from `{{plan_path}}` that
{{the_change}} does not explain. {{plan_review_note}}

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, most severe first.

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
    MAJORS: 0

`BLOCKER` means at least one BLOCKER finding. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it.
