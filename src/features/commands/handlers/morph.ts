/**
 * 娱乐功能：Morph 变身（配合服务器 Morph 插件）。
 * - morph <玩家名> / 变成 <玩家名>：向目标发送 /request send；
 *   监听服务器广播，检测到目标同意后等 5 秒执行 /morph player:<目标>；
 * - morph（无参数，固定短语「变成我」）：目标为发起者自己；
 * - 变身指令发送成功 10 分钟后恢复配置的形态；期间再次变身会重置恢复计时。
 * - 若 1 分钟内未收到同意广播，自动取消并通知发起者。
 */
import type { CommandSource } from '../parser'
import type { CommandContext } from './types'
import { stripColorCodes, componentToText } from '../../../platform/chat-utils'
import { getBotClient } from '../../../platform/bot-client'
import type { ServiceResult } from '../../../types'

/** 变身持续时长：10 分钟后自动恢复原形。 */
const MORPH_DURATION_MS = 10 * 60 * 1000
/** 收到同意广播后再等待的时间，随后执行变身命令。 */
const MORPH_AGREE_WAIT_MS = 5000
/** 等待对方同意的总超时：超时未收到同意则取消请求。 */
const MORPH_AGREE_TIMEOUT_MS = 60 * 1000

/**
 * 10 分钟恢复时变身的形态名。
 * 注意：不能用 bot 账号名（xiaodi___ 从未解锁，会被服务器拒绝 "You don't have that disguise yet"），
 * 使用服务器上已解锁的形态（xiaodi_，日志验证过 "You already have their disguise!"）。
 */
const MORPH_RESTORE_TARGET = 'xiaodi_'

/**
 * 同意广播的识别关键词：消息同时包含目标玩家名与任一关键词才视为同意。
 * 覆盖常见格式（含服务器英文广播）：
 * - "yuri_fan accepted your request!"
 * - "✔ Unlocked disguise of yuri_fan!"
 * - 中文「接受了请求 / 同意 / 解锁了X的形态」
 */
const MORPH_ACCEPT_KEYWORDS = ['接受', '同意', 'accepted', 'accept', '解锁', 'unlocked']

/** 每个连接所有者只保留一条变身流程；重连和后续请求使旧流程失效。 */
const sessions = new WeakMap<CommandContext['mcBot'], () => void>()

function isMorphAcceptMessage (text: string, target: string): boolean {
  const lower = text.toLowerCase()
  if (!lower.includes(target.toLowerCase())) return false
  return MORPH_ACCEPT_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()))
}

export async function handleMorph (
  ctx: CommandContext,
  username: string,
  target: string | undefined,
  source: CommandSource
): Promise<void> {
  const result = await requestMorph(ctx, username, target, source)
  await ctx.reply(username, result.message || '变身请求处理完成', source)
}

