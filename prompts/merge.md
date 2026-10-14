# Ready to merge — {{branch}} ({{bead}}), PR #{{pr}}

{{review_count}}{{ci_status}}{{before_merge}}

Before merging, check the PR does not conflict with anything merged since it branched — if another
task touched the same files, rebase this one onto the result and let CI re-run rather than merging on
a stale green. If you rebase and the repo declares `./.claude/pipeline-bootstrap`, re-run it in that
checkout before you build or test there: the sibling that landed may have changed what it builds.{{shared_note}}

Green is for {{green_head}}. If you push to the branch, a rebase or a commit of your own, the task
goes back to `ci` and you are told again once the new head is green: do not merge on the old green.

Then merge it:

    gh pr merge {{pr}} --squash{{match_head}}

If this repo does not allow squash merges, swap `--squash` for the method it does allow, `--merge` or
`--rebase`. Merging is yours, not the plugin's; nothing merges automatically.
