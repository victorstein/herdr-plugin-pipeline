# Ready to merge — {{branch}} (#{{issue}}), PR #{{pr}}

Both review stages cleared and CI is green on PR #{{pr}}.

Before merging, check the PR does not conflict with anything merged since it branched — if another
task touched the same files, rebase this one onto the result and let CI re-run rather than merging on
a stale green. If you rebase and the repo declares `./.claude/pipeline-bootstrap`, re-run it in that
checkout before you build or test there: the sibling that landed may have changed what it builds.

Then merge it. Merging is yours, not the plugin's; nothing merges automatically.