/** 文字命令与 AI 共用流程，返回提交结果，后续结果仍通过 reply 通知。 */
export async function requestMorph (
  ctx: CommandContext,
  username: string,
  target: string | undefined,
  source: CommandSource
): Promise<ServiceResult> {
  const botName = ctx.mcBot.bot?.username
  const rawTarget = (target || username).trim()
  if (!rawTarget) {
    return { success: false, message: '找不到目标玩家' }
  }
  if (botName && rawTarget.toLowerCase() === botName.toLowerCase()) {
    return { success: false, message: '目标不能是 bot 自己' }
  }

  // 目标经在线玩家模糊匹配解析（与 players 命令同一套算法）：
  // 精确命中直接用；多个候选提示完整名；无候选则报错。
  let targetName = rawTarget
  const search = ctx.gameApiService.findPlayers(rawTarget)
  if (!search.success) {
    return { success: false, message: `查询在线玩家失败：${search.message || '机器人未就绪'}` }
  }
  const matched = search.players ?? []
  // 输入即为完整名（精确命中）时直接采用，避免近似玩家（编辑距离匹配）干扰唯一性。
  const exact = matched.find(name => name.toLowerCase() === rawTarget.toLowerCase())
  if (exact) {
    targetName = exact
  } else if (matched.length === 0) {
    return { success: false, message: `没有找到与 “${rawTarget}” 接近的在线玩家，请确认名字后重试` }
  } else if (matched.length > 1) {
    return { success: false, message: `“${rawTarget}” 匹配到多个玩家：${matched.join('、')}，请发送完整名字` }
  } else {
    targetName = matched[0]
  }

  const bot = ctx.mcBot.bot
  if (!bot || !ctx.mcBot.isReady) {
    return { success: false, message: 'bot 尚未就绪，请稍后再试' }
  }

  sessions.get(ctx.mcBot)?.()
  const client = getBotClient(bot)
  let active = true
  let waiting = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearPending = (): void => {
    waiting = false
    bot.removeListener('messagestr', onMessage)
    client?.removeListener('system_chat', onSystemChat)
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const cleanup = (): void => {
    active = false
    clearPending()
    bot.removeListener('end', cleanup)
    if (sessions.get(ctx.mcBot) === cleanup) sessions.delete(ctx.mcBot)
  }
  const isCurrent = (): boolean => active && ctx.mcBot.bot === bot && ctx.mcBot.isReady
  const notify = (message: string): void => {
    void ctx.reply(username, message, source).catch(err => console.warn('[Morph] 回复失败:', err))
  }
  const applyMorph = (): void => {
    if (!isCurrent()) { cleanup(); return }
    try {
      const result = ctx.gameApiService.say(`/morph player:${targetName}`)
      if (!result.success) {
        cleanup()
        notify(`变身指令未发送：${result.message || '机器人未就绪'}`)
        return
      }
      // 从实际提交变身指令开始计时，超时/失败的请求不会触发恢复。
      timer = setTimeout(() => {
        if (!isCurrent()) { cleanup(); return }
        cleanup()
        try {
          const result = ctx.gameApiService.say(`/morph player:${MORPH_RESTORE_TARGET}`)
          if (!result.success) notify(`恢复形态指令未发送：${result.message || '机器人未就绪'}`)
        } catch (err) { console.warn('[Morph] 恢复形态失败:', err) }
      }, MORPH_DURATION_MS)
    } catch (err) {
      cleanup()
      console.warn('[Morph] 变身失败:', err)
      notify('变身指令发送失败')
    }
  }
  const onMessage = (message: string, position?: string): void => {
    if (!waiting || !isCurrent() || position === 'chat') return
    const text = stripColorCodes(String(message || '').trim())
    if (!text || text.includes('发送变身请求')) return
    const alreadyUnlocked = text.toLowerCase().includes('already have their disguise')
    if (!alreadyUnlocked && !isMorphAcceptMessage(text, targetName)) return
    clearPending()
    if (alreadyUnlocked) applyMorph()
    else timer = setTimeout(applyMorph, MORPH_AGREE_WAIT_MS)
  }
  const onSystemChat = (packet: unknown): void => {
    try {
      const content = (packet as { content?: unknown }).content
      const message = componentToText(content as Parameters<typeof componentToText>[0])
      if (message) onMessage(message, 'system')
    } catch (err) { console.warn('[Morph] 系统消息解析失败:', err) }
  }

  // 先监听再发请求，防止服务端即时回复先于监听器到达。
  sessions.set(ctx.mcBot, cleanup)
  bot.on('end', cleanup)
  bot.on('messagestr', onMessage)
  client?.on('system_chat', onSystemChat)
  timer = setTimeout(() => {
    const current = isCurrent()
    cleanup()
    if (current) notify(`${targetName} 未在 1 分钟内接受请求，已取消`)
  }, MORPH_AGREE_TIMEOUT_MS)
  try {
    const result = ctx.gameApiService.say(`/request send ${targetName}`)
    if (!result.success) {
      cleanup()
      return { success: false, message: `变身请求未发送：${result.message || '机器人未就绪'}` }
    }
    return { success: true, message: `已向 ${targetName} 发送变身请求；尚未确认变身完成，后续按服务器回应处理` }
  } catch (err) {
    cleanup()
    throw err
  }
}
