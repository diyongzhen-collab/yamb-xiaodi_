/** 空闲待命管理：空闲时回家并 AFK，但骑乘、锁定期间不打断当前动作。 */
import type { BotBehaviorConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { eatGoldenCarrotsUntilFull } from './food'
import { sleep } from '../../platform/sleep'

import type RidingManager from '../riding/manager'

const BACKOFF_MAX = 6
const MOVEMENT_THRESHOLD = 1.5

export default class StandbyManager {
  private mcBot: MinecraftBot
  private ridingManager: RidingManager | null = null
  private isLocked: () => boolean = () => false
  private isBusy: () => boolean = () => false
  setIsBusy (check: () => boolean): void { this.isBusy = check }
  private idleTimeoutMs: number
  private homeCommand: string
  private afkCommand: string
  private afkDelayMs: number
  private homeWaitMs: number
  private checkIntervalMs: number
  private resendAfkAtStandby: boolean
  private lastActivity = Date.now()
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private afkTimer: ReturnType<typeof setTimeout> | null = null
  private goingHome = false
  private consecutiveFailures = 0
  /** 最近一次 /home 后确认所在的待命点坐标；坐标未变化时用它避免反复执行 /home。 */
  private confirmedHomePosition: import('vec3').Vec3 | null = null
  /** 是否已在当前待命点发过 /afk（避免每 90s 重复发送并刷日志）。 */
  private afkAtStandby = false
  /** 自动 /home 成功后的回调（例如 TUI 标记当前位置为主城）。 */
  private onHome: (() => void) | null = null

  constructor (mcBot: MinecraftBot, config: BotBehaviorConfig) {
    this.mcBot = mcBot
    this.idleTimeoutMs = config.idleTimeoutMs
    this.homeCommand = config.homeCommand
    this.afkCommand = config.afkCommand
    this.afkDelayMs = config.afkDelayMs
    this.homeWaitMs = config.homeWaitMs
    this.checkIntervalMs = config.idleCheckIntervalMs
    this.resendAfkAtStandby = config.resendAfkAtStandby ?? false
  }

  setRidingManager (ridingManager: RidingManager): void {
    this.ridingManager = ridingManager
  }

  setIsLocked (isLocked: () => boolean): void {
    this.isLocked = isLocked
  }

  setOnHome (onHome: () => void): void {
    this.onHome = onHome
  }

  start (): void {
    if (this.checkTimer) return
    this.touch()
    this.afkAtStandby = false
    this.checkTimer = setInterval(() => {
      void this.checkIdle()
    }, this.checkIntervalMs)
    console.log(`[Standby] 空闲 ${this.idleTimeoutMs / 1000}s 后自动回家`)
  }

  stop (): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.cancelAfk()
  }

  touch (): void {
    this.lastActivity = Date.now()
  }

  cancelAfk (): void {
    if (this.afkTimer) {
      clearTimeout(this.afkTimer)
      this.afkTimer = null
    }
    // AFK 计划被取消（忙碌/停止等），视为尚未在待命点发过 /afk。
    this.afkAtStandby = false
  }

  scheduleAfk (attempt = 0): void {
    if (this.isBusy()) { this.cancelAfk(); return }
    // 已发过 /afk 且 bot 未移动（待命点附近或已锁定）：不重复发送，避免刷屏/切换状态。
    // 仅拦截首次调度；未落地重试（attempt > 0）需要继续执行。
    if (attempt === 0 && !this.resendAfkAtStandby && this.afkAtStandby) {
      const bot = this.mcBot.bot
      const atStandby = !!bot && !!this.confirmedHomePosition &&
        bot.entity.position.distanceTo(this.confirmedHomePosition) <= MOVEMENT_THRESHOLD
      if (atStandby || this.isLocked()) return
    }
    if (this.afkTimer) clearTimeout(this.afkTimer)
    const delay = attempt === 0 ? this.afkDelayMs : 1000
    this.afkTimer = setTimeout(() => {
      if (this.isBusy()) return
      const bot = this.mcBot.bot
      // 骑乘时 onGround 恒为 false，应照常 AFK；仅意外半空时推迟
      const riding = this.ridingManager?.isActive() ?? false
      if (bot && !bot.entity.onGround && !riding && !this.isLocked()) {
        if (attempt >= 10) {
          console.log('[Standby] 多次未落地，放弃本次 AFK')
          return
        }
        console.log(`[Standby] 未落地，推迟 AFK (${attempt + 1}/10)`)
        this.scheduleAfk(attempt + 1)
        return
      }
      if (this.mcBot.chat(this.afkCommand)) {
        console.log(`[Standby] 执行 ${this.afkCommand}`)
      }
    }, delay)
    // 已计划发出 /afk：在待命点时不重复调度，避免每周期刷屏。
    this.afkAtStandby = true
  }

  private async checkIdle (): Promise<void> {
    if (this.isBusy()) { this.touch(); return }
    if (!this.mcBot.isReady || this.goingHome) return
    // 空闲 / 骑乘 / 锁定互斥：锁定与骑乘时不进入待命回家
    if (this.isLocked()) {
      this.scheduleAfk()
      this.touch()
      return
    }
    if (this.ridingManager?.isActive()) return
    const effectiveTimeout = this.idleTimeoutMs * Math.pow(2, Math.min(this.consecutiveFailures, BACKOFF_MAX))
    if (Date.now() - this.lastActivity < effectiveTimeout) return

    // 已在待命点（最近一次 /home 后确认的坐标附近）时不再反复发 /home，直接进入 AFK。
    const bot = this.mcBot.bot
    if (bot && this.confirmedHomePosition) {
      const distanceToHome = bot.entity.position.distanceTo(this.confirmedHomePosition)
      if (distanceToHome <= MOVEMENT_THRESHOLD) {
        if (!this.afkAtStandby || this.resendAfkAtStandby) {
          console.log('[Standby] 已在待命点，跳过 /home 直接 AFK')
          this.scheduleAfk()
        }
        this.touch()
        return
      }
    }

    await this.goHomeStandby()
  }

  async goHomeStandby (): Promise<void> {
    if (this.isBusy()) return
    if (!this.mcBot.isReady || !this.mcBot.bot || this.goingHome) return
    if (this.isLocked()) {
      this.scheduleAfk()
      return
    }

    this.goingHome = true
    // 进入新的回家周期：等待新坐标确定后重新发一次 /afk。
    this.afkAtStandby = false
    const backoffSec = (this.idleTimeoutMs * Math.pow(2, Math.min(this.consecutiveFailures, BACKOFF_MAX))) / 1000
    console.log(`[Standby] 超过 ${backoffSec}s 无互动，执行 ${this.homeCommand}`)

    try {
      const bot = this.mcBot.bot
      const posBefore = bot.entity.position.clone()

      const sent = this.mcBot.chat(this.homeCommand)
      if (!sent) {
        this.consecutiveFailures++
        console.warn(`[Standby] ${this.homeCommand} 未能发送 (${this.consecutiveFailures} 次失败)`)
        return
      }
      await sleep(this.homeWaitMs)

      if (this.isLocked()) {
        this.scheduleAfk()
        return
      }

      const botAfter = this.mcBot.bot
      if (!botAfter) return

      const moved = posBefore.distanceTo(botAfter.entity.position) > MOVEMENT_THRESHOLD

      if (!moved) {
        // Some servers accept /home while the player is already at the destination,
        // or teleport to an identical coordinate. A missing position delta is not
        // reliable evidence that the command failed.
        console.log(`[Standby] ${this.homeCommand} 后坐标未变化，按已在待命点处理`)
      }
      // 无论是否发生位移，执行 /home 后都以当前坐标为“待命点”，
      // 供 checkIdle 判断是否已在待命点，避免空闲时反复发送 /home。
      this.confirmedHomePosition = botAfter.entity.position.clone()
      this.onHome?.()
      this.consecutiveFailures = 0
      await eatGoldenCarrotsUntilFull(botAfter)
      this.scheduleAfk()
      this.touch()
    } catch (err) {
      console.error('[Standby] 回家待命失败:', (err as Error).message)
    } finally {
      this.goingHome = false
    }
  }
}
