# Changelog

## [1.3.3](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.3.2...v1.3.3) (2026-09-24)


### Bug Fixes

* keep docs merged in from main out of artifact adoption ([#66](https://github.com/victorstein/herdr-plugin-pipeline/issues/66)) ([e1690c0](https://github.com/victorstein/herdr-plugin-pipeline/commit/e1690c09406fc4384c29a955f918e16b84b2e382))
* widen a task's file lock from its plan before implementation ([#65](https://github.com/victorstein/herdr-plugin-pipeline/issues/65)) ([2642a5b](https://github.com/victorstein/herdr-plugin-pipeline/commit/2642a5b638b98bbe01acc61a70800010a254958e))

## [1.3.2](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.3.1...v1.3.2) (2026-09-24)


### Bug Fixes

* drop the hardcoded pnpm/turbo build note from the worker brief ([#60](https://github.com/victorstein/herdr-plugin-pipeline/issues/60)) ([bf1aa7c](https://github.com/victorstein/herdr-plugin-pipeline/commit/bf1aa7c511684aececd9e6f247c37cb0019244e9)), closes [#56](https://github.com/victorstein/herdr-plugin-pipeline/issues/56)


### Refactor

* make TaskDeps.ambiguityLog required and own it in main() ([#63](https://github.com/victorstein/herdr-plugin-pipeline/issues/63)) ([1c8daaa](https://github.com/victorstein/herdr-plugin-pipeline/commit/1c8daaaf1d3f700b58ded26b3b6742d1b8461c4e)), closes [#33](https://github.com/victorstein/herdr-plugin-pipeline/issues/33)

## [1.3.1](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.3.0...v1.3.1) (2026-09-20)


### Documentation

* tell the stall-escalation reader that a rewind moves the verdict path ([2d2f39d](https://github.com/victorstein/herdr-plugin-pipeline/commit/2d2f39d5d732a01bf2b23c8810f44fbea5073555))

## [1.3.0](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.11...v1.3.0) (2026-09-20)


### Features

* bootstrap fresh worktrees from a script the repo declares ([#54](https://github.com/victorstein/herdr-plugin-pipeline/issues/54)) ([7b22d07](https://github.com/victorstein/herdr-plugin-pipeline/commit/7b22d072630e555b9d5fead19ea11f73b6b76bc9)), closes [#16](https://github.com/victorstein/herdr-plugin-pipeline/issues/16)

## [1.2.11](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.10...v1.2.11) (2026-09-20)


### Bug Fixes

* assign each review its own verdict path instead of deriving one ([#52](https://github.com/victorstein/herdr-plugin-pipeline/issues/52)) ([f406173](https://github.com/victorstein/herdr-plugin-pipeline/commit/f40617380d7a52baf6b781d6857e309d8061d2e5)), closes [#26](https://github.com/victorstein/herdr-plugin-pipeline/issues/26)

## [1.2.10](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.9...v1.2.10) (2026-09-19)


### Documentation

* name plan among the rows the stall ladder escalates ([e426220](https://github.com/victorstein/herdr-plugin-pipeline/commit/e426220d0f82e219ac05755663f623aebba623a0))

## [1.2.9](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.8...v1.2.9) (2026-09-19)


### Bug Fixes

* probe the last mile so a parked task never stops in silence ([#47](https://github.com/victorstein/herdr-plugin-pipeline/issues/47)) ([2e8f9fd](https://github.com/victorstein/herdr-plugin-pipeline/commit/2e8f9fdc57f51b9750013fa78e4decb6eceff96d)), closes [#19](https://github.com/victorstein/herdr-plugin-pipeline/issues/19)

## [1.2.8](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.7...v1.2.8) (2026-09-19)


### Bug Fixes

* resolve every hpipe command against the caller's repo and a live run ([#44](https://github.com/victorstein/herdr-plugin-pipeline/issues/44)) ([2016ee0](https://github.com/victorstein/herdr-plugin-pipeline/commit/2016ee01f222fd03bb5cc896d9dbf4f7bde299b9)), closes [#21](https://github.com/victorstein/herdr-plugin-pipeline/issues/21) [#36](https://github.com/victorstein/herdr-plugin-pipeline/issues/36) [#38](https://github.com/victorstein/herdr-plugin-pipeline/issues/38)

## [1.2.7](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.6...v1.2.7) (2026-09-18)


### Documentation

* repair the runbook and the hand-over rule after the digest rewrite ([6605241](https://github.com/victorstein/herdr-plugin-pipeline/commit/660524155fc7cb3d00aecfffb7012475000a0b40))

## [1.2.6](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.5...v1.2.6) (2026-09-18)


### Bug Fixes

* put the phase, age and next action in every digest line ([#41](https://github.com/victorstein/herdr-plugin-pipeline/issues/41)) ([dde2d92](https://github.com/victorstein/herdr-plugin-pipeline/commit/dde2d92de65a271c50087d6f380264c71055d4b0)), closes [#13](https://github.com/victorstein/herdr-plugin-pipeline/issues/13)

## [1.2.5](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.4...v1.2.5) (2026-09-17)


### Bug Fixes

* **cli:** validate and echo --files at registration ([#39](https://github.com/victorstein/herdr-plugin-pipeline/issues/39)) ([2006802](https://github.com/victorstein/herdr-plugin-pipeline/commit/200680298da5ba4d963d20e1c65f56fbd3aa4f8a)), closes [#10](https://github.com/victorstein/herdr-plugin-pipeline/issues/10)

## [1.2.4](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.3...v1.2.4) (2026-09-17)


### Bug Fixes

* make the stall probe's sentences true of what it names ([0aa1dbf](https://github.com/victorstein/herdr-plugin-pipeline/commit/0aa1dbf1904d03c46ef892254eee5b7c73aaa13d))

## [1.2.3](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.2...v1.2.3) (2026-09-17)


### Bug Fixes

* re-probe stalled phases and escalate them to a human ([#28](https://github.com/victorstein/herdr-plugin-pipeline/issues/28)) ([93f79b2](https://github.com/victorstein/herdr-plugin-pipeline/commit/93f79b2954e67c09d62fa329d26afed48e8484c8)), closes [#15](https://github.com/victorstein/herdr-plugin-pipeline/issues/15)

## [1.2.2](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.1...v1.2.2) (2026-09-17)


### Bug Fixes

* adopt a misfiled artifact from the branch instead of stalling silently ([#27](https://github.com/victorstein/herdr-plugin-pipeline/issues/27)) ([f5c733d](https://github.com/victorstein/herdr-plugin-pipeline/commit/f5c733de544f9cd05a5716c11813eaf914c6019d)), closes [#9](https://github.com/victorstein/herdr-plugin-pipeline/issues/9)

## [1.2.1](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.2.0...v1.2.1) (2026-09-16)


### Bug Fixes

* resolve the installed plugin instead of symlinking a checkout ([#6](https://github.com/victorstein/herdr-plugin-pipeline/issues/6)) ([0d5d545](https://github.com/victorstein/herdr-plugin-pipeline/commit/0d5d5456d037e251b3f15a312f9d13cbc4b567b0))

## [1.2.0](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.1.0...v1.2.0) (2026-09-16)


### Features

* move design work into per-issue worker agents ([#4](https://github.com/victorstein/herdr-plugin-pipeline/issues/4)) ([6d3b840](https://github.com/victorstein/herdr-plugin-pipeline/commit/6d3b840d0b64a0734663ac453723f91b4398ed15))

## [1.1.0](https://github.com/victorstein/herdr-plugin-pipeline/compare/v1.0.0...v1.1.0) (2026-09-15)


### Features

* the herdr pipeline plugin ([#1](https://github.com/victorstein/herdr-plugin-pipeline/issues/1)) ([38ffabf](https://github.com/victorstein/herdr-plugin-pipeline/commit/38ffabf1e975fc30a82ce5383be5231b9f772e89))

## 1.0.0 (2026-09-14)


### Documentation

* design for herdr pipeline orchestrator plugin ([4747cc8](https://github.com/victorstein/herdr-plugin-pipeline/commit/4747cc8ae66a7ce1451d52df9595764fa6ddef31))
* implementation plan, 29 TDD tasks across three milestones ([28b6fb4](https://github.com/victorstein/herdr-plugin-pipeline/commit/28b6fb4c7ff4759956e5394cb575490f4773e5ea))
* revise design to v2 after adversarial review ([415d40d](https://github.com/victorstein/herdr-plugin-pipeline/commit/415d40df78ba794749d9879e59e055f1425d095a))
* revise design to v3 after second adversarial review ([cf27609](https://github.com/victorstein/herdr-plugin-pipeline/commit/cf276096f2c2c92c67f091fddc5ca8451a1b8e35))
* revise design to v4 — third adversarial pass returned CLEAR ([6971c01](https://github.com/victorstein/herdr-plugin-pipeline/commit/6971c01896c319a23261205b2b27d9ec6013ea38))
