/**
 * 操作类 AI 工具：会改变 bot 状态（物品栏、位置、锁定等）。
 * 锁定期间除解锁外均不可用。
 */
import type { ToolDefinition, ToolExecutionResult } from './types'
import { toToolResult } from './types'

export const ACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'move_backpack_item_to_hotbar',
    description: '从主背包中找到指定物品，和目标快捷栏位交换，并自动选中该快捷栏位。使用原生物品栏槽位交换，不会丢弃物品。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品英文 ID 或名称片段，例如 sword、golden_carrot、arrow' },
        slot: { type: 'integer', minimum: 1, maximum: 9, description: '目标快捷栏位，1 到 9' }
      },
      required: ['item', 'slot']
    },
    permission: 'whitelist',
    lockedAllowed: false,
    handler: async (ctx): Promise<ToolExecutionResult> => {
      const item = ctx.string('item')
      const slot = ctx.integer('slot')
      if (!item) return { success: false, message: '参数 item 必须是物品名称' }
      if (slot == null) return { success: false, message: '参数 slot 必须是 1 到 9 的整数' }
      return toToolResult(await ctx.inventoryActions.moveBackpackItemToHotbar(item, slot))
    }
  },
  {
    name: 'drop_item',
    description: '从机器人背包中丢弃指定物品。item 为物品英文 ID 或名称片段；count 省略时丢弃该物品的全部数量。注意：丢弃不可恢复。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品英文 ID 或名称片段，例如 sword、golden_carrot、arrow' },
        count: { type: 'integer', minimum: 1, description: '要丢弃的数量；省略则全部丢弃' }
      },
      required: ['item']
    },
    permission: 'whitelist',
    lockedAllowed: false,
    handler: async (ctx): Promise<ToolExecutionResult> => {
      const item = ctx.string('item')
      if (!item) return { success: false, message: '参数 item 必须是物品名称' }
      const count = ctx.integer('count')
      return toToolResult(await ctx.inventoryActions.dropItem(item, count ?? undefined))
    }
  },
  {
    name: 'go_to_waypoint',
    description: '通过已配置的传送点移动机器人，并将请求者传送到机器人位置。',
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '传送点别名，例如 "1"。' }
      },
      required: ['alias']
    },
    permission: 'whitelist',
    lockedAllowed: false,
    handler: async (ctx): Promise<ToolExecutionResult> => {
      const alias = ctx.string('alias')
      if (!alias) return { success: false, message: '参数 alias 必须是传送点别名' }
      return toToolResult(await ctx.teleportService.goToPlayerViaWaypoint(ctx.username, alias))
    }
  },
  {
    name: 'select_hotbar_slot',
    description: '切换机器人手持的快捷栏栏位。',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: 9, description: '快捷栏序号 1 到 9。' }
      },
      required: ['slot']
    },
    permission: 'whitelist',
    lockedAllowed: false,
    handler: (ctx): ToolExecutionResult => {
      const slot = ctx.integer('slot')
      if (slot == null) return { success: false, message: '参数 slot 必须是 1 到 9 的整数' }
      return toToolResult(ctx.inventoryActions.selectHotbarSlot(slot))
    }
  },
  {
    name: 'lock_bot',
    description: '锁定机器人，阻止移动和物品栏等行动类指令；可选悬空后锁定。',
    parameters: {
      type: 'object',
      properties: {
        hover: { type: 'boolean', description: '是否先尝试悬空再锁定，默认 false' }
      }
    },
    permission: 'whitelist',
    lockedAllowed: false,
    handler: async (ctx): Promise<ToolExecutionResult> => {
      if (ctx.teleportService.isLocked()) {
        return { success: false, message: '机器人已经处于锁定状态' }
      }
      const hover = ctx.args.hover === true
      const result = await ctx.teleportService.prepareAndLock(ctx.username, { hover })
      if (result.success) {
        return { success: true, message: hover ? '已悬空锁定机器人' : '已锁定机器人' }
      }
      if (result.code === 'not_ready') return { success: false, message: '机器人未就绪，无法悬空锁定' }
      if (result.code === 'hover_failed') return { success: false, message: '悬空失败，未进入锁定状态' }
      return { success: false, message: '机器人已经处于锁定状态' }
    }
  },
  {
    name: 'unlock_bot',
    description: '解除机器人锁定，恢复行动类指令。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      if (!ctx.teleportService.isLocked()) {
        return { success: false, message: '机器人当前未锁定' }
      }
      ctx.teleportService.unlock()
      return { success: true, message: '已解除机器人锁定' }
    }
  }
]
