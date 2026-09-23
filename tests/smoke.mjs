/**
 * Live smoke test (no LLM, no profile): mounts the plugin with a minimal
 * hand-rolled Cordis context and runs one real search through the provider
 * with real browsers. Usage:
 *
 *   DSH_HUMAN_SEARCH_HOME=<dir> node tests/smoke.mjs [query]
 *
 * Expects either a system browser or a plugin-managed Chromium under the
 * state directory's browsers/ (node lib/cli.js install-browser).
 */
import { format } from 'node:util'
import { apply } from '../lib/index.js'

let registered = undefined
const ctx = {
  logger: {
    info: (...args) => console.log('[info]', format(...args)),
    warn: (...args) => console.warn('[warn]', format(...args)),
    error: (...args) => console.error('[error]', format(...args)),
  },
  get: (name) => name === 'web'
    ? { registerSearchProvider: (provider) => { registered = provider; return () => {} } }
    : undefined,
  inject: (names, callback) => { /* settings service deliberately absent */ },
  effect: (dispose) => () => { void dispose() },
}

apply(ctx, {})
if (registered === undefined) throw new Error('provider was not registered')
console.log('provider registered:', registered.id, '| available:', registered.available())

const query = process.argv[2] ?? 'deepseek harness github'
const started = Date.now()
const result = await registered.search({ query, maxResults: 5 })
console.log(`\n=== served in ${String(Date.now() - started)}ms ===`)
console.log(result.content ?? '(no provenance note)')
console.log(`\ntop ${String(result.sources.length)} sources (truncated=${String(result.truncated)}):`)
for (const source of result.sources) {
  console.log(`- ${source.title}\n  ${source.url}${source.snippet !== undefined ? `\n  ${source.snippet.slice(0, 120)}` : ''}`)
}
if (result.sources.length === 0) {
  console.error('SMOKE TEST FAILED: no sources')
  process.exit(1)
}
console.log('\nSMOKE TEST PASSED')
process.exit(0)
