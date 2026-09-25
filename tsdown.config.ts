import { defineConfig } from 'tsdown'

/**
 * Two build outputs, one per plugin face:
 *
 * - `lib/index.js` — the Host half: a Node ESM module whose runtime imports
 *   are only `playwright` and `@deepseek-ai/schemastery` (declared
 *   dependencies, kept external). The `@deepseek-ai/*` seams it consumes are
 *   reached through the Cordis context at runtime, never imported.
 * - `lib/client.cjs` → `lib/client.js` — the browser half: CJS (classic
 *   script safe; an ESM `import` inside the dsh shell's classic <script>
 *   transport is a SyntaxError that kills the whole shared combo), wrapped
 *   by `scripts/wrap-client.mjs` into the
 *   `window.__ModuleLoader__.load({ id, factory })` registration the shell's
 *   boot protocol requires; react stays external and resolves through the
 *   factory-injected require against the frozen platform module table.
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
    outExtensions: () => ({ js: '.cjs' }),
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    minify: false,
    deps: { neverBundle: ['react'] },
  },
])
