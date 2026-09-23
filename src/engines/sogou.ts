/**
 * The Sogou adapter: Chinese locale by default, `#query` typing flow,
 * anti-robot CAPTCHA detection, and extraction from `.vrwrap`/`.rb` result
 * wrappers. Sogou result URLs are `sogou.com/link` redirects; they are kept
 * as-is.
 * @module dsh-human-search/engines/sogou
 */

import type { Page } from 'playwright'
import type { EngineAdapter } from './types.ts'
import { cleanSources } from './util.ts'

export const sogouAdapter: EngineAdapter = {
  id: 'sogou',
  label: 'Sogou',
  defaultLocale: 'zh-CN',
  homeUrl: () => 'https://www.sogou.com/',
  loginUrl: () => 'https://account.sogou.com/',
  searchBoxSelector: 'input#query, input[name="query"]',
  resultSelector: '.results .vrwrap h3 a, .results .rb h3 a, .result h3 a',
  settleMs: 4_000,

  async blockedReason(page: Page): Promise<string | undefined> {
    try {
      const url = page.url()
      if (url.includes('antirobot') || url.includes('captcha.sogou.com')) return 'antirobot'
      return await page.evaluate((): string | undefined => {
        const text = document.body?.innerText ?? ''
        if (text.includes('请输入验证码') || text.includes('请输入图片验证码')) return 'captcha'
        if (document.querySelector('img[src*="captcha"], #seccodeImage, .code-img') !== null && text.includes('验证')) {
          return 'captcha'
        }
        return undefined
      })
    } catch {
      return undefined
    }
  },

  async extractSources(page: Page) {
    const raw = await page.$$eval(
      '.results .vrwrap h3 a, .results .rb h3 a, .result h3 a',
      (anchors): Array<{ url: string, title: string, snippet?: string }> => {
        const out: Array<{ url: string, title: string, snippet?: string }> = []
        for (const anchor of anchors) {
          const container = anchor.closest('.vrwrap, .rb, .result')
          const snippet = container?.querySelector('.str-text-info, .str_info, .space-txt, p')
          out.push({
            url: anchor.getAttribute('href') ?? '',
            title: anchor.textContent ?? '',
            ...(snippet?.textContent !== undefined ? { snippet: snippet.textContent } : {}),
          })
        }
        return out
      },
    )
    return cleanSources(raw, 'sogou')
  },
}
