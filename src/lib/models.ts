/**
 * Only `implement`'s coding subagent is pinned. The orchestrator, the worker
 * session and every reviewer inherit the user's default — Opus at the worker's
 * own context size, which a bare `opus` alias could shrink. A constant, not a
 * config key: only the supervisor loads config, and the CLI renders prompts too.
 */
export const IMPLEMENT_MODEL = 'sonnet'
