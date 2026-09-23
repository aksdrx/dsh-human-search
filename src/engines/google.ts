/**
 * The Google adapter: home-page typing flow, EU consent handling, `/sorry`
 * CAPTCHA and unusual-traffic detection, and organic-result extraction from
 * `#search` anchors wrapping `h3` headings.
 * @module dsh-human-search/engines/google
 */

import type { Page } from 'playwright'
import type { EngineAdapter } from './types.ts'
import { cleanSources, type RawSource } from './util.ts'

/** Consent accept-button selectors across Google's consent dialog variants. */
const CONSENT_BUTTONS = [
  'button#L2AGLb',
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept the use of cookies"]',
  'form[action*="consent"] button',
  'button:has-text("Accept all")',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Tout accepter")',
  'button:has-text("Accepter tout")',
  'button:has-text("全部接受")',
  'button:has-text("接受全部")',
  'button:has-text("Принять все")',
]

export const googleAdapter: EngineAdapter = {
  id: 'google',
  label: 'Google',
  defaultLocale: 'en-US',
  homeUrl: () => 'https://www.google.com/',
  loginUrl: () => 'https://accounts.google.com/',
  searchBoxSelector: 'textarea[name="q"], input[name="q"]',
  resultSelector: '#search a h3, #rso a h3',
  settleMs: 6_000,

  async prepare(page: Page): Promise<void> {
    // The EU consent wall has no organic markup to wait for; probe the known
    // accept buttons and click the first visible one, ignoring absence.
    for (const selector of CONSENT_BUTTONS) {
      try {
        const button = page.locator(selector).first()
        if (await button.isVisible({ timeout: 400 })) {
          await button.click({ timeout: 1_500 })
          await page.waitForLoadState('domcontentloaded').catch(() => {})
          return
        }
      } catch {
        // Not this variant; try the next.
      }
    }
  },

  async blockedReason(page: Page): Promise<string | undefined> {
    try {
      const url = page.url()
      if (url.includes('/sorry/') || url.includes('/svc/captcha')) return 'captcha'
      return await page.evaluate((): string | undefined => {
        const text = document.body?.innerText ?? ''
        if (document.querySelector('iframe[src*="recaptcha"], #recaptcha, g-recaptcha') !== null) return 'captcha'
        if (text.includes('unusual traffic') || text.includes('not a robot')) return 'unusual-traffic'
        if (text.includes('Before you continue to Google') || text.includes('before you continue')) return 'consent-wall'
        return undefined
      })
    } catch {
      return undefined
    }
  },

  async extractSources(page: Page) {
    const raw = await page.$$eval(
      '#search a[href], #rso a[href]',
      (anchors): Array<{ url: string, title: string, snippet?: string }> => {
        const out: Array<{ url: string, title: string, snippet?: string }> = []
        for (const anchor of anchors) {
          const heading = anchor.querySelector('h3')
          if (heading === null) continue
          const container = heading.closest('div[data-snhf]') ?? heading.parentElement?.parentElement ?? null
          const snippet = container?.textContent ?? undefined
          out.push({
            url: anchor.getAttribute('href') ?? '',
            title: heading.textContent ?? '',
            ...(snippet !== undefined ? { snippet } : {}),
          })
        }
        return out
      },
    )
    return cleanSources(raw, 'google')
  },
}
