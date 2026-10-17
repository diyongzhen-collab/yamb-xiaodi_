/** 玩家骑乘交互。 */
import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { sleep } from '../../platform/sleep'
import {
  approachEntity,
  entityDistance,
  entityLookPoint,
  getPlayerEntity,
  isMountedOnPlayer
} from '../shared/entity-utils'


export default class PlayerInteractionService {

  private mcBot: MinecraftBot
  private interactionDistance: number
  private approachDistance: number

  constructor (
    mcBot: MinecraftBot,
    interactionDistance: number,
    approachDistance: number
  ) {
    this.mcBot = mcBot
    this.interactionDistance = interactionDistance
    this.approachDistance = approachDistance
  }

  isPlayerInRange (targetName: string): boolean {
    const bot = this.mcBot.bot
    if (!bot) return false
    const entity = getPlayerEntity(bot, targetName)
    return !!entity && entityDistance(bot, entity) <= this.approachDistance
  }

  isMountedOn (targetName: string): boolean {
    return !!this.mcBot.bot && isMountedOnPlayer(this.mcBot.bot, targetName)
  }

  async mount (targetName: string): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const entity = getPlayerEntity(bot, targetName)
    if (!entity) {
      return { success: false, message: `玩家 ${targetName} 不在线或不可见` }
    }

    const approach = await approachEntity(bot, entity, this.interactionDistance, this.approachDistance)
    if (!approach.success) return approach

    try {
      const mounted = await this.tryMountPlayer(bot, targetName)
      const distance = entityDistance(bot, getPlayerEntity(bot, targetName) ?? entity).toFixed(1)
      if (mounted) {
        console.log(`[Interaction] Mounted ${targetName} (distance ${distance})`)
        return { success: true, message: `已骑乘 ${targetName}` }
      }
      return { success: false, message: '未能骑乘，请确认距离与服务器插件支持' }
    } catch (err) {
      console.error('[Interaction] Mount failed:', (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }

  async remountPlayer (targetName: string): Promise<boolean> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) return false

    const entity = getPlayerEntity(bot, targetName)
    if (!entity) return false

    const approach = await approachEntity(bot, entity, this.interactionDistance, this.approachDistance)
    return approach.success && this.tryMountPlayer(bot, targetName)
  }

  private async tryMountPlayer (bot: Bot, targetName: string): Promise<boolean> {
    const maxAttempts = 4
    await bot.unequip('hand')
    await sleep(100)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entity = getPlayerEntity(bot, targetName)
      if (!entity) return false

      await bot.activateEntityAt(entity, entityLookPoint(entity))
      await sleep(500)
      if (isMountedOnPlayer(bot, targetName)) return true

      if (attempt < maxAttempts) await sleep(250)
    }

    return isMountedOnPlayer(bot, targetName)
  }
}
