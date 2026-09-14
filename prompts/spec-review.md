# Adversarial review of the spec — run {{run_id}}, pass {{pass}}

Dispatch a fresh subagent to review `{{spec_path}}` adversarially. A review that finds nothing is a
failed review.

The reviewer must be evidence-first: verify every claim against the installed packages, the live CLI
help, and current docs — they drift. Cite `file:line` or exact command output for every finding.
Attack internal consistency, integration seams, and contradictions introduced by churn — not just the
happy path. A wrong or half-applied fix from a prior pass is the highest-value finding there is.

Rank each finding **BLOCKER**, **MAJOR**, or **MINOR**, each as claim → problem → evidence →
concrete fix, most severe first.

The reviewer writes the review to exactly this path:

    {{verdict_path}}

It must end with a trailer whose **last non-empty line** is the verdict, optionally preceded by
counts:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 2
    MAJORS: 5

`BLOCKER` means: any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs
a judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Write the trailer at the **start of the line** — not indented, and not inside a code fence. An indented or fenced copy is documentation, not a verdict, and is rejected. Nothing but count lines may follow it: a file with prose after the trailer reads as still being written.
