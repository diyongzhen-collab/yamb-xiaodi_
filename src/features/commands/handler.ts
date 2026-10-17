/** 指令总调度器：统一处理私聊、公屏、权限、锁定状态、AI 与定时任务入口。 */
import type { BotBehaviorConfig, CommandConfig, ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type GameApiService from '../../api/game-service'
import type TeleportService from '../teleport/service'
import type Whitelist from '../../permissions/whitelist'
import type AdminStore from '../../permissions/admin-store'
import type StandbyManager from '../standby/manager'
import type PlayerInteractionService from '../../actions/player'
import type MinecartInteractionService from '../../actions/minecart'
import type RidingManager from '../riding/manager'
import type ContainerRegistry from '../container/registry'
import type InventoryActions from '../../actions/inventory'
import type AiToolService from '../ai/tool-service'
import type ScheduledCommandService from '../scheduler/service'
import type SystemMessageBuffer from './system-buffer'
import type { CommandContext } from './handlers/types'
import CommandMessages from './messages'
import type ClickService from '../clicks/service'
import { executeClickCommand, CLICK_HELP } from '../clicks/command'
import MessageDeduper from './message-deduper'
import { sleep } from '../../platform/sleep'
import {
  type CommandSource,
  matchesPrefix,
  normalizeInput,
  isRemovedCommand,
  parsePrefixedArgs,
  parseWhisperCommand,
  parseInteractiveWhisper
} from './parser'
import { handlePhome, handleLock, handleUnlock } from './handlers/teleport'
import { handleMount, handleUnmount, handleCart, mountPlayer, boardMinecart } from './handlers/riding'
import { handleContainer, handleInv, handleSlot, handleStore, handleTake, handleDrop } from './handlers/inventory'
import { handleAdd, handleRemove, handleSay, handleForward, handleHome, handleSignin } from './handlers/admin'
import { handleStatus, handleHelp, handleTools } from './handlers/info'
import { handleAi } from './handlers/ai'
import { handleTimer } from './handlers/timer'
import { handlePlayers } from './handlers/players'
import { handleMorph, requestMorph } from './handlers/morph'
import type { InteractionActions } from '../ai/tools/types'

/** 锁定后禁止的动作命令（仅允许 /tpa 与文本回复类命令） */
const LOCKED_BLOCKED_COMMANDS = new Set([
  'phome',
  'mount',
  'unmount',
  'cart',
  'slot',
  'store',
  'take',
  'drop',
  'say',
  'forward',
  'home'
])

/**
 * Minecraft 一条聊天消息可包含换行。只有内容超过协议长度时才拆分，
 * 避免将结果中的每一行都作为单独私聊发送而触发服务器刷屏限制。
 */
function splitReplyMessage (message: string, maxLength: number): string[] {
  let remaining = message.replace(/\r\n?/g, '\n').trim()
  if (!remaining) return []

  const chunks: string[] = []
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength + 1)
    const newlineAt = candidate.lastIndexOf('\n')
    const spaceAt = candidate.lastIndexOf(' ')
    const preferredBreak = Math.max(newlineAt, spaceAt)
    // 仅当分隔符不至于让本段太短时才按分隔符截断，否则按长度硬截断。
    const splitAt = preferredBreak >= Math.floor(maxLength * 0.6) ? preferredBreak : maxLength
    const chunk = remaining.slice(0, splitAt).trimEnd()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export default class CommandHandler {
  private clicks?: ClickService
  setClickService (clicks: ClickService): void { this.clicks = clicks }
  getAiInteractions (): InteractionActions {
    return {
      morph: (username, target) => requestMorph(this.buildContext(), username, target, 'whisper'),
      mount: (username, target) => mountPlayer(this.buildContext(), username, target),
      cart: () => boardMinecart(this.buildContext())
    }
  }
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private gameApiService: GameApiService
  private playerInteraction: PlayerInteractionService
  private minecartInteraction: MinecartInteractionService
  private ridingManager: RidingManager
  private containerRegistry: ContainerRegistry
  private inventoryActions: InventoryActions
  private aiToolService: AiToolService
  private scheduler: ScheduledCommandService
  private systemBuffer: SystemMessageBuffer
  private whitelist: Whitelist
  private adminStore: AdminStore
  private standby: StandbyManager
  private messages: CommandMessages
  private prefix: string
  private allowPublicCommands: boolean
  private replyAlwaysWhisper: boolean
  private replyDelayMs: number
  private forwardWaitMs: number
  private interactionDistance: number
  private approachDistance: number
  private readonly commandDeduper = new MessageDeduper(2000)

  constructor (
    mcBot: MinecraftBot,
    teleportService: TeleportService,
    gameApiService: GameApiService,
    playerInteraction: PlayerInteractionService,
    minecartInteraction: MinecartInteractionService,
    ridingManager: RidingManager,
    containerRegistry: ContainerRegistry,
    inventoryActions: InventoryActions,
    aiToolService: AiToolService,
    scheduler: ScheduledCommandService,
    systemBuffer: SystemMessageBuffer,
    whitelist: Whitelist,
    adminStore: AdminStore,
    standby: StandbyManager,
    config: CommandConfig,
    botConfig: BotBehaviorConfig
  ) {
    this.mcBot = mcBot
    this.teleportService = teleportService
    this.gameApiService = gameApiService
    this.playerInteraction = playerInteraction
    this.minecartInteraction = minecartInteraction
    this.ridingManager = ridingManager
    this.containerRegistry = containerRegistry
    this.inventoryActions = inventoryActions
    this.aiToolService = aiToolService
    this.scheduler = scheduler
    this.systemBuffer = systemBuffer
    this.whitelist = whitelist
    this.adminStore = adminStore
    this.standby = standby
    this.prefix = config.prefix || '#ybot'
    this.messages = new CommandMessages(config.messages, this.prefix)
    this.allowPublicCommands = config.allowPublicCommands
    this.replyAlwaysWhisper = config.replyAlwaysWhisper
    this.replyDelayMs = botConfig.replyDelayMs
    this.forwardWaitMs = botConfig.forwardWaitMs
    this.interactionDistance = botConfig.interactionDistance
    this.approachDistance = botConfig.approachDistance
  }

  getCommandMessages (): CommandMessages {
    return this.messages
  }

  isAdmin (username: string): boolean {
    return this.adminStore.isAdmin(username)
  }

  /** 管理员与白名单分开管理；管理员无需进白名单即可使用命令。 */
  isAllowedUser (username: string): boolean {
    return this.adminStore.isAdmin(username) || this.whitelist.isAllowed(username)
  }

  private useWhisperReply (source: CommandSource): boolean {
    return this.replyAlwaysWhisper || source === 'whisper'
  }

  async reply (username: string, message: string, source: CommandSource): Promise<void> {
    const viaWhisper = this.useWhisperReply(source)
    const maxLength = viaWhisper
      ? this.mcBot.getWhisperMessageLimit(username)
      : this.mcBot.getChatMessageLimit()
    const chunks = splitReplyMessage(message, maxLength)

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(this.replyDelayMs)
      const chunk = chunks[i]
      const ok = viaWhisper
        ? this.mcBot.whisper(username, chunk)
        : this.mcBot.chat(chunk)
      if (!ok) {
        console.warn(`[Command] 回复失败 -> ${username}: ${chunk}`)
      }
    }
  }

  private waypointHint (): string {
    const aliases = this.teleportService.listWaypointAliases()
    return aliases.length > 0 ? aliases.join(', ') : '无'
  }

  private async notifyLocked (username: string, source: CommandSource): Promise<void> {
    const lockedBy = this.teleportService.getLockedBy() || '未知'
    await this.reply(username, this.messages.text('lockedBlocked', { lockedBy }), source)
  }

  private buildContext (): CommandContext {
    return {
      mcBot: this.mcBot,
      teleportService: this.teleportService,
      gameApiService: this.gameApiService,
      playerInteraction: this.playerInteraction,
      minecartInteraction: this.minecartInteraction,
      ridingManager: this.ridingManager,
      containerRegistry: this.containerRegistry,
      inventoryActions: this.inventoryActions,
      systemBuffer: this.systemBuffer,
      whitelist: this.whitelist,
      standby: this.standby,
      messages: this.messages,
      interactionDistance: this.interactionDistance,
      approachDistance: this.approachDistance,
      forwardWaitMs: this.forwardWaitMs,
      reply: this.reply.bind(this),
      isAdmin: this.isAdmin.bind(this),
      waypointHint: this.waypointHint.bind(this),
      notifyLocked: this.notifyLocked.bind(this)
    }
  }

  private async handleImplicitAi (
    username: string,
    instruction: string,
    source: CommandSource
  ): Promise<void> {
    // 白名单与管理员都可进入 AI；管理类工具由 AiToolService 按调用者权限拒绝。
    // 锁定期间 AI 仍可进入，行动类工具由 AiToolService 按锁定状态拒绝，
    // 这样坐标/血量等只读查询在锁定后依然可用。

    this.standby.touch()
    console.log(`[Command:${source}] ${username} -> ai ${instruction}`)
    await handleAi(this.buildContext(), this.aiToolService, username, instruction, source)
    this.standby.scheduleAfk()
  }

  async executeScheduled (username: string, message: string): Promise<ServiceResult> {
    // 定时任务不能绕过后来变更的权限；失败交由调度器保留并重试。
    if (!this.isAllowedUser(username) || !this.isAdmin(username)) {
      return { success: false, permanent: true, message: `任务拥有者 ${username} 已不具备管理员权限，任务已删除` }
    }

    const text = normalizeInput(message)
    const parts = parseWhisperCommand(text)
    if (!parts) {
      // 永久性配置错误：任务内容不是已知 bot 指令，重试不会成功，调度器会删除该任务。
      return { success: false, permanent: true, message: '定时任务不是已知 bot 指令（已删除）。服务器指令请写成 say /xxx，例如 say /tsl signin click' }
    }

    const cmd = (parts[0] || '').toLowerCase()
    const args = parts.slice(1)
    if (['attack', 'use', 'click'].includes(cmd)) {
      return this.clicks ? executeClickCommand(this.clicks, cmd, args) : { success: false, message: '点击服务未就绪' }
    }
    const locked = this.teleportService.isLocked()
    const isAiUnlockRequest = cmd === 'ai' && this.aiToolService.isUnlockRequest(args.join(' '))
    // 定时 say/forward 在锁定时仍照常执行（锁定只挡移动/物品栏等动作，不挡发言；
    // 定时签到/播报场景在锁定期间也应继续），与游戏内手动 say/forward 的拦截语义区分开。
    if (locked && LOCKED_BLOCKED_COMMANDS.has(cmd) && !isAiUnlockRequest && cmd !== 'say' && cmd !== 'forward') {
      return { success: false, message: 'bot 已锁定，任务等待解锁后重试' }
    }
    if (locked && cmd === 'container' && ['add', 'remove'].includes((args[0] || '').toLowerCase())) {
      return { success: false, message: 'bot 已锁定，容器配置任务等待解锁后重试' }
    }

    // 这两类可直接取得执行结果，不能仅因“指令处理函数返回”就标记成功。
    if (cmd === 'ai') return this.aiToolService.run(username, args.join(' '))
    if (cmd === 'say') return this.gameApiService.say(args.join(' '), true)
    // forward 与 say 同语义：锁定豁免 + bypassLock；走 handle() 会被锁定拦截，故单独分发。
    if (cmd === 'forward') {
      await handleForward(this.buildContext(), username, args.join(' '), 'whisper', true)
      return { success: true, message: '定时指令已分发' }
    }

    // 其余本地指令沿用私聊语义，但跳过短时间重复消息去重。
    await this.handle(username, message, 'whisper', true)
    return { success: true, message: '定时指令已分发' }
  }

  async handle (
    username: string,
    message: string,
    source: CommandSource,
    bypassDedupe = false
  ): Promise<void> {
    if (username === this.mcBot.bot?.username) return

    // 命令链路异常边界：任何单个指令处理出错都只记录并告知用户，不向上抛出，
    // 避免畸形消息/异常状态触发 unhandledRejection 后由全局兜底退出进程。
    try {
      await this.handleInput(username, message, source, bypassDedupe)
    } catch (err) {
      console.error(`[Command] 指令处理异常 (${username}):`, err)
      try {
        await this.reply(username, `指令处理出错: ${(err as Error)?.message || String(err)}`, source)
      } catch {
        // 失败通知本身出错时不再抛出，避免二次异常
      }
    }
  }

  private async handleInput (username: string, message: string, source: CommandSource, bypassDedupe: boolean): Promise<void> {
    const text = normalizeInput(message)
    if (!text) return

    // 去重放在权限判断之前：同一用户相同请求（含被拒绝的提示）2 秒内只处理一次。
    const dedupeKey = `${source}:${username}:${text}`
    if (!bypassDedupe && this.commandDeduper.shouldSkipEvent(dedupeKey)) return

    const allowed = this.isAllowedUser(username)

    let parts: string[] | null = null

    if (source === 'whisper') {
      if (!allowed) {
        await this.reply(username, this.messages.text('notWhitelisted'), source)
        this.standby.scheduleAfk()
        return
      }
      if (isRemovedCommand(text)) {
        await this.reply(username, '此功能已在 3.0 中移除', source)
        return
      }
      parts = parseInteractiveWhisper(text)
      if (!parts) {
        await this.handleImplicitAi(username, text, source)
        return
      }
    } else {
      if (!this.allowPublicCommands) return
      if (!matchesPrefix(text, this.prefix)) return
      const args = parsePrefixedArgs(text, this.prefix)
      if (args.length === 0) {
        await this.reply(username, this.messages.text('emptyCommand'), source)
        this.standby.scheduleAfk()
        return
      }
      if (!allowed) {
        await this.reply(username, this.messages.text('notWhitelisted'), source)
        this.standby.scheduleAfk()
        return
      }
      parts = args
    }

    this.standby.touch()

    const cmd = (parts.shift() || '').toLowerCase()
    console.log(`[Command:${source}] ${username} -> ${cmd} ${parts.join(' ')}`.trim())

    const ctx = this.buildContext()
    if (isRemovedCommand([cmd, ...parts].join(' '))) {
      await this.reply(username, '此功能已在 3.0 中移除', source)
      return
    }
    const locked = this.teleportService.isLocked()

    const isAiUnlockRequest = cmd === 'ai' && this.aiToolService.isUnlockRequest(parts.join(' '))
    if (locked && LOCKED_BLOCKED_COMMANDS.has(cmd) && !isAiUnlockRequest) {
      await this.notifyLocked(username, source)
      this.standby.scheduleAfk()
      return
    }

    if (locked && cmd === 'container') {
      const sub = (parts[0] || '').toLowerCase()
      if (sub === 'add' || sub === 'remove') {
        await this.notifyLocked(username, source)
        this.standby.scheduleAfk()
        return
      }
    }

    switch (cmd) {
      case 'attack':
      case 'use':
      case 'click': {
        const result = this.clicks ? executeClickCommand(this.clicks, cmd, parts) : { success: false, message: '点击服务未就绪' }
        await this.reply(username, result.message || CLICK_HELP, source)
        break
      }
      case 'phome':
        await handlePhome(ctx, username, parts[0], source)
        break
      case 'mount':
        await handleMount(ctx, username, parts[0], source)
        break
      case 'unmount':
        await handleUnmount(ctx, username, source)
        break
      case 'cart':
        await handleCart(ctx, username, source)
        break
      case 'ai':
        await handleAi(ctx, this.aiToolService, username, parts.join(' '), source)
        break
      case 'timer':
        await handleTimer(ctx, this.scheduler, username, parts, source)
        break
      case 'container':
        await handleContainer(ctx, username, parts, source)
        break
      case 'lock':
        await handleLock(ctx, username, parts[0], source)
        break
      case 'unlock':
        await handleUnlock(ctx, username, source)
        break
      case 'add':
        await handleAdd(ctx, username, parts[0], source)
        break
      case 'remove':
        await handleRemove(ctx, username, parts[0], source)
        break
      case 'status':
        await handleStatus(ctx, username, source)
        break
      case 'players':
        await handlePlayers(ctx, username, parts.join(' '), source)
        break
      case 'inv':
        await handleInv(ctx, username, source)
        break
      case 'slot':
        await handleSlot(ctx, username, parts[0], source)
        break
      case 'store':
        await handleStore(ctx, username, parts, source)
        break
      case 'take':
        await handleTake(ctx, username, parts, source)
        break
      case 'drop':
        await handleDrop(ctx, username, parts, source)
        break
      case 'say':
        await handleSay(ctx, username, parts.join(' '), source)
        break
      case 'home':
        await handleHome(ctx, username, source)
        break
      case 'signin':
        await handleSignin(ctx, username, source)
        break
      case 'morph':
      case '变成':
        await handleMorph(ctx, username, parts[0], source)
        break
      case 'forward':
        await handleForward(ctx, username, parts.join(' '), source)
        break
      case 'help':
      case '帮助':
        await handleHelp(ctx, username, source)
        await this.reply(username, CLICK_HELP, source)
        break
      case '工具':
      case 'tools':
        await handleTools(ctx, username, source)
        break
      default:
        await this.reply(username, this.messages.text('unknownCommand', { cmd }), source)
    }

  }

}
