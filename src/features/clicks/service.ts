import type { Bot } from 'mineflayer'
import type MinecraftBot from '../../platform/minecraft-bot'
import type { ServiceResult } from '../../types'
import { getBotClient } from '../../platform/bot-client'
import { targetAtCrosshair, type ClickTarget } from './target'

export type ClickButton = 'attack' | 'use'
export type ClickMode = 'once' | 'continuous' | 'interval'
interface Action { mode: ClickMode; interval: number; remaining: number; offhand: boolean }

/** Carpet 风格 tick 调度；不持久化，掉线/死亡/切维度后必须手动重新开启。 */
export default class ClickService {
  private bot: Bot | null = null
  private actions: Partial<Record<ClickButton, Action>> = {}
  private ownUse = false
  private cooldown = 0
  private holdUse = false
  private paused = false
  private reason = ''

  constructor (private readonly mcBot: MinecraftBot, private readonly reach = 3) {}

  isActive (): boolean { return !!(this.actions.attack || this.actions.use) }

  status (compact = false): ServiceResult {
    const modes: Record<ClickMode, string> = { once: '单次', continuous: '持续', interval: '间隔' }
    const label = (a?: Action): string => a ? `${modes[a.mode]}${a.mode === 'interval' ? ` ${a.interval} tick` : ''}${a.offhand ? ' 副手' : ''}` : '停止'
    if (compact) {
      return { success: true, message: `左键:${label(this.actions.attack)} 右键:${label(this.actions.use)}${this.paused ? '（暂停）' : ''}` }
    }
    return { success: true, message: `左键：${label(this.actions.attack)}；右键：${label(this.actions.use)}${this.paused ? '（窗口/物品使用期间暂停）' : ''}${this.reason ? `；${this.reason}` : ''}` }
  }

  start (button: ClickButton, mode: ClickMode, interval = 1, offhand = false): ServiceResult {
    if (!['attack', 'use'].includes(button) || !['once', 'continuous', 'interval'].includes(mode) ||
        !Number.isInteger(interval) || interval < 1 || interval > 1200 || (button === 'attack' && offhand)) {
      return { success: false, message: '参数无效：间隔必须为 1–1200 tick；左键只支持主手' }
    }
    const bot = this.mcBot.bot
    if (!bot || !this.mcBot.isReady || bot.health <= 0) return { success: false, message: '机器人未就绪' }
    if (bot.game.gameMode === 'spectator') return { success: false, message: '旁观模式不能点击' }
    if (bot.currentWindow || (bot.usingHeldItem && !(this.bot === bot && this.ownUse))) return { success: false, message: '请先关闭窗口或结束物品使用' }
    if (this.bot !== bot) {
      this.stopAll()
      this.bot = bot
      bot.on('physicsTick', this.tick)
      bot.on('end', this.disconnected)
      bot.on('death', this.reset)
      bot.on('respawn', this.reset)
    }
    if (button === 'use') this.releaseUse()
    const period = mode === 'interval' ? interval : 1
    this.actions[button] = { mode, interval: period, remaining: period, offhand }
    this.reason = ''
    return { success: true, message: `已安排${button === 'attack' ? '左键' : '右键'} ${mode}${mode === 'interval' ? ` ${interval} tick` : ''}` }
  }

  stop (button: ClickButton): ServiceResult {
    if (button === 'use') this.releaseUse()
    delete this.actions[button]
    if (!this.isActive()) { this.releaseUse(); this.detach() }
    return { success: true, message: `已停止${button === 'attack' ? '左键' : '右键'}` }
  }

  stopAll (): void {
    this.releaseUse()
    this.actions = {}
    this.detach()
  }

  private detach (): void {
    this.bot?.removeListener('physicsTick', this.tick)
    this.bot?.removeListener('end', this.disconnected)
    this.bot?.removeListener('death', this.reset)
    this.bot?.removeListener('respawn', this.reset)
    this.bot = null
    this.paused = false
    this.cooldown = 0
  }

  private disconnected = (): void => {
    // 连接已结束，不再向旧连接发送释放包。
    this.ownUse = false
    this.stopAll()
    this.reason = '断线后已停止，重连不自动恢复'
  }

