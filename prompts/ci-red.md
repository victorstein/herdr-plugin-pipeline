# CI is red — {{branch}} (#{{issue}}), PR #{{pr}}

CI failed on PR #{{pr}}. The failing checks:

{{ci_failure}}

Send the worker back to fix it. Read the actual failure output before deciding what is wrong —
`gh run view --log-failed` — rather than guessing from the check name.

If the failure is environmental rather than a defect in this branch, say so explicitly and re-run
the check instead of editing code.
