import { Herdr } from '../lib/herdr'
import { loadConfig } from '../lib/config'
import { sessionKey } from '../lib/session'
import { ensureWorkspace } from '../startup'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
if (!stateDir || !configDir) process.exit(0)

const config = await loadConfig(configDir)
const herdr = new Herdr()
const workspaceId = await ensureWorkspace(herdr, stateDir, sessionKey(), config.PIPELINE_WORKSPACE_LABEL)
if (!workspaceId) {
  console.error('[pipeline] could not resolve the pipeline workspace')
  process.exit(1)
}

const opened = await herdr.pluginPaneOpen(pluginId, 'supervisor', workspaceId)
console.log(opened.ok ? '[pipeline] supervisor pane opened' : `[pipeline] ${opened.code}: ${opened.message}`)
