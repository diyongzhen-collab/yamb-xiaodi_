/**
 * 查询类 AI 工具：只读，不修改任何状态。锁定期间全部可用。
 */
import type { ToolDefinition, ToolExecutionResult } from './types'

export const QUERY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_status',
    description: '获取机器人当前连接状态、名称、坐标和手持栏位。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const bot = ctx.mcBot.bot
      return {
        success: ctx.mcBot.isReady,
        message: ctx.mcBot.isReady ? '机器人已就绪' : '机器人未就绪',
        data: {
          username: bot?.username ?? null,
          position: bot?.entity?.position ?? null,
          quickBarSlot: bot?.quickBarSlot != null ? bot.quickBarSlot + 1 : null,
          heldItem: bot?.heldItem?.name ?? null
        }
      }
    }
  },
  {
    name: 'get_bot_position',
    description: '获取机器人当前精确坐标（x/y/z）、所在维度（如 overworld/nether）和朝向（yaw/pitch 与东南西北方向）。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const bot = ctx.mcBot.bot
      if (!ctx.mcBot.isReady || !bot) {
        return { success: false, message: '机器人未就绪' }
      }
      const pos = bot.entity.position
      const yaw = bot.entity.yaw
      const pitch = bot.entity.pitch
      // 将弧度转为 0-360 度的 yaw，并按 45° 分 8 个方位（0 为正南，顺时针）。
      const yawDeg = ((yaw * 180 / Math.PI) % 360 + 360) % 360
      const directions = ['南', '西南', '西', '西北', '北', '东北', '东', '东南']
      const direction = directions[Math.round(yawDeg / 45) % 8]
      const pitchDeg = pitch * 180 / Math.PI
      return {
        success: true,
        message: `坐标 (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})，维度 ${bot.game.dimension || 'overworld'}，朝向 ${direction}（yaw ${yawDeg.toFixed(0)}°，pitch ${pitchDeg.toFixed(0)}°）`,
        data: {
          position: { x: pos.x, y: pos.y, z: pos.z },
          dimension: bot.game.dimension || 'overworld',
          yaw: yawDeg,
          pitch: pitchDeg,
          direction
        }
      }
    }
  },
  {
    name: 'get_lock_status',
    description: '获取机器人当前是否被锁定、由谁锁定、以及是否为滞空锁定。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const locked = ctx.teleportService.isLocked()
      const lockedBy = ctx.teleportService.getLockedBy()
      const hoverLocked = ctx.teleportService.isHoverLocked()
      return {
        success: true,
        message: locked
          ? `bot 已被 ${lockedBy ?? '未知'} ${hoverLocked ? '滞空' : ''}锁定`
          : 'bot 当前未锁定',
        data: { locked, lockedBy, hoverLocked }
      }
    }
  },
  {
    name: 'get_bot_health',
    description: '获取机器人当前生命值、饥饿值、食物饱和度、氧气值、经验等级和经验进度。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const bot = ctx.mcBot.bot
      if (!ctx.mcBot.isReady || !bot) {
        return { success: false, message: '机器人未就绪' }
      }
      const health = bot.health
      const food = bot.food
      const saturation = bot.foodSaturation
      const oxygen = bot.oxygenLevel
      const level = bot.experience?.level ?? 0
      const expProgress = bot.experience?.progress ?? 0
      return {
        success: true,
        message: `生命值 ${health.toFixed(1)}/20，饥饿值 ${food}/20，氧气 ${oxygen}/10，经验等级 ${level}（进度 ${(expProgress * 100).toFixed(0)}%）`,
        data: { health, food, foodSaturation: saturation, oxygenLevel: oxygen, level, expProgress }
      }
    }
  },
  {
    name: 'get_current_time',
    description: '获取运行机器人这台电脑的当前现实日期、时间和时区。涉及今天、明天、几点、多久后等时间安排时应先调用。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (): ToolExecutionResult => {
      const now = new Date()
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
      return {
        success: true,
        message: now.toLocaleString('zh-CN', {
          hour12: false,
          timeZoneName: 'long'
        }),
        data: {
          localTime: now.toLocaleString('zh-CN', { hour12: false }),
          isoTime: now.toISOString(),
          timeZone
        }
      }
    }
  },
  {
    name: 'get_online_players',
    description: '直接读取 Tab 中可见的在线玩家。可按玩家名或 Tab 中的小镇标签筛选；只返回匹配玩家，不返回全服小镇分组。totalOnlineCount 是总在线人数，查询小镇时以 matchedPlayerCount 为准。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选的玩家名或不完整拼写，例如 Stev；与 town 同时提供时，只在该小镇内查找此玩家' },
        town: { type: 'string', description: '可选的小镇名；查询某小镇在线人数时填写此项' }
      }
    },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const query = ctx.string('query')
      const town = ctx.string('town')
      const result = town && query
        ? ctx.gameApiService.findPlayersByTownAndQuery(town, query)
        : town
          ? ctx.gameApiService.findPlayersByTown(town)
          : query
            ? ctx.gameApiService.findPlayers(query)
            : ctx.gameApiService.getPlayers()
      const totalOnlineCount = result.totalCount ?? 0
      const matchedPlayerCount = result.count ?? 0
      return {
        success: result.success,
        message: result.message || (town
          ? `小镇 ${town} 当前在线 ${matchedPlayerCount} 人；总在线 ${totalOnlineCount} 人`
          : query
            ? (result.players?.length ? `匹配到 ${result.players.length} 名在线玩家；总在线 ${totalOnlineCount} 人` : '没有找到接近的在线玩家')
            : `当前在线玩家总数 ${totalOnlineCount} 人`),
        data: {
          totalOnlineCount,
          matchedPlayerCount,
          players: result.playerInfo ?? []
        }
      }
    }
  },
  {
    name: 'list_whitelist_players',
    description: '查看机器人当前白名单及其添加信息。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const entries = ctx.whitelist.list()
      const players = Object.entries(entries).map(([gameName, info]) => ({
        gameName: info.displayName || gameName,
        addedBy: info.addedBy,
        addedAt: info.addedAt
      }))
      return {
        success: true,
        message: players.length ? `白名单共 ${players.length} 人` : '白名单为空',
        data: players
      }
    }
  },
  {
    name: 'list_inventory',
    description: '查看机器人背包内的物品汇总。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const result = ctx.inventoryActions.listInventory()
      return { success: result.success, message: result.message || '背包查询完成', data: result.lines ?? [] }
    }
  },
  {
    name: 'list_scheduled_commands',
    description: '查看尚未执行的定时任务列表。',
    parameters: { type: 'object', properties: {} },
    permission: 'whitelist',
    lockedAllowed: true,
    handler: (ctx): ToolExecutionResult => {
      const tasks = ctx.scheduler.list().map(task => ({
        id: task.id,
        owner: task.owner,
        command: task.command,
        runAt: task.runAt,
        repeatIntervalMs: task.repeatIntervalMs,
        repeatSeconds: task.repeatIntervalMs == null ? null : task.repeatIntervalMs / 1000,
        repeating: task.repeatIntervalMs != null
      }))
      return {
        success: true,
        message: tasks.length ? `共有 ${tasks.length} 个待执行定时任务` : '当前没有定时任务',
        data: tasks
      }
    }
  }
]
