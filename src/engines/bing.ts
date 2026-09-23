/**
 * The Bing adapter: home-page typing flow, the EU cookie banner's accept
 * button, challenge detection (rare), and extraction from
 * `#b_results li.b_algo`.
 * @module dsh-human-search/engines/bing
 */

import type { Page } from 'playwright'
import type { EngineAdapter } from './types.ts'
import { cleanSources } from './util.ts'

export const bingAdapter: EngineAdapter = {
  id: 'bing',
  label: 'Bing',
  defaultLocale: 'en-US',
  homeUrl: () => 'https://www.bing.com/',
  loginUrl: () => 'https://login.live.com/',
  searchUrl: (_locale, query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  searchBoxSelector: 'textarea#sb_form_q, input#sb_form_q, input[name="q"]',
  resultSelector: '#b_results li.b_algo',
  settleMs: 4_000,

  async prepare(page: Page): Promise<void> {
    try {
      const accept = page.locator('#bnp_btn_accept, #bnp_accept_cookie, button[aria-label="Accept"]').first()
      if (await accept.isVisible({ timeout: 500 })) {
        await accept.click({ timeout: 1_500 })
      }
    } catch {
      // No banner this visit.
    }
  },

  async blockedReason(page: Page): Promise<string | undefined> {
    try {
      const url = page.url()
      if (url.includes('challenges') || url.includes('/verify')) return 'challenge'
      return await page.evaluate((): string | undefined => {
        const text = document.body?.innerText ?? ''
        if (text.includes('are you human') || text.includes('Verify you are human')) return 'captcha'
        return undefined
      })
    } catch {
      return undefined
    }
  },

  async extractSources(page: Page) {
    const raw = await page.$$eval(
      '#b_results li.b_algo',
      (items): Array<{ url: string, title: string, snippet?: string }> => {
        const out: Array<{ url: string, title: string, snippet?: string }> = []
        for (const item of items) {
          const link = item.querySelector('h2 a')
          if (link === null) continue
          const snippet = item.querySelector('.b_caption p, p')
          out.push({
            url: link.getAttribute('href') ?? '',
            title: link.textContent ?? '',
            ...(snippet?.textContent !== undefined ? { snippet: snippet.textContent } : {}),
          })
        }
        return out
      },
    )
    return cleanSources(raw, 'bing')
  },
}
