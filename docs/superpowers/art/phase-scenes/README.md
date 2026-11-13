# Phase scenes (approved 2026-11-13)

These are the 12 Working-column scenes for the pipeline board. The user approved them as drawn.

- `scenes.ts` registers the 11 new scenes with the kit's `registerScene`. Implement reuses pasture's
  built-in `working` scene.
  - Its imports already point at `../kit/`. Plan 3 moves it to `src/board/scenes.ts` unchanged, once
    the kit is vendored.
- `sheet.png` holds every frame at 6× scale, one phase per row: research, spec, spec-review, plan,
  plan-review, implement, pr-review, ci, land-queue, sync, merge, close.
- `real-size.png` shows frame 0 of each phase at about the size it appears on a card.
- `preview.html` is the phone preview page. It expects the frames in `frames/<phase>-<n>.png`, so
  render them first.

Phase → scene: `implement` → `working`. The retired `pr-review-intent`/`pr-review-quality` →
`pr-review`, and `teardown` → `close`. Every other phase maps to the scene of the same name.
