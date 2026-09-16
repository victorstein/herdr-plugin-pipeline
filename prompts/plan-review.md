# Adversarial review of your plan — {{branch}} (#{{issue}}), pass {{pass}}

Your plan at `{{plan_path}}` is ready for review. You do not review it yourself. Hand the brief below
to a subagent with a fresh context, verbatim, and route its output — the plugin owns every word of
review instruction; you only carry it.

The reviewer writes its review to exactly this path:

    {{verdict_path}}

Dispatch the reviewer as a subagent and **wait for it within this turn**. Do not end your turn until
the verdict file exists at the path named above with a `VERDICT:` trailer as its last non-empty line.
Backgrounding the subagent ends your turn and leaves this pane reading idle while the review is still
being written, and the supervisor then treats a healthy worker as a stalled one.

Commit and push the verdict file before ending your turn. A verdict that lives only in this worktree
is lost at teardown and invisible to every later review that has to read what was already decided.

## The reviewer's brief

Review `{{plan_path}}` adversarially against `{{spec_path}}`.

Check specifically: does every spec requirement map to a step? Do types, function names and
signatures stay consistent from step to step? Are there placeholders, vague steps, or steps that say
what to do without showing how? Does every step start with a failing test, and does every step leave
the tree working and committable? Could an implementer with no other context execute this plan
literally and arrive at the spec?

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, each as claim →
problem → evidence → concrete fix, most severe first.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The review ends with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 3

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the human can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it.
