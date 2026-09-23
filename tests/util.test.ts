/**
 * Extraction-cleaning unit tests over `src/engines/util.ts`.
 * @module dsh-human-search/tests/util
 */

import { describe, expect, it } from 'vitest'
import { cleanSnippet, cleanSources, isInternalLink, unwrapRedirect } from '../src/engines/util.ts'

describe('unwrapRedirect', () => {
  it('unwraps google /url?q= wrappers', () => {
    expect(unwrapRedirect('https://www.google.com/url?q=https://example.com/a&rct=j')).toBe('https://example.com/a')
  })
  it('unwraps relative /url wrappers via the url parameter', () => {
    expect(unwrapRedirect('https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Fb')).toBe('https://example.com/b')
  })
  it('keeps ordinary urls and tolerates garbage', () => {
    expect(unwrapRedirect('https://example.com/x')).toBe('https://example.com/x')
    expect(unwrapRedirect('not a url')).toBe('not a url')
  })
})

describe('isInternalLink', () => {
  it('drops non-http and engine chrome', () => {
    expect(isInternalLink('about:blank', 'google')).toBe(true)
    expect(isInternalLink('https://accounts.google.com/signin', 'google')).toBe(true)
    expect(isInternalLink('https://consent.google.com/m', 'google')).toBe(true)
    expect(isInternalLink('https://www.google.com/search?q=x', 'google')).toBe(true)
  })
  it('keeps organic-looking links on engine hosts', () => {
    expect(isInternalLink('https://news.google.com/articles/1', 'google')).toBe(false)
    expect(isInternalLink('https://books.google.com/books?id=1', 'google')).toBe(false)
  })
  it('keeps baidu and sogou redirect links, drops their auth hosts', () => {
    expect(isInternalLink('https://www.baidu.com/link?url=abc', 'baidu')).toBe(false)
    expect(isInternalLink('https://wappass.baidu.com/captcha', 'baidu')).toBe(true)
    expect(isInternalLink('https://www.sogou.com/link?url=xyz', 'sogou')).toBe(false)
    expect(isInternalLink('https://account.sogou.com/x', 'sogou')).toBe(true)
  })
})

describe('cleanSnippet', () => {
  it('collapses whitespace and truncates', () => {
    expect(cleanSnippet('  a \n b ')).toBe('a b')
    const long = cleanSnippet('x'.repeat(300))
    expect(long?.length).toBe(241)
    expect(long?.endsWith('…')).toBe(true)
  })
  it('returns undefined for empty input', () => {
    expect(cleanSnippet(undefined)).toBeUndefined()
    expect(cleanSnippet('   ')).toBeUndefined()
  })
})

describe('cleanSources', () => {
  it('requires titles, dedupes, unwraps, and caps', () => {
    const raw = [
      { url: 'https://www.google.com/url?q=https://a.example/1', title: 'A', snippet: 'about a' },
      { url: 'https://a.example/1', title: 'A2', snippet: 'dup' },
      { url: 'https://b.example/2', title: '  ', snippet: 'no title' },
      { url: 'https://c.example/3', title: 'C' },
      { url: 'https://accounts.google.com/x', title: 'Internal' },
    ]
    const sources = cleanSources(raw, 'google')
    expect(sources.map(source => source.url)).toEqual(['https://a.example/1', 'https://c.example/3'])
    expect(sources[0]?.snippet).toBe('about a')
    expect(sources[1]?.snippet).toBeUndefined()
  })
  it('caps at max', () => {
    const raw = Array.from({ length: 10 }, (_, index) => ({ url: `https://x.example/${String(index)}`, title: `T${String(index)}` }))
    expect(cleanSources(raw, 'bing', 3)).toHaveLength(3)
  })
})
