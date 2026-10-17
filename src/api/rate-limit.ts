/** 滑动窗口限流；过期来源定期回收，活跃来源数量设上限。 */
export default class RequestRateLimit {
  private readonly hits = new Map<string, number[]>()
  private nextSweepAt = 0

  constructor (
    private readonly windowMs = 60_000,
    private readonly maxRequests = 120,
    private readonly maxSources = 10_000
  ) {}

  allow (source: string, now = Date.now()): boolean {
    if (now >= this.nextSweepAt) {
      for (const [key, times] of this.hits) {
        if (now - times[times.length - 1] >= this.windowMs) this.hits.delete(key)
      }
      this.nextSweepAt = now + this.windowMs
    }
    const times = (this.hits.get(source) ?? []).filter(time => now - time < this.windowMs)
    if (times.length >= this.maxRequests) return false
    // 不驱逐尚未过期的来源，否则轮换地址会重置原有来源的限制。
    if (!this.hits.has(source) && this.hits.size >= this.maxSources) return false
    times.push(now)
    this.hits.set(source, times)
    return true
  }
}
