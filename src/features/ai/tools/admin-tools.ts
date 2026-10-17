/**
 * 管理类 AI 工具：仅管理员可调（permission: 'admin'）。
 * 白名单用户触发会被 AiToolService 拒绝；锁定期间仅白名单增删可用。
 */
import type { ToolDefinition, ToolExecutionResult } from './types'
import { toToolResult } from './types'
import { getBlockedSlashCommand } from '../slash-blacklist'
import { parseWhisperCommand } from '../../commands/parser'
import { parseScheduleDateTime } from '../../scheduler/service'

export const ADMIN_TOOLS: ToolDefinition[] = [
  {
    name: 'add_whitelist_player',
    description: '将一个 Minecraft 游戏名加入机器人白名单，使其可以向机器人发送指令。',
    parameters: {
      type: 'object',
      properties: {
        game_name: { type: 'string', description: '要加入白名单的 Minecraft 游戏名' }
      },
      required: ['game_name']
    },
    permission: 'admin',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const gameName = ctx.string('game_name')
      if (!gameName) return { success: false, message: '参数 game_name 必须是游戏名' }
      // 正版名规则：3-16 位字母/数字/下划线，不支持中文或特殊字符。
      if (!/^[A-Za-z0-9_]{3,16}$/.test(gameName)) {
        return {
          success: false,
          message: `${gameName} 不是合法的 Minecraft 玩家名（仅允许 3-16 位字母、数字、下划线，不支持中文或特殊字符）`
        }
      }
      // 加白名单前先确认玩家在服务器 Tab 中可见，避免把不存在的名字加进白名单。
      const online = ctx.gameApiService.findPlayers(gameName)
      const matched = online.playerInfo?.some(p => p.username.toLowerCase() === gameName.toLowerCase())
      if (!matched) {
        return {
          success: false,
          message: `未在服务器 Tab 中找到玩家 ${gameName}，请确认名字拼写；如需添加离线玩家，请使用游戏内 add 命令`
        }
      }
      if (ctx.whitelist.isAllowed(gameName)) {
        return { success: false, message: `${gameName} 已在白名单中` }
      }
      ctx.whitelist.add(gameName, ctx.username)
      return { success: true, message: `已加入白名单：${gameName}` }
    }
  },
  {
    name: 'remove_whitelist_player',
    description: '从机器人白名单移除一个 Minecraft 游戏名。',
    parameters: {
      type: 'object',
      properties: {
        game_name: { type: 'string', description: '要移除的 Minecraft 游戏名' }
      },
      required: ['game_name']
    },
    permission: 'admin',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const gameName = ctx.string('game_name')
      if (!gameName) return { success: false, message: '参数 game_name 必须是游戏名' }
      if (!ctx.whitelist.isAllowed(gameName)) {
        return { success: false, message: `${gameName} 不在白名单中` }
      }
      ctx.whitelist.remove(gameName)
      return { success: true, message: `已从白名单移除：${gameName}` }
    }
  },
  {
    name: 'say',
    description: '发送一条服务器聊天消息。message 以 / 开头时，会作为游戏指令发送；否则发送普通公屏文字。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发送的聊天内容或游戏指令，例如 /phome 1' }
      },
      required: ['message']
    },
    permission: 'admin',
    lockedAllowed: false,
    handler: (ctx): ToolExecutionResult => {
      const message = ctx.string('message')
      if (!message) return { success: false, message: '参数 message 必须是非空文本' }
      const blockedCommand = getBlockedSlashCommand(message, ctx.blockedSlashCommands)
      if (blockedCommand) {
        return { success: false, message: `AI 指令黑名单已阻止 /${blockedCommand}` }
      }
      return toToolResult(ctx.gameApiService.say(message))
    }
  },
  {
    name: 'schedule_command',
    description: '创建定时任务，到指定时间执行已有机器人指令。delay_seconds 与 run_at 必须且只能提供一个；前者表示多少秒后执行，后者为本地绝对时间（YYYY-MM-DD HH:mm:ss）。提供 repeat_seconds 时任务会按该间隔长期循环。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的机器人指令，例如 phome 1、say /home' },
        delay_seconds: { type: 'integer', minimum: 1, description: '多少秒后执行' },
        run_at: { type: 'string', description: '本地执行时间，例如 2026-07-28 21:30:00' },
        repeat_seconds: { type: 'integer', minimum: 1, description: '可选：每隔多少秒循环执行；省略则只执行一次' }
      },
      required: ['command']
    },
    permission: 'admin',
    lockedAllowed: false,
    handler: (ctx): ToolExecutionResult => {
      const command = ctx.string('command')
      if (!command) return { success: false, message: '参数 command 必须是待执行的机器人指令' }
      if (!parseWhisperCommand(command)) {
        return { success: false, message: '定时任务只能执行已知 bot 指令；自然语言请使用 ai <需求>' }
      }

      // 定时任务也可能经由 "say /命令" 间接发送游戏指令，必须走同一份黑名单校验。
      const scheduledChat = command.match(/^\s*(?:[!#]\s*)?say\s+(.+)$/i)?.[1]
      const blockedCommand = scheduledChat ? getBlockedSlashCommand(scheduledChat, ctx.blockedSlashCommands) : null
      if (blockedCommand) {
        return { success: false, message: `AI 指令黑名单已阻止定时发送 /${blockedCommand}` }
      }

      const delaySeconds = ctx.integer('delay_seconds')
      if (ctx.args.delay_seconds != null && (delaySeconds == null || delaySeconds <= 0)) {
        return { success: false, message: '参数 delay_seconds 必须是正整数' }
      }
      const repeatSeconds = ctx.integer('repeat_seconds')
      if (ctx.args.repeat_seconds != null && (repeatSeconds == null || repeatSeconds <= 0)) {
        return { success: false, message: '参数 repeat_seconds 必须是正整数' }
      }
      if (ctx.args.delay_seconds != null && ctx.args.run_at != null) {
        return { success: false, message: 'delay_seconds 与 run_at 必须且只能提供一个' }
      }

      let runAt: Date | null = null
      if (delaySeconds != null) {
        runAt = new Date(Date.now() + delaySeconds * 1000)
      } else {
        const runAtText = ctx.string('run_at')
        if (!runAtText) {
          return { success: false, message: '需要提供 delay_seconds 或 run_at' }
        }
        runAt = parseScheduleDateTime(runAtText)
      }

      if (!runAt || runAt.getTime() <= Date.now()) {
        return { success: false, message: '执行时间格式无效或早于当前时间' }
      }
      return toToolResult(ctx.scheduler.add(ctx.username, command, runAt, repeatSeconds == null ? null : repeatSeconds * 1000))
    }
  },
  {
    name: 'remove_scheduled_command',
    description: '删除一个尚未执行的定时任务。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: '定时任务 ID' }
      },
      required: ['id']
    },
    permission: 'admin',
    lockedAllowed: false,
    handler: (ctx): ToolExecutionResult => {
      const id = ctx.integer('id')
      if (id == null) return { success: false, message: '参数 id 必须是正整数' }
      return toToolResult(ctx.scheduler.remove(id))
    }
  }
]
