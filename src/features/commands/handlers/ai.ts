/** AI 指令入口：白名单与管理员可用，并提供清空本次进程内对话记忆的快捷方式；管理类工具由工具层按调用者权限拦截。 */
import type AiToolService from '../../ai/tool-service'
import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

/** 处理自然语言 AI 入口；AI 只能调用已注册的工具，管理类工具按调用者权限拦截。 */
export async function handleAi (
  ctx: CommandContext,
  aiToolService: AiToolService,
  username: string,
  instruction: string,
  source: CommandSource
): Promise<void> {
  if (!instruction.trim()) {
    await ctx.reply(username, ctx.messages.text('aiUsage'), source)
    return
  }

  if (['clear', 'reset', '清空记忆', '重置记忆', '忘记上文'].includes(instruction.trim().toLowerCase())) {
    aiToolService.clearConversation(username)
    await ctx.reply(username, ctx.messages.text('aiSuccess', { message: '已清空本次 AI 对话记忆' }), source)
    return
  }

  const result = await aiToolService.run(username, instruction)
  await ctx.reply(username, result.success
    ? ctx.messages.text('aiSuccess', { message: result.message || 'Completed.' })
    : ctx.messages.text('aiError', { message: result.message || 'Failed.' }), source)
}
