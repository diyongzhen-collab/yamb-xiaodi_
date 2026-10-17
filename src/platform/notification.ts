/** 运行事件通知队列：记录掉线/重连等需要主动通知外部的消息，供 AstrBot 插件拉取。 */
export interface BotNotice {
  id: number
  time: string
  message: string
}

export default class NotificationService {
  private notices: BotNotice[] = []
  private nextId = 1

  add (message: string): void {
    this.notices.push({
      id: this.nextId++,
      time: new Date().toISOString(),
      message
    })
    // 防止长时间未拉取时无限堆积（只保留最近 200 条）。
    if (this.notices.length > 200) {
      this.notices.splice(0, this.notices.length - 200)
    }
  }

  /** 一次性取走全部未读事件（AstrBot 插件为唯一消费者）。 */
  drain (): BotNotice[] {
    const result = this.notices
    this.notices = []
    return result
  }

  count (): number {
    return this.notices.length
  }
}
