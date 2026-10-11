import type { Tier } from './phases'

/**
 * Only `implement`'s coding subagent is pinned. The orchestrator, the worker
 * session and every reviewer inherit the user's default — Opus at the worker's
 * own context size, which a bare `opus` alias could shrink. A constant, not a
 * config key: only the supervisor loads config, and the CLI renders prompts too.
 */
export const IMPLEMENT_MODEL = 'sonnet'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Effort, unlike the model, is pinned for every worker and reviewer: inheriting
 * the user's default ran seven workers and every reviewer at `xhigh`, and the
 * 5-hour usage window lasted 31 minutes. Measured on the 2026-10-11 berean-os run.
 */
export const WORKER_EFFORT: Record<Tier, Effort> = { light: 'medium', standard: 'high', heavy: 'xhigh' }

export const REVIEW_EFFORT: Record<Tier, Effort> = { light: 'high', standard: 'high', heavy: 'xhigh' }
