import { type ToolContext, type ToolDefinition, type ToolExecutionResult, toToolResult } from './types'
import { getBlockedSlashCommand } from '../slash-blacklist'

const noArgs = { type: 'object', properties: {}, additionalProperties: false }
const playerArgs = {
  type: 'object', additionalProperties: false,
  properties: { player: { type: 'string', description: '目标玩家完整游戏名；省略时为发起者自己。' } }
}

function validate (ctx: ToolContext, allowPlayer = false): ToolExecutionResult | null {
  if (!ctx.adminStore.isAdmin(ctx.username) && !ctx.whitelist.isAllowed(ctx.username)) {
    return { success: false, message: '需要白名单或管理员权限' }
  }
  if (!ctx.mcBot.isReady || !ctx.mcBot.bot) return { success: false, message: '机器人未就绪' }
  if (Object.keys(ctx.args).some(key => !allowPlayer || key !== 'player')) {
    return { success: false, message: '包含不支持的参数' }
  }
  if (allowPlayer) {
    const player = ctx.args.player === undefined ? ctx.username : ctx.args.player
    if (typeof player !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(player)) {
      return { success: false, message: 'player 必须是完整游戏名，只包含字母、数字、下划线，长度 1–16' }
    }
  }
  return null
}

function blocked (ctx: ToolContext, commands: string[]): ToolExecutionResult | null {
  const command = commands.find(value => getBlockedSlashCommand(value, ctx.blockedSlashCommands))
  return command ? { success: false, message: `AI 指令黑名单已阻止 ${command}` } : null
}

export const INTERACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'morph_player', permission: 'whitelist', lockedAllowed: false,
    description: '申请伪装成目标玩家，省略 player 则变成发起者。复用服务器申请、等待同意或已解锁处理、10 分钟后恢复形态流程。返回成功仅表示请求提交，不代表变身完成。',
    parameters: playerArgs,
    handler: async ctx => {
      const error = validate(ctx, true) ?? blocked(ctx, ['/request', '/morph'])
      if (error) return error
      if (!ctx.interactions) return { success: false, message: '交互服务未就绪' }
      return toToolResult(await ctx.interactions.morph(ctx.username, ctx.string('player') ?? ctx.username))
    }
  },
  {
    name: 'mount_player', permission: 'whitelist', lockedAllowed: false,
    description: '骑乘目标玩家，省略 player 则骑乘发起者。复用现有接近玩家、切换前下马及骑乘状态管理流程。需要服务器支持玩家骑乘。',
    parameters: playerArgs,
    handler: async ctx => {
      const error = validate(ctx, true)
      if (error) return error
      if (!ctx.interactions) return { success: false, message: '交互服务未就绪' }
      return toToolResult(await ctx.interactions.mount(ctx.username, ctx.string('player') ?? ctx.username))
    }
  },
  {
    name: 'board_minecart', permission: 'whitelist', lockedAllowed: false,
    description: '登上附近可用矿车，并进入项目已有矿车骑乘管理模式。',
    parameters: noArgs,
    handler: async ctx => {
      const error = validate(ctx)
      if (error) return error
      if (!ctx.interactions) return { success: false, message: '交互服务未就绪' }
      return toToolResult(await ctx.interactions.cart())
    }
  },
  {
    name: 'go_home', permission: 'whitelist', lockedAllowed: false,
    description: '发送固定服务器 /home 指令回家。成功只表示指令已提交，不能据此断言已经到家。',
    parameters: noArgs,
    handler: ctx => {
      const error = validate(ctx) ?? blocked(ctx, ['/home'])
      if (error) return error
      const result = ctx.gameApiService.say('/home')
      return result.success ? { success: true, message: '已提交 /home，尚未确认传送完成' } : toToolResult(result)
    }
  },
  {
    name: 'sign_in', permission: 'whitelist', lockedAllowed: true,
    description: '发送固定服务器签到指令 /tsl signin click，锁定时也可用。成功只表示指令提交，签到结果以服务器反馈为准。',
    parameters: noArgs,
    handler: ctx => {
      const error = validate(ctx) ?? blocked(ctx, ['/tsl'])
      if (error) return error
      const result = ctx.gameApiService.say('/tsl signin click', true)
      return result.success ? { success: true, message: '已提交签到指令，签到是否成功以服务器反馈为准' } : toToolResult(result)
    }
  }
]
