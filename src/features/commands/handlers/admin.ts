import type { CommandSource } from '../parser'
import type { CommandContext } from './types'
import { sleep } from '../../../platform/sleep'

export async function handleAdd (
  ctx: CommandContext,
  username: string,
  gameName: string | undefined,
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  if (!gameName) {
    await ctx.reply(username, ctx.messages.text('addUsage'), source)
    return
  }
  if (ctx.whitelist.isAllowed(gameName)) {
    await ctx.reply(username, ctx.messages.text('addAlready', { gameName }), source)
    return
  }

  ctx.whitelist.add(gameName, username)
  await ctx.reply(username, ctx.messages.text('addSuccess', { gameName }), source)
}

export async function handleRemove (
  ctx: CommandContext,
  username: string,
  gameName: string | undefined,
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  if (!gameName) {
    await ctx.reply(username, ctx.messages.text('removeUsage'), source)
    return
  }
  if (!ctx.whitelist.isAllowed(gameName)) {
    await ctx.reply(username, ctx.messages.text('removeNotFound', { gameName }), source)
    return
  }

  ctx.whitelist.remove(gameName)
  await ctx.reply(username, ctx.messages.text('removeSuccess', { gameName }), source)
}

export async function handleSay (
  ctx: CommandContext,
  username: string,
  message: string,
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  if (!message) {
    await ctx.reply(username, ctx.messages.text('sayUsage'), source)
    return
  }

  const result = ctx.gameApiService.say(message)
  await ctx.reply(username, result.success
    ? ctx.messages.text('saySuccess')
    : ctx.messages.text('sayError', { message: result.message || '发送失败' }), source)
}

/** 白名单可触发的指定服务器指令。任意公屏内容仍走 say，仅管理员可用。 */
async function sendAllowedServerCommand (
  ctx: CommandContext,
  username: string,
  source: CommandSource,
  command: string,
  bypassLock = false
): Promise<void> {
  const result = ctx.gameApiService.say(command, bypassLock)
  await ctx.reply(username, result.success
    ? ctx.messages.text('saySuccess')
    : ctx.messages.text('sayError', { message: result.message || '发送失败' }), source)
}

export async function handleHome (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  await sendAllowedServerCommand(ctx, username, source, '/home')
}

export async function handleSignin (
  ctx: CommandContext,
  username: string,
  source: CommandSource
): Promise<void> {
  // 签到不移动 bot，锁定期间仍可执行。
  await sendAllowedServerCommand(ctx, username, source, '/tsl signin click', true)
}

export async function handleForward (
  ctx: CommandContext,
  username: string,
  message: string,
  source: CommandSource,
  /** 定时任务路径传入 true：与定时 say 一致，锁定期间仍可发言（锁定只挡动作，不挡发言）。 */
  bypassLock = false
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }
  if (!message) {
    await ctx.reply(username, ctx.messages.text('forwardUsage'), source)
    return
  }

  const sentAt = Date.now()
  const result = ctx.gameApiService.say(message, bypassLock)
  if (!result.success) {
    await ctx.reply(username, ctx.messages.text('forwardError', { message: result.message || '发送失败' }), source)
    return
  }

  await sleep(ctx.forwardWaitMs)
  const systemLines = ctx.systemBuffer.collect(sentAt, ctx.forwardWaitMs)

  if (systemLines.length === 0) {
    await ctx.reply(username, ctx.messages.text('forwardEmpty'), source)
    return
  }

  await ctx.reply(username, systemLines.join('\n'), source)
}
