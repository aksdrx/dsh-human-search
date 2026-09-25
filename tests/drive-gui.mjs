/**
 * Real-browser GUI drive: opens the test web GUI, waits for the shell to
 * settle, and reports plugin-load failures exactly as a user would see them.
 *
 *   node tests/drive-gui.mjs <port>
 *
 * Exit 0 = all plugins loaded; exit 1 = plugin load failures found.
 */
import { chromium } from 'playwright'

const port = process.argv[2] ?? '3081'
const tokenUrl = process.env.DSH_GUI_URL
if (tokenUrl === undefined) {
  console.error('pass the startup URL (with token) via DSH_GUI_URL')
  process.exit(2)
}

const shell = `${process.env.DSH_HUMAN_SEARCH_HOME ?? '.state-test'}/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`
const browser = await chromium.launch({ headless: true, executablePath: shell })
const page = await browser.newPage()

const failures = []
page.on('console', message => {
  if (message.type() === 'error') failures.push(message.text())
})
page.on('pageerror', error => failures.push(`pageerror: ${String(error)}`))

await page.goto(tokenUrl, { waitUntil: 'load', timeout: 30_000 })
await page.waitForTimeout(8_000)

const bodyText = String(await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).slice(0, 2000)
const failedToLoad = bodyText.includes('Failed to load plugins')
const registering = failures.filter(text => text.includes('loaded without registering'))

console.log(`url: ${page.url()}`)
console.log(`page shows "Failed to load plugins": ${failedToLoad}`)
console.log(`console errors: ${String(failures.length)}`)
for (const text of failures.slice(0, 6)) console.log(`  | ${text.slice(0, 220)}`)
console.log(`"loaded without registering" errors: ${String(registering.length)}`)
for (const text of registering.slice(0, 3)) console.log(`  | ${text.slice(0, 300)}`)
console.log(registering.length > 0 || failedToLoad ? 'GUI PLUGIN LOAD: FAILED' : 'GUI PLUGIN LOAD: OK')
await browser.close()
process.exit(registering.length > 0 || failedToLoad ? 1 : 0)
