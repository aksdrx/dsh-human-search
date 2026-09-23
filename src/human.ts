/**
 * Human-like interaction helpers: the small behavioral details — per-character
 * typing with jitter, breathing pauses before and after actions — that keep
 * automated use of a search engine closer to how a person uses it.
 * @module dsh-human-search/human
 */

import type { Page } from 'playwright'

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A random integer in `[base, base + spread]`. */
export function jitter(base: number, spread: number): number {
  return base + Math.floor(Math.random() * (spread + 1))
}

/** A short pause a person takes between noticing a box and typing into it. */
export function humanPause(): Promise<void> {
  return sleep(jitter(250, 650))
}

/**
 * Type text into the currently focused element the way a person does:
 * character by character, each keystroke delayed a little differently, with
 * occasional slightly-longer pauses — for example after a word boundary.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  for (const char of text) {
    await page.keyboard.type(char, { delay: 0 })
    if (char === ' ') {
      await sleep(jitter(70, 180))
    } else {
      await sleep(jitter(35, 120))
    }
    // Rare mid-word hesitation, as when glancing back at the query.
    if (Math.random() < 0.04) await sleep(jitter(150, 400))
  }
}
