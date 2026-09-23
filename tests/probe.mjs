/** Debug probe: open each engine home, dump what rendered. */
import { chromium } from 'playwright'

const engines = [
  ['duckduckgo', 'https://duckduckgo.com/', 'input[name="q"]'],
  ['bing', 'https://www.bing.com/', 'textarea#sb_form_q, input#sb_form_q, input[name="q"]'],
  ['baidu', 'https://www.baidu.com/', 'input#kw, input[name="wd"]'],
  ['sogou', 'https://www.sogou.com/', 'input#query, input[name="query"]'],
]

const shell = '/home/aksdr/ws-plugins/dsh-human-search/.state-test/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
const browser = await chromium.launch({ headless: true, executablePath: shell })
for (const [name, url, selector] of engines) {
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(4000)
    const title = await page.title()
    const boxCount = await page.locator(selector).count().catch(() => -1)
    const visible = boxCount > 0 ? await page.locator(selector).first().isVisible().catch(() => false) : false
    const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? '')).replace(/\s+/g, ' ')
    console.log(`\n=== ${name} ===`)
    console.log('url:', page.url())
    console.log('title:', title)
    console.log('box count:', boxCount, '| visible:', visible)
    console.log('body:', body.slice(0, 180))
  } catch (error) {
    console.log(`\n=== ${name} === FAILED: ${String(error).slice(0, 150)}`)
  }
  await page.close()
}
await browser.close()
