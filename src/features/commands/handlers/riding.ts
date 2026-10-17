/** 骑乘指令处理：切换目标前先安全下马，保持骑乘状态管理器一致。 */
import type { CommandSource } from '../parser'
import type { CommandContext } from './types'
import { sleep } from '../../../platform/sleep'
import type { ServiceResult } from '../../../types'

export async function handleMount (
  ctx: CommandContext,
  username: string,
  target: string | undefined,
  source: CommandSource
): Promise<void> {
  const result = await mountPlayer(ctx, username, target)
  await ctx.reply(username, result.message || (result.success ? '已骑乘' : '骑乘失败'), source)
}

export async function mountPlayer (ctx: CommandContext, username: string, target?: string): Promise<ServiceResult> {
  if (ctx.teleportService.isLocked()) {
    return { success: false, message: 'bot 已锁定，无法骑乘' }
  }

  const targetName = target?.trim() || username
  const currentTarget = ctx.ridingManager.getTargetPlayer()
  if (
    ctx.ridingManager.getMode() === 'player' &&
    currentTarget === targetName &&
    ctx.playerInteraction.isMountedOn(targetName)
  ) {
    return { success: true, message: ctx.messages.text('mountAlready', { target: targetName }) }
  }

  // 已在其他骑乘模式时先完成下马，避免 Mineflayer 的实体状态残留。
  if (ctx.ridingManager.isActive()) {
    const dismounted = await ctx.ridingManager.dismount()
    if (!dismounted.success) {
      return { success: false, message: ctx.messages.text('unmountError', {
        message: dismounted.message || '下马失败'
      }) }
    }
    await sleep(400)
  }

  const result = await ctx.playerInteraction.mount(targetName)
  if (result.success) ctx.ridingManager.enterPlayerMode(targetName)
  return { success: result.success, message: result.success
    ? ctx.messages.text('mountSuccess', { message: result.message || '已骑乘' })
    : ctx.messages.text('mountError', { message: result.message || '骑乘失败' }) }
}

export async function handleUnmount (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  ctx.standby.cancelAfk()
  const result = await ctx.ridingManager.dismount()
  await ctx.reply(username, result.success
    ? ctx.messages.text('unmountSuccess', { message: result.message || '已下马' })
    : ctx.messages.text('unmountError', { message: result.message || '下马失败' }), source)
}

export async function handleCart (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  const result = await boardMinecart(ctx)
  await ctx.reply(username, result.message || (result.success ? '已上车' : '上车失败'), source)
}

export async function boardMinecart (ctx: CommandContext): Promise<ServiceResult> {
  if (ctx.teleportService.isLocked()) {
    return { success: false, message: 'bot 已锁定，无法上矿车' }
  }

  const ridingTarget = ctx.ridingManager.getTargetPlayer()
  if (
    ctx.ridingManager.getMode() === 'player' &&
    ridingTarget &&
    !ctx.playerInteraction.isMountedOn(ridingTarget)
  ) {
    ctx.ridingManager.clearMode()
  }

  const result = await ctx.minecartInteraction.boardNearest()
  if (result.success) ctx.ridingManager.enterMinecartMode()
  return { success: result.success, message: result.success
    ? ctx.messages.text('cartSuccess', { message: result.message || '已上车' })
    : ctx.messages.text('cartError', { message: result.message || '上车失败' }) }
}

