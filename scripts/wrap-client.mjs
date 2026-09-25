/**
 * Wrap the CJS client build in the dsh web boot registration.
 *
 * The dsh web shell loads every plugin's browser half as a CLASSIC script
 * and expects it to register itself:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * where `require` resolves externals against the frozen platform module
 * table (react, cordis, …). This script takes tsdown's CJS output
 * (`lib/client.cjs`) and emits the final `lib/client.js` in that shape —
 * mirroring the artifact the dsh monorepo's own client build produces.
 * Run by `pnpm build` after tsdown.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'lib')
const sourcePath = join(outDir, 'client.cjs')
const source = readFileSync(sourcePath, 'utf8')

// Guards: the body must be classic-script-safe. ESM syntax inside a classic
// <script> is a SyntaxError that kills the whole shared combo script — the
// exact failure this wrapper exists to prevent.
for (const forbidden of [/^\s*import\s/m, /^\s*export\s/m, /\bimport\s*\(/]) {
  if (forbidden.test(source.replace(/^\s*"use strict";/, ''))) {
    throw new Error(`wrap-client: CJS output still contains ESM syntax (${String(forbidden)})`)
  }
}

const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const id = pkg.name

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${source.trimEnd().split('\n').map(line => `\t\t${line}`).join('\n')}
\t\treturn module.exports;
\t},
});
`

writeFileSync(join(outDir, 'client.js'), bundle)
rmSync(sourcePath, { force: true })
process.stdout.write(`wrap-client: wrote lib/client.js (${String(bundle.length)} bytes, id ${JSON.stringify(id)})\n`)
