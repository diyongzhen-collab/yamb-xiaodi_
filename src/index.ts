/** 应用装配入口：在此创建共享服务、连接事件、API 和持久化调度器。 */
import 'dotenv/config'
import path from 'path'
import { installLogger } from './platform/logger'
import { loadConfig, validateConfig, resolveDataPath, syncEnvNameLists } from './config/loader'
import {
  initDatabase,
  initWhitelistDatabase,
  initAdminDatabase,
  migrateFromJson,
  closeDatabase
} from './platform/database'
import MessageQueue from './platform/message-queue'
import MinecraftBot from './platform/minecraft-bot'
import StandbyManager from './features/standby/manager'
import ClickService from './features/clicks/service'
import { startViewer, stopViewer } from './features/viewer'
import Whitelist from './permissions/whitelist'
import AdminStore from './permissions/admin-store'
import TeleportService from './features/teleport/service'
import TeleportIncomingHandler from './features/teleport/incoming-handler'
import PlayerInteractionService from './actions/player'
import MinecartInteractionService from './actions/minecart'
import RidingManager from './features/riding/manager'
import InventoryActions from './actions/inventory'
import ContainerRegistry from './features/container/registry'
import ScheduledCommandService from './features/scheduler/service'
import GameApiService from './api/game-service'
import SystemMessageBuffer from './features/commands/system-buffer'
import AiToolService from './features/ai/tool-service'
import CommandHandler from './features/commands/handler'
import { registerChatListeners } from './features/commands/listeners'
import type AstrbotServer from './api/server'
import { sleep } from './platform/sleep'
import { resumeBotPhysics } from './actions/shared/entity-utils'
import { installConsoleCommandInput } from './platform/console-command'
import NotificationService from './platform/notification'
import type { TuiHandle } from './features/tui'
import type { ServiceResult } from './types'

/** 掉线原因 -> 面向玩家/管理员的中文描述。 */
const DISCONNECT_REASON_LABELS: Record<string, string> = {
  kicked: '被服务器踢出',
  spam: '被踢出（疑似刷屏）',
  chat: '被踢出（聊天内容校验失败）',
  duplicate: '被踢出（重复登录）',
  auth: '登录认证失败',
  '连接错误': '网络连接错误',
  '连接断开': '连接被断开'
}

