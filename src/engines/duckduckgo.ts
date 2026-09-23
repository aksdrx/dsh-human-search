/**
 * The DuckDuckGo adapter: home-page typing flow, anomaly/CAPTCHA detection
 * (DuckDuckGo has no accounts — the headed window exists to solve its
 * anomaly challenge and warm the profile), and result extraction from
 * `article[data-testid="result"]` with the legacy `.result` fallback.
 * @module dsh-human-search/engines/duckduckgo
 */

import type { Page } from 'playwright'
import type { EngineAdapter } from './types.ts'
import { cleanSources } from './util.ts'

export const duckduckgoAdapter: EngineAdapter = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  defaultLocale: 'en-US',
  homeUrl: () => 'https://duckduckgo.com/',
  loginUrl: () => 'https://duckduckgo.com/',
  searchUrl: (_locale, query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  searchBoxSelector: 'input#searchbox_input, input[name="q"], input[data-testid="searchbox-input"]',
  resultSelector: 'article[data-testid="result"], #links .result, .result__body',
  settleMs: 4_000,

  async blockedReason(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate((): string | undefined => {
        const text = document.body?.innerText ?? ''
        if (text.includes('If this persists')) return 'anomaly'
        if (document.querySelector('iframe[src*="captcha"], .anomaly, [class*="captcha"]') !== null) return 'captcha'
        if (text.includes('are you a human') || text.includes('verify that you are human')) return 'captcha'
        return undefined
      })
    } catch {
      return undefined
    }
  },

  async extractSources(page: Page) {
    const raw = await page.$$eval(
      'article[data-testid="result"], #links .result, .result__body',
      (articles): Array<{ url: string, title: string, snippet?: string }> => {
        const out: Array<{ url: string, title: string, snippet?: string }> = []
        for (const article of articles) {
          const link = article.querySelector('a[data-testid="result-title-a"], a.result__a, a[href^="http"]')
          if (link === null) continue
          const snippet = article.querySelector('[data-result="snippet"], .result__snippet')
          const href = link.getAttribute('href') ?? ''
          out.push({
            url: href,
            title: link.textContent ?? '',
            ...(snippet?.textContent !== undefined ? { snippet: snippet.textContent } : {}),
          })
        }
        return out
      },
    )
    return cleanSources(raw, 'duckduckgo')
  },
}
