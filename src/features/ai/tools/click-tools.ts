import type { ToolDefinition } from './types'
import { toToolResult } from './types'

export const CLICK_TOOLS: ToolDefinition[] = [{
  name: 'control_clicks',
  description: '控制准星左右键。attack 攻击实体含玩家，不挖掘；use 使用方块/实体/手持物品。continuous 持续，interval 按 tick 重复，once 单次，stop 停止。不会自动瞄准。',
  permission: 'whitelist',
  lockedAllowed: true,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      button: { type: 'string', enum: ['attack', 'use', 'all'] },
      mode: { type: 'string', enum: ['once', 'continuous', 'interval', 'stop'] },
      interval: { type: 'integer', minimum: 1, maximum: 1200 },
      offhand: { type: 'boolean' }
    }, required: ['button', 'mode']
  },
  handler: ctx => {
    if (!ctx.clicks) return { success: false, message: '点击服务未就绪' }
    const { button, mode, interval, offhand } = ctx.args
    const invalid = { success: false, message: '点击参数无效；interval 模式必须提供 1–1200 tick，all 只用于 stop' }
    if (offhand !== undefined && typeof offhand !== 'boolean') return invalid
    if (interval !== undefined && (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 1200)) return invalid
    if (mode === 'stop' && button === 'all') { ctx.clicks.stopAll(); return { success: true, message: '已停止左右键' } }
    if (button !== 'attack' && button !== 'use') return invalid
    if (button === 'attack' && offhand) return invalid
    if (mode === 'stop') return toToolResult(ctx.clicks.stop(button))
    if (mode !== 'once' && mode !== 'continuous' && mode !== 'interval') return invalid
    if (mode === 'interval' && interval === undefined) return invalid
    return toToolResult(ctx.clicks.start(button, mode, interval as number | undefined, offhand as boolean | undefined))
  }
}, {
  name: 'get_click_status', description: '查询当前左右键模式和暂停/停止原因。',
  permission: 'whitelist', lockedAllowed: true,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: ctx => ctx.clicks ? toToolResult(ctx.clicks.status()) : { success: false, message: '点击服务未就绪' }
}]
