import type { RateLimit } from '../config'
export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }
const MAX_KEYS = 50_000
const PRUNE_EVERY_MS = 60_000

export class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()
  private lastPrune: number
  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {
    this.lastPrune = now()
  }
  take(key: string): LimitResult {
    const time = this.now()
    if (time - this.lastPrune >= PRUNE_EVERY_MS) this.prune(time)
    let entry = this.entries.get(key)
    if (!entry || entry.resetAt <= time) {
      if (!entry && this.entries.size >= MAX_KEYS) {
        const oldest = this.entries.keys().next()
        if (!oldest.done) this.entries.delete(oldest.value)
      }
      entry = { count: 0, resetAt: time + this.limit.windowMs }
      this.entries.set(key, entry)
    }
    entry.count += 1
    if (entry.count > this.limit.max) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) }
    }
    return { ok: true }
  }
  private prune(time: number) {
    this.lastPrune = time
    for (const [key, entry] of this.entries) if (entry.resetAt <= time) this.entries.delete(key)
  }
}

export class Budget {
  private tokens: number
  private last: number
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perSecond * 2
    this.last = now()
  }

  tryTake(): boolean {
    const time = this.now()
    this.tokens = Math.min(this.perSecond * 2, this.tokens + ((time - this.last) / 1000) * this.perSecond)
    this.last = time
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
