import type { MessageQueueConfig, QueueStatus, QueueTask } from '../types'
import type MinecraftBot from './minecraft-bot'

export default class MessageQueue {
  private queue: QueueTask[] = []
  private isProcessing = false
  private maxSize: number
  private delayMs: number
  private bot: MinecraftBot | null = null
  /** 被踢/清空时递增，作废已 shift 出队列、仍在 delay timer 里的那条消息。 */
  private epoch = 0
  private sendTimer: ReturnType<typeof setTimeout> | null = null

  constructor (options: Partial<MessageQueueConfig> = {}) {
    this.maxSize = options.maxSize ?? 100
    this.delayMs = options.delayMs ?? 1000
  }

  setBot (bot: MinecraftBot): void {
    this.bot = bot
  }

  enqueue (task: { kind: 'chat' | 'whisper'; message: string; username?: string; sender?: string | null }): boolean {
    const message = task.message.trim()
    if (!message || (task.kind === 'whisper' && !task.username?.trim())) return false

    if (this.queue.length > 0) {
      const last = this.queue[this.queue.length - 1]
      if (last.message === message && last.sender === (task.sender ?? null) && last.kind === task.kind &&
        last.username === task.username) {
        return true
      }
    }

    if (this.queue.length >= this.maxSize) {
      console.warn(`[Queue] 队列已满 (${this.maxSize})，消息未入队`)
      return false
    }

    this.queue.push({
      kind: task.kind,
      username: task.username,
      message,
      sender: task.sender || null,
      timestamp: Date.now()
    })

    if (!this.isProcessing) {
      this.process()
    }
    return true
  }

  process (): void {
    if (this.isProcessing || this.queue.length === 0) return
    this.isProcessing = true

    const task = this.queue.shift()
    if (!task) {
      this.isProcessing = false
      return
    }

    const epoch = this.epoch
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null
      // clear() 之后这条已作废：可能是把 bot 踢出去的那条，不能再入队。
      if (epoch !== this.epoch) return

      const requeue = (): void => {
        if (epoch !== this.epoch) return
        // 发送失败时放回队首稍后重试，而不是丢弃消息。
        this.queue.unshift(task)
        if (this.queue.length > this.maxSize) {
          this.queue.pop()
        }
      }

      try {
        if (!this.bot) {
          console.warn('[Queue] Bot 未就绪，消息稍后重试:', task.message)
          requeue()
        } else {
          const ok = task.kind === 'whisper'
            ? this.bot.sendWhisperDirect(task.username ?? '', task.message)
            : this.bot.sendChatDirect(task.message)
          if (!ok) {
            console.warn('[Queue] Bot 未就绪，消息稍后重试:', task.message)
            requeue()
          } else {
            const label = task.kind === 'whisper' ? `私聊 ${task.username}` : '公屏'
            console.log(`[Queue] 发送${label}: ${task.message} (来自: ${task.sender || '系统'})`)
          }
        }
      } catch (error) {
        console.error('[Queue] 发送消息失败，稍后重试:', error)
        requeue()
      }

      if (epoch !== this.epoch) return
      this.isProcessing = false

      if (this.queue.length > 0) {
        this.process()
      }
    }, this.delayMs)
  }

  clear (): void {
    this.queue = []
    this.epoch++
    if (this.sendTimer) {
      clearTimeout(this.sendTimer)
      this.sendTimer = null
    }
    this.isProcessing = false
    console.log('[Queue] 队列已清空')
  }

  getStatus (): QueueStatus {
    return {
      size: this.queue.length,
      isProcessing: this.isProcessing,
      isLocked: this.isProcessing,
      maxSize: this.maxSize
    }
  }
}
