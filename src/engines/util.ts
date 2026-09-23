/**
 * Result-cleaning helpers shared by the engine adapters: raw in-page
 * extraction happens in the browser context; everything here post-processes
 * in Node — unwrapping engine redirect links, dropping internal navigation,
 * normalizing snippets, deduplicating, and capping.
 * @module dsh-human-search/engines/util
 */

import type { WebSearchSource } from '../dsh.ts'
import type { EngineId } from './types.ts'

/** What one engine's in-page extractor hands back. */
export interface RawSource {
  readonly url: string
  readonly title: string
  readonly snippet?: string
}

/** Unwrap `google.com/url?q=…`-style redirect wrappers to the target URL. */
export function unwrapRedirect(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '/url' || parsed.pathname.startsWith('/url/')) {
      const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url') ?? parsed.searchParams.get('sa')
      if (target !== null && target.startsWith('http')) return target
    }
    // Bing wraps organic links in `/ck/a?…&u=a1<base64url>`; the payload is
    // the target URL after the revision marker.
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/ck/a') {
      const payload = parsed.searchParams.get('u')
      if (payload !== null && payload.startsWith('a1')) {
        try {
          const decoded = atob(payload.slice(2).replace(/-/g, '+').replace(/_/g, '/'))
          if (decoded.startsWith('http')) return decoded
        } catch {
          // Malformed payload; keep the wrapper (it still resolves).
        }
      }
    }
    return url
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Hosts that are engine chrome, not organic results. */
const INTERNAL_HOSTS: Record<EngineId, readonly string[]> = {
  google: ['accounts.google.com', 'consent.google.com', 'myaccount.google.com', 'policies.google.com', 'support.google.com'],
  duckduckgo: ['duckduckgo.com', 'duck.co', 'spreadduckduckgo.com'],
  bing: ['login.live.com', 'account.microsoft.com', 'go.microsoft.com', 'bing.com/secure'],
  baidu: ['passport.baidu.com', 'wappass.baidu.com', 'i.baidu.com', 'passport.baidu.com/v2'],
  sogou: ['account.sogou.com', '123.sogou.com', 'fankui.sogou.com'],
}

/** Whether a URL is engine-internal navigation rather than a result. */
export function isInternalLink(url: string, engine: EngineId): boolean {
  if (!url.startsWith('http')) return true
  const host = hostOf(url)
  if (host === '') return true
  const internals = INTERNAL_HOSTS[engine]
  if (internals.some(internal => host === internal || host.endsWith(`.${internal}`))) return true
  // Same-engine search pages (pagination, vertical tabs) are not results.
  if (engine === 'google' && (host === 'www.google.com' || host === 'google.com')) {
    const path = new URL(url).pathname
    if (path === '/search' || path === '/url' || path === '/' || path.startsWith('/imgres')) return true
  }
  if (engine === 'bing' && (host === 'www.bing.com' || host === 'bing.com')) {
    const path = new URL(url).pathname
    if (path === '/search' || path === '/') return true
  }
  if (engine === 'baidu' && host === 'www.baidu.com') {
    const path = new URL(url).pathname
    if (path === '/' || path === '/s' || path.startsWith('/from')) return true
  }
  if (engine === 'sogou' && host === 'www.sogou.com') {
    const path = new URL(url).pathname
    if (path === '/' || path === '/web' || path === '/link') {
      // /link?url=… is sogou's organic redirect wrapper — keep those.
      if (path === '/link') return false
      return true
    }
  }
  return false
}

/** Collapse whitespace and truncate a snippet. */
export function cleanSnippet(text: string | undefined, max = 240): string | undefined {
  if (text === undefined) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return undefined
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed
}

/**
 * Turn raw in-page extraction into citeable sources: unwrap redirects, drop
 * internal and non-http links, require a title, clean snippets, deduplicate
 * by URL, and cap the count.
 */
export function cleanSources(raw: readonly RawSource[], engine: EngineId, max = 15): WebSearchSource[] {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of raw) {
    if (typeof item.url !== 'string' || typeof item.title !== 'string') continue
    const url = unwrapRedirect(item.url.trim())
    if (isInternalLink(url, engine)) continue
    const title = item.title.replace(/\s+/g, ' ').trim()
    if (title.length === 0) continue
    if (seen.has(url)) continue
    seen.add(url)
    const snippet = cleanSnippet(item.snippet)
    sources.push({ url, title, ...(snippet !== undefined ? { snippet } : {}) })
    if (sources.length >= max) break
  }
  return sources
}
