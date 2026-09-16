# Adversarial review of your spec — {{branch}} (#{{issue}}), pass {{pass}}

Your spec at `{{spec_path}}` is ready for review. You do not review it yourself. Hand the brief below
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

Review `{{spec_path}}` adversarially against issue #{{issue}} (`gh issue view {{issue}}`) and the
research note at `{{research_path}}`.

Be evidence-first: verify every claim against the code, the installed packages, the live `--help`
output and current docs — they drift. Cite `file:line` or exact command output for every finding.
Attack internal consistency, integration seams, and contradictions introduced by churn, not just the
happy path. Attack the labelled assumptions specifically; they are where the design's real choices
are. A wrong or half-applied fix from a prior pass is the highest-value finding there is.

Rank each finding **BLOCKER**, **MAJOR** or **MINOR**, each as claim → problem → evidence → concrete
fix, most severe first.

Rank honestly. Do not pad a review to look thorough, and do not soften a real finding to be
agreeable. The verdict gates the pipeline, so a manufactured finding costs as much as a missed one —
if the work is genuinely sound, `CLEAR` is the correct and useful answer.

The review ends with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 2
    MAJORS: 5

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the human can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An
indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may
follow it: prose after the trailer reads as a file still being written.