  private reset = (): void => {
    this.stopAll()
    this.reason = '死亡/重生/切维度后已停止'
  }

  private releaseUse (): void {
    if (this.ownUse && this.bot) {
      try { if (this.bot.usingHeldItem) this.bot.deactivateItem() } catch (err) { console.warn('[Clicks] 释放右键失败:', err) }
    }
    this.ownUse = false
    this.cooldown = 0
  }

  private tick = (): void => {
    const bot = this.bot
    if (!bot) return
    if (this.mcBot.bot !== bot || !this.mcBot.isReady) { this.disconnected(); return }
    if (bot.health <= 0 || bot.game.gameMode === 'spectator') { this.reset(); return }
    try {
      if (this.ownUse && !bot.usingHeldItem) this.ownUse = false
      // interval/once 在下一 tick 松手；continuous 保持使用，直到 stop 或服务端完成。
      if (this.ownUse && (this.actions.use?.mode !== 'continuous' || !this.holdUse)) {
        const cooldown = this.cooldown
        this.releaseUse()
        if (this.actions.use?.mode === 'continuous') this.cooldown = cooldown
      }
      if (bot.currentWindow || (bot.usingHeldItem && !this.ownUse)) {
        this.releaseUse()
        this.paused = true
        for (const action of Object.values(this.actions)) action.remaining = action.interval
        return
      }
      this.paused = false
      let used = this.ownUse
      for (const button of ['use', 'attack'] as const) {
        const action = this.actions[button]
        if (!action || --action.remaining > 0) continue
        action.remaining = action.interval
        if (button === 'use') {
          if (action.mode !== 'continuous') this.releaseUse()
          if (this.cooldown > 0) { this.cooldown--; used = true }
          else if (this.ownUse) used = true
          else {
            used = this.use(bot, targetAtCrosshair(bot, this.reach), action.offhand)
            if (used) this.cooldown = action.mode === 'continuous' ? 3 : 0
          }
        } else if (!used && !bot.currentWindow) {
          const target = targetAtCrosshair(bot, this.reach)
          if (target.kind === 'entity') bot.attack(target.entity)
          else bot.swingArm('right') // 用户选择仅攻击实体；不发送挖掘包。
        }
        if (action.mode === 'once') delete this.actions[button]
      }
      if (!this.isActive() && !this.ownUse) this.detach()
    } catch (err) {
      this.stopAll()
      this.reason = `交互异常，已停止：${err instanceof Error ? err.message : String(err)}`
      console.warn('[Clicks]', this.reason)
    }
  }

  private use (bot: Bot, target: ClickTarget, offhand: boolean): boolean {
    const client = getBotClient(bot)
    if (!client) throw new Error('游戏连接不可用')
    const hand = offhand ? 1 : 0
    const sneaking = bot.getControlState('sneak')
    if (target.kind === 'entity') {
      const hit = target.hit.minus(target.entity.position)
      client.write('use_entity', { target: target.entity.id, mouse: 2, hand, sneaking, x: hit.x, y: hit.y, z: hit.z })
      client.write('use_entity', { target: target.entity.id, mouse: 0, hand, sneaking })
      bot.swingArm(offhand ? 'left' : 'right')
      return true
    }
    if (target.kind === 'block') {
      if (!bot.supportFeature('blockPlaceHasInsideBlock')) throw new Error('此右键实现需要 Minecraft 1.14 或更新协议')
      const hit = target.hit.minus(target.position)
      client.write('block_place', { location: target.position, direction: target.face, hand,
        cursorX: hit.x, cursorY: hit.y, cursorZ: hit.z, insideBlock: false,
        sequence: 0, worldBorderHit: false })
      bot.swingArm(offhand ? 'left' : 'right')
      return true
    }
    const item = offhand ? bot.inventory.slots[45] : bot.heldItem
    if (!item) return false
    bot.activateItem(offhand)
    this.ownUse = true
    // Mineflayer 对任意物品都设 usingHeldItem；普通物品不能因此永久卡在“使用中”。
    this.holdUse = !!bot.registry.foodsByName?.[item.name] ||
      ['bow', 'crossbow', 'shield', 'trident', 'spyglass', 'potion', 'milk_bucket', 'goat_horn', 'brush'].includes(item.name)
    return true
  }
}
