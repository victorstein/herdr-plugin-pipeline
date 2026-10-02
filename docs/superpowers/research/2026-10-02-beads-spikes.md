# Beads verification spikes — 2026-10-02

Task 0 of `docs/superpowers/plans/2026-10-02-beads-issue-store.md` (spec §11).

## Versions

- `bd version 1.3.1 (Homebrew)` — upgraded from 1.0.4 for this run. The old binary was the `bd`
  formula from the `gastownhall/beads` tap, which Homebrew now refuses to load untrusted; it was
  replaced by Homebrew core's `beads` formula.
- `herdr 0.9.1`
- `bv`: not installed. Spike 2 is deferred to the human smoke run (Task 15); the design depends on
  neither of its answers.

## Spike 1 — bd as actor `hpipe` (PASS)

Scratch store under `mktemp -d`, `BEADS_DIR` and `GIT_CEILING_DIRECTORIES` set, every call
`bd --json --actor hpipe`. Run under bash: zsh does not word-split a command held in a variable.

| Step | Exit | Note |
|---|---|---|
| `init --prefix spike --skip-agents --skip-hooks --non-interactive` | 0 | stderr: `Warning: could not compute repository ID: not a git repository` |
| `config set issue_id_mode counter` | 0 | stderr warns `"issue_id_mode" is not a recognized config key`, **but IDs came out sequential** (`spike-1`, `spike-2`) |
| `create --body-file --acceptance -l alpha -l beta` | 0 | stdout is an object with `id`; stderr: `warning: beads.role not configured (GH#2950).` + two fix lines |
| `show --include-comments --include-dependents` | 0 | stdout is an **array** of one object; with no links it carries only `dependent_count`/`dependency_count`/`comment_count` |
| `update --claim` | 0 | `in_progress`, `assignee: hpipe` |
| folded `update -s blocked --assignee hpipe --add-label … --remove-label …` | 0 | |
| `update -s in_progress` | 0 | |
| `update --assignee "" -s open` on an `in_progress` claim | 0 | assignee cleared, `open` — the release works |
| `update --claim` again | 0 | |
| `dep add spike-2 spike-1 --type blocks` | 0 | object `{depends_on_id, issue_id, status: "added", type}` |
| `comment --file` | 0 | object with `text` |
| `close --reason-file` (no `--force`) | 0 | |
| `reopen` | 0 | `open`, **assignee kept** (`hpipe`) |
| `update --claim` after reopen | 0 | claim from `open` by the same assignee succeeds |
| `close` again, and re-close of a closed bead | 0, 0 | |
| foreign close (`--actor someone-else`) | 1 | stderr verbatim: `cannot close spike-2: assignee is "hpipe", actor is "someone-else"; reclaim or use --force to override` |
| `export -o …/issues.jsonl` | 0 | stderr `Exported 2 issues to …` |

`issues.jsonl` lines (one per bead, `"_type":"issue"`) carry `status`, `assignee`, `labels`,
`comments[].text` (the marker survived), `close_reason`, and `dependencies[]` as
`{"issue_id","depends_on_id","type":"blocks",…}` on the dependent. The export is usable as the
reconciler's actual state.

**Finding: claim leases.** `--claim` sets `lease_expires_at` 5 minutes ahead
(`internal/storage/issueops/lease.go:26`, `DefaultLeaseTTL`). Expiry does nothing by itself: only
`bd reclaim` (an explicit reaper, run by nothing in hpipe) reverts an expired lease to `open`. If a
human ran it, the reconciler's next pass re-claims the bead from desired state. No design change;
the README should tell humans not to run `bd reclaim` on hpipe stores.

## Spike 2 — bv board with `phase:` labels (DEFERRED to the human)

bv is not installed, and per the plan's licence note no agent installs or runs it. The user checks,
during the Task 15 smoke run: are `phase:`/`hpipe:` labels legible on cards, and does a
non-built-in status (`deferred`) get a column.

## Spike 3 — herdr plugin pane `--env` / `--cwd` / rename (PASS)

Throwaway plugin `stein.spike` linked from the scratchpad, pane opened into a scratch workspace,
everything removed afterwards.

- `herdr plugin pane open … --workspace <ws> --cwd <dir> --env HPIPE_PROBE=yes` prints
  `{"result":{"plugin_pane":{"pane":{"pane_id":"w1A:p2","label":"Board",…}},"type":"plugin_pane_opened"}}`
  — **it returns the new pane's id**, so `openBoard` can record it directly.
- The pane printed `PROBE=yes PANE=w1A:p2 CWD=<dir>`: `--env` reaches the process, `HERDR_PANE_ID`
  is set, `--cwd` is honoured.
- The pane's initial label is the manifest `title` (`Board`).
- `herdr pane rename w1A:p2 "Board: spike abc123"` succeeded and `pane list` showed the new label.
- `herdr pane process-info --pane w1A:p2` prints `shell_pid` (87125, the `exec`'d shell).

## What changes

No spike failed. Two refinements for the implementers:

- Task 13 may take the pane id from `plugin pane open`'s output instead of relying only on
  `board.ts` recording it; the `opened_at_ms` placeholder stays as the guard against a double open.
- Task 14's README adds "never run `bd reclaim` on an hpipe store" next to the `br` warning.
