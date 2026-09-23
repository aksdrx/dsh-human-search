/**
 * The Baidu adapter: Chinese locale by default, `#kw` typing flow,
 * `wappass.baidu.com` security-verification detection, and extraction from
 * `#content_left` result containers. Baidu result URLs are `baidu.com/link`
 * redirects; they are kept as-is — they resolve for the reader.
 * @module dsh-human-search/engines/baidu
 */

import type { Page } from 'playwright'
import type { EngineAdapter } from './types.ts'
import { cleanSources } from './util.ts'

export const baiduAdapter: EngineAdapter = {
  id: 'baidu',
  label: 'Baidu',
  defaultLocale: 'zh-CN',
  homeUrl: () => 'https://www.baidu.com/',
  loginUrl: () => 'https://passport.baidu.com/',
  searchUrl: (_locale, query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  searchBoxSelector: 'input#kw, input[name="wd"]',
  resultSelector: '#content_left .result h3 a, #content_left .c-container h3 a',
  settleMs: 4_000,

  async blockedReason(page: Page): Promise<string | undefined> {
    try {
      const url = page.url()
      if (url.includes('wappass.baidu.com') || url.includes('verify')) return 'security-verification'
      return await page.evaluate((): string | undefined => {
        const text = document.body?.innerText ?? ''
        if (text.includes('安全验证') || text.includes('百度安全验证')) return 'security-verification'
        if (text.includes('请输入验证码') || text.includes('验证码')) {
          // The word alone can appear in ads; require it near a form marker.
          if (document.querySelector('img[src*="captcha"], .passMod_dialog-container, #seccodeImage') !== null) {
            return 'captcha'
          }
        }
        return undefined
      })
    } catch {
      return undefined
    }
  },

  async extractSources(page: Page) {
    const raw = await page.$$eval(
      '#content_left .result h3 a, #content_left .c-container h3 a',
      (anchors): Array<{ url: string, title: string, snippet?: string }> => {
        const out: Array<{ url: string, title: string, snippet?: string }> = []
        for (const anchor of anchors) {
          const container = anchor.closest('.result, .c-container')
          const snippet = container?.querySelector('.c-abstract, [class*="content-right"], .c-span-last')
          out.push({
            url: anchor.getAttribute('href') ?? '',
            title: anchor.textContent ?? '',
            ...(snippet?.textContent !== undefined ? { snippet: snippet.textContent } : {}),
          })
        }
        return out
      },
    )
    return cleanSources(raw, 'baidu')
  },
}
