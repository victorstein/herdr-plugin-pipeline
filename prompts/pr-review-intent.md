# `pr-review-intent` — stage 1 on PR #{{pr}}, {{branch}} (#{{issue}}), pass {{pass}}

PR #{{pr}} is open. Stage 1 asks one question: does it do what was asked, completely, and nothing it
was not asked to do? Code quality is stage 2 and is not this reviewer's concern.

You do not review it yourself. Hand the brief below to a subagent with a fresh context, verbatim, and
route its output — the plugin owns every word of review instruction; you only carry it.

The reviewer writes its review to exactly this path:

    {{verdict_path}}

Dispatch the reviewer as a subagent and **wait for it within this turn**. Do not end your turn until
the verdict file exists at the path named above with a `VERDICT:` trailer as its last non-empty line.
Backgrounding the subagent ends your turn and leaves this pane reading idle while the review is still
being written, and the supervisor then treats a healthy worker as a stalled one.

Commit and push the verdict file before ending your turn. This ordering is load-bearing: if the
verdict were pushed at the start of your next `implement` turn, that push alone would move the PR's
head off the sha recorded when `implement` began, and an unfixed PR would advance to the next review
with no remediation done.

## The reviewer's brief

Review PR #{{pr}} on `{{branch}}` (`gh pr diff {{pr}}`) for **intent** against two documents: issue
#{{issue}} (`gh issue view {{issue}}`) and the spec the PR itself carries at `{{spec_path}}`.

Check: every acceptance criterion in the issue met; every spec requirement implemented, not just the
easy half; no silent scope reduction; no scope expansion beyond what was asked; tests that exercise
the behaviour rather than restating the implementation; and no divergence from `{{plan_path}}` that
the PR does not explain.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, most severe first.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The review ends with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 0

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the human can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it.