function formatWait (ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.round(ms / 1_000)} 秒`
}

async function main (): Promise<void> {
  installLogger()
  const config = loadConfig()
  validateConfig(config)

  console.log('[Main] Starting mchatbot...')
  console.log(`[Main] AstrBot (QQ群): ${config.astrbot.enabled ? '已启用' : '已禁用'}`)
  console.log(`[Main] 游戏内命令前缀: ${config.command.prefix}`)
  console.log(`[Main] 交互距离: ${config.bot.interactionDistance} 格 / 接近距离: ${config.bot.approachDistance} 格`)
  console.log(`[Main] 游戏区块视距: ${config.minecraft.viewDistance}（MC_VIEW_DISTANCE）`)
  console.log(`[Main] 公屏命令: ${config.command.allowPublicCommands ? '已启用' : '已禁用'}`)
  console.log(`[Main] 可视化 (viewer): ${config.viewer.enabled ? `已启用 :${config.viewer.port}` : '已禁用'}`)

  const dbPath = resolveDataPath(config.teleport.databaseFile)
  const db = initDatabase(dbPath)
  // 白名单与管理员分开存储：whitelist.db / admins.db（与 game.db 同目录）。
  const whitelistDb = initWhitelistDatabase(path.join(path.dirname(dbPath), 'whitelist.db'), db)
  const adminDb = initAdminDatabase(path.join(path.dirname(dbPath), 'admins.db'))
  migrateFromJson(resolveDataPath('./data/whitelist.json'))

  const messageQueue = new MessageQueue(config.messageQueue)
  console.log('[Main] Message queue initialized')

  // 掉线/重连事件的内存通知队列，由 AstrBot 插件轮询拉取并推送到 QQ。
  const notifications = new NotificationService()

  const whitelist = new Whitelist(whitelistDb)
  const adminStore = new AdminStore(adminDb)
  const containerRegistry = new ContainerRegistry(db)
  const scheduler = new ScheduledCommandService(db)
  // 启动只做 .env → 数据库（增量，不删库里已有的人）。
  // 游戏里增删白名单/管理员时再把库写回 .env。
  const syncedWhitelist = whitelist.syncFromConfig(config.whitelistList)
  const syncedAdmins = adminStore.syncFromConfig(config.adminList)
  console.log(`[Main] Whitelist loaded (${whitelist.count()} entries)`)
  if (syncedWhitelist > 0) {
    console.log(`[Main] Synced ${syncedWhitelist} whitelist entry(s) from .env (MC_WHITELIST)`)
  }
  console.log(`[Main] Admins loaded (${adminStore.count()} entries)`)
  if (syncedAdmins > 0) {
    console.log(`[Main] Synced ${syncedAdmins} admin entry(s) from .env (MC_ADMIN_LIST)`)
  }
  const writeNameListsToEnv = (): void => {
    syncEnvNameLists(adminStore.namesForEnv(), whitelist.namesForEnv())
  }
  whitelist.setOnChange(writeNameListsToEnv)
  adminStore.setOnChange(writeNameListsToEnv)
  console.log(`[Main] Containers loaded (${containerRegistry.count()} entries)`)

  const mcBot = new MinecraftBot(config.minecraft, config.command.whisperCommand)
  mcBot.setMessageQueue(messageQueue)

  const systemBuffer = new SystemMessageBuffer()
  const standbyManager = new StandbyManager(mcBot, config.bot)
  const clicks = new ClickService(mcBot)
  standbyManager.setIsBusy(() => clicks.isActive())
  const teleportService = new TeleportService(mcBot, config.teleport, db)
  const playerInteraction = new PlayerInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const minecartInteraction = new MinecartInteractionService(
    mcBot,
    config.bot.interactionDistance,
    config.bot.approachDistance
  )
  const ridingManager = new RidingManager(mcBot, playerInteraction, config.bot)
  const isLocked = (): boolean => teleportService.isLocked()

  // 空闲 / 骑乘 / 锁定互斥：锁定前若在骑乘则先下马
  teleportService.setBeforeLock(async () => {
    if (!ridingManager.isActive()) return
    console.log('[Teleport] 锁定前下马（骑乘与锁定互斥）')
    await ridingManager.dismount()
    await sleep(400)
  })
  teleportService.setOnLock(() => standbyManager.scheduleAfk())
  teleportService.setOnUnlock(({ wasHover }) => {
    if (wasHover && mcBot.bot) {
      resumeBotPhysics(mcBot.bot)
    }
  })

  standbyManager.setRidingManager(ridingManager)
  standbyManager.setIsLocked(isLocked)

  standbyManager.setOnHome(() => teleportService.markLocation('主城'))
  ridingManager.setIsLocked(isLocked)
  ridingManager.setOnBehaviorEnd(() => standbyManager.scheduleAfk())
  const inventoryActions = new InventoryActions(mcBot)
  const gameApiService = new GameApiService(mcBot, whitelist, isLocked)
  /**
   * send 通道可识别的本地指令：key 为归一化后的整句输入，value 表示是否锁定。
   * 命中后由 handleSendInput 处理，不会发送到游戏公屏。
   */
  const SEND_LOCK_COMMANDS: Record<string, boolean> = {
    lock: true,
    '锁定': true,
    unlock: false,
    '解锁': false
  }

  /**
   * send 通道（TUI 输入框 / F2 控制台）入口：
   * - 「锁定」/「lock」：锁定 bot（普通锁定，不滞空）；
   * - 「解锁」/「unlock」：直接解锁 bot（不校验锁定者，任何锁定都能解除）；
   * - 其余输入原样发送到游戏公屏。锁定期间公屏发言仍按 say 的锁定语义拦截。
   */
  const handleSendInput = async (message: string): Promise<ServiceResult> => {
    const trimmed = message.trim().toLowerCase()
    const wantLock = SEND_LOCK_COMMANDS[trimmed]
    if (wantLock !== undefined) {
      if (wantLock) {
        if (teleportService.isLocked()) {
          return { success: false, message: 'bot 已锁定' }
        }
        const result = await teleportService.prepareAndLock('本地', { hover: false })
        if (!result.success) {
          return { success: false, message: result.code === 'already' ? 'bot 已锁定' : '锁定失败（bot 未就绪）' }
        }
        return { success: true, message: '已锁定（send 通道）' }
      }
      if (!teleportService.isLocked()) {
        return { success: false, message: 'bot 未锁定' }
      }
      const lockedBy = teleportService.getLockedBy()
      teleportService.unlock()
      return { success: true, message: `已解锁（send 通道${lockedBy ? `，原锁定者 ${lockedBy}` : ''}）` }
    }
    return gameApiService.say(message)
  }
  // 终端界面（TUI_ENABLED=true）替代 F2 手动输入：状态条 + 滚动日志 + 底部输入框。
  const tuiEnabled = process.env.TUI_ENABLED === 'true' || process.env.TUI_ENABLED === '1'
  let tuiHandle: TuiHandle | null = null
  // AstrBot 服务晚于状态函数创建，这里用可变引用供状态行读取 QQ 活跃时间。
  let apiServerRef: AstrbotServer | null = null
  const buildTuiStatus = (): { line: string; color: 'green' | 'yellow' | 'red' | 'cyan' } => {
    const bot = mcBot.bot
    const pos = bot?.entity?.position
    const health = typeof bot?.health === 'number' ? bot.health : null
    const food = typeof bot?.food === 'number' ? bot.food : null
    const locked = teleportService.isLocked()
    const coord = pos && typeof pos.x === 'number'
      ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`
      : '-'
    const lastWaypointId = teleportService.getLastWaypointId()
    // 附近 phome 传送点判断（正负 500 格内显示 -@ 别名）；无附近点时回退显示最近使用的传送点。
    let nearWaypoint: string | null = null
    if (pos && typeof pos.x === 'number') {
      for (const [alias, wp] of teleportService.getWaypointCoords()) {
        if (Math.abs(pos.x - wp.x) <= 500 && Math.abs(pos.y - wp.y) <= 500 && Math.abs(pos.z - wp.z) <= 500) {
          nearWaypoint = alias
          break
        }
      }
    }
    const coordLabel = nearWaypoint
      ? `坐标 ${coord} -@ ${teleportService.getWaypointDisplayName(nearWaypoint)}`
      : lastWaypointId
        ? `坐标 ${coord} @ ${lastWaypointId}`
        : `坐标 ${coord}`
    const vital = `血 ${health != null ? health.toFixed(1) : '-'} 饥 ${food ?? '-'}`
    let astrbotStatus = ''
    if (config.astrbot.enabled) {
      const lastAt = apiServerRef?.getLastRequestAt() ?? null
      if (lastAt == null) {
        astrbotStatus = 'QQ 等待连接'
      } else {
        const sec = Math.max(0, Math.round((Date.now() - lastAt) / 1000))
        astrbotStatus = sec <= 30 ? 'QQ 在线' : `QQ ${sec}s 前活跃`
      }
    }
    const line = [
      `${bot?.username ?? '(未连接)'}`,
      locked ? `锁定(${teleportService.getLockedBy() ?? '?'})` : (mcBot.isReady ? '在线' : '离线'),
      clicks.status(true).message,
      coordLabel,
      vital,
      astrbotStatus
    ].filter(Boolean).join(' | ')
    return {
      line,
      color: locked ? 'yellow' : mcBot.isReady ? 'green' : 'red'
    }
  }
  if (tuiEnabled && process.stdin.isTTY && process.stdout.isTTY) {
    const { startTui } = await import('./features/tui')
    tuiHandle = startTui({
      sendChat: handleSendInput,
      getStatus: buildTuiStatus,
      onExit: () => process.emit('SIGINT')
    })
    console.log('[Main] TUI 已启用（TUI_ENABLED=true）')
  } else {
    installConsoleCommandInput(handleSendInput)
    if (tuiEnabled) {
      console.log('[Main] TUI 已配置但当前不是交互终端，回退到 F2 手动输入')
    }
  }
  const aiToolService = new AiToolService(
    config.ai,
    mcBot,
    teleportService,
    inventoryActions,
    gameApiService,
    whitelist,
    adminStore,
    scheduler
  )
  const commandHandler = new CommandHandler(
    mcBot,
    teleportService,
    gameApiService,
    playerInteraction,
    minecartInteraction,
    ridingManager,
    containerRegistry,
    inventoryActions,
    aiToolService,
    scheduler,
    systemBuffer,
    whitelist,
    adminStore,
    standbyManager,
    config.command,
    config.bot
  )
  commandHandler.setClickService(clicks)
  aiToolService.setClickService(clicks)
  aiToolService.setInteractionActions(commandHandler.getAiInteractions())
  const teleportHandler = new TeleportIncomingHandler(
    teleportService,
    whitelist,
    adminStore,
    mcBot,
    commandHandler.getCommandMessages(),
    standbyManager
  )

  // 到点后复用正常指令处理器，确保定时任务的权限和锁定规则与私聊一致。
  scheduler.setExecutor(async task => {
    if (!mcBot.isReady) throw new Error('机器人未就绪')
    const result = await commandHandler.executeScheduled(task.owner, task.command)
    if (!result.success) {
      const error = new Error(result.message || '定时指令执行失败') as Error & { permanent?: boolean }
      if (result.permanent === true) error.permanent = true
      throw error
    }
  })

  mcBot.onSpawn(() => {
    // 重启后恢复持久化的锁定状态（普通锁定；滞空不恢复）。
    teleportService.restoreLocked()
    registerChatListeners(mcBot, commandHandler, teleportHandler, systemBuffer)
    ridingManager.start()
    standbyManager.start()
    scheduler.start()
    if (config.viewer.enabled && mcBot.bot) {
      startViewer(mcBot.bot, config.viewer)
    }
  })
  mcBot.onDisconnect(detail => {
    const label = DISCONNECT_REASON_LABELS[detail.reason] ?? detail.reason
    if (detail.paused) {
      notifications.add(
        `🔴 Minecraft bot 掉线\n原因：${label}\n暂停 ${formatWait(detail.delayMs)} 后自动恢复重连`
      )
      return
    }
    notifications.add(
      `🔴 Minecraft bot 掉线\n原因：${label}\n${formatWait(detail.delayMs)} 后自动重连`
    )
  })
  mcBot.onReconnect(() => {
    notifications.add('🟢 Minecraft bot 已重新连接上线')
  })
  mcBot.create()
  console.log('[Main] Minecraft bot starting...')
  // 按需采样，不保存历史、不强制 GC；RSS 包含 V8 堆以外的原生内存。
  if (process.env.MEMORY_LOG_ENABLED === 'true' || process.env.MEMORY_LOG_ENABLED === '1') {
    setInterval(() => {
      const memory = process.memoryUsage()
      const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
      const bot = mcBot.bot
      console.log(`[Memory] rss=${mib(memory.rss)}MiB heap=${mib(memory.heapUsed)}MiB external=${mib(memory.external)}MiB chunks=${bot?.world?.getColumns().length ?? 0} entities=${Object.keys(bot?.entities ?? {}).length}`)
    }, 60_000).unref()
  }

  let apiServer: AstrbotServer | null = null
  if (config.astrbot.enabled) {
    const { default: AstrbotServer } = await import('./api/server')
    apiServer = new AstrbotServer(
      config.astrbot,
      config.ai.blockedSlashCommands,
      teleportService,
      gameApiService,
      whitelist,
      adminStore,
      aiToolService,
      notifications
    )
    if (await apiServer.start()) {
      apiServerRef = apiServer
      console.log('[Main] AstrBot API server started')
    }
  } else {
    console.log('[Main] AstrBot API server skipped (disabled)')
  }

  process.on('SIGINT', () => {
    console.log('[Main] Shutting down...')
    tuiHandle?.destroy()
    stopViewer(mcBot.bot)
    ridingManager.stop()
    standbyManager.stop()
    clicks.stopAll()
    scheduler.stop()
    apiServer?.stop()
    messageQueue.clear()
    closeDatabase()
    process.exit(0)
  })

  // 全局兜底：异常只记录不退出，避免单个畸形消息/异步错误杀死常驻 bot（掉线重连由
  // MinecraftBot 自行恢复）。仅当 1 分钟内异常超过 10 次（异常风暴）时退出，此时
  // 进程状态已不可信，等待外部重启比带病运行更安全。
  let exceptionStormCount = 0
  let exceptionStormWindowStart = 0
  const isExceptionStorm = (): boolean => {
    const now = Date.now()
    if (now - exceptionStormWindowStart > 60_000) {
      exceptionStormWindowStart = now
      exceptionStormCount = 0
    }
    exceptionStormCount++
    return exceptionStormCount > 10
  }

  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught exception:', err)
    if (isExceptionStorm()) {
      console.error('[Main] 异常风暴（1 分钟内超过 10 次），退出进程')
      process.exit(1)
    }
  })

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason)
    if (isExceptionStorm()) {
      console.error('[Main] 异常风暴（1 分钟内超过 10 次），退出进程')
      process.exit(1)
    }
  })
}

main().catch(err => {
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})
