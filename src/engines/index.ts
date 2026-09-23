/**
 * The engine registry: adapter instances keyed by engine id.
 * @module dsh-human-search/engines
 */

import type { EngineAdapter, EngineId } from './types.ts'
import { baiduAdapter } from './baidu.ts'
import { bingAdapter } from './bing.ts'
import { duckduckgoAdapter } from './duckduckgo.ts'
import { googleAdapter } from './google.ts'
import { sogouAdapter } from './sogou.ts'

/** Every shipped adapter. */
export const ADAPTERS: ReadonlyMap<EngineId, EngineAdapter> = new Map<EngineId, EngineAdapter>([
  [googleAdapter.id, googleAdapter],
  [duckduckgoAdapter.id, duckduckgoAdapter],
  [bingAdapter.id, bingAdapter],
  [baiduAdapter.id, baiduAdapter],
  [sogouAdapter.id, sogouAdapter],
])
