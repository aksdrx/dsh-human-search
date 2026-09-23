import { defineConfig } from 'tsdown'

/**
 * Two build outputs, one per plugin face:
 *
 * - `lib/index.js` — the Host half: a Node ESM module whose runtime imports
 *   are only `playwright` and `@deepseek-ai/schemastery` (declared
 *   dependencies, kept external). The `@deepseek-ai/*` seams it consumes are
 *   reached through the Cordis context at runtime, never imported.
 * - `lib/client.js` — the browser half: a self-contained bundle whose only
 *   runtime import is `react`, which the dsh web shell supplies through the
 *   frozen platform module table, so it stays external.
 */
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    minify: false,
  },
  {
    entry: { client: 'client/index.ts' },
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    minify: false,
    deps: { neverBundle: ['react'] },
  },
])
