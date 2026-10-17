/** Mineflayer 连接生命周期封装：负责登录、资源包、断线重连和消息发送。 */
import mineflayer, { Bot, BotOptions } from 'mineflayer'
import type { MinecraftConfig } from '../types'
import type MessageQueue from './message-queue'
import { getBotClient } from './bot-client'
import { sanitizeChatText } from './chat-utils'
import { resumeBotPhysics } from '../actions/shared/entity-utils'

/** 掉线事件详情，供通知模块生成推送内容。 */
export interface BotDisconnectDetail {
  /** 掉线/失败原因（kicked / spam / chat / duplicate / auth / 连接错误 / 连接断开）。 */
  reason: string
  /** 本轮第几次重连尝试（1 = 首次掉线）。 */
  reconnectAttempts: number
  /** 计划等待多久后重试或恢复。 */
  delayMs: number
  /** true 表示达到暂停阈值（重复登录/连续失败），暂停一段时间后自动恢复。 */
  paused: boolean
}

export default class MinecraftBot {
  config: MinecraftConfig
  bot: Bot | null = null
  isReady = false
  private acceptedResourcePacks = new Set<string>()
  // 限次重连，防止服务器持续拒绝时形成无限重连风暴。
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 10
  private readonly reconnectDelay = 5000
  private reconnectTimer: NodeJS.Timeout | null = null
  /** 每次 create() 递增；事件回调据此丢弃旧 bot 的迟到事件，避免误操作新连接。 */
  private botGeneration = 0
  /** 连续被 duplicate_login 踢出的次数，用于检测“同一账号多开”并停止风暴式重连。 */
  private consecutiveDuplicateKicks = 0
  private lastDuplicateKickAt = 0
  private readonly maxDuplicateKicks = 5
  private messageQueue: MessageQueue | null = null
  /** 最近一次发出的聊天/私聊内容，用于被踢时诊断。 */
  private lastSentMessage = ''
  private onSpawnCallbacks: Array<(bot: MinecraftBot) => void> = []
  private onDisconnectCallbacks: Array<(detail: BotDisconnectDetail) => void> = []
  private onReconnectCallbacks: Array<() => void> = []
  /** 是否经历过掉线且尚未重新上线，用于在 spawn 时判定“重连成功”。 */
  private hasDisconnected = false
  /** 本次连接是否已经完成过一次进世界装配。死亡复活/切维度也会再发 spawn，不能当重新上线。 */
  private hasCompletedInitialSpawn = false
  private whisperCommand = '/msg'
  private reconnecting = false
  // 原版聊天输入上限为 256 个 UTF-16 字符；私聊命令本身也占用这部分长度。
  private readonly maxChatInputLength = 256

  constructor (config: MinecraftConfig, whisperCommand = '/msg') {
    this.config = config
    this.whisperCommand = whisperCommand
  }

  setMessageQueue (queue: MessageQueue): void {
    this.messageQueue = queue
  }

  onSpawn (callback: (bot: MinecraftBot) => void): void {
    this.onSpawnCallbacks.push(callback)
  }

  /** 注册掉线通知回调；首次掉线与暂停恢复时触发（避免每次重连失败都刷屏）。 */
  onDisconnect (callback: (detail: BotDisconnectDetail) => void): void {
    this.onDisconnectCallbacks.push(callback)
  }

  /** 注册重连成功回调：掉线后再次 spawn 时触发。 */
  onReconnect (callback: () => void): void {
    this.onReconnectCallbacks.push(callback)
  }

  private _emitDisconnect (reason: string, delayMs: number, paused: boolean): void {
    this.hasDisconnected = true
    const detail: BotDisconnectDetail = {
      reason,
      reconnectAttempts: this.reconnectAttempts,
      delayMs,
      paused
    }
    for (const callback of this.onDisconnectCallbacks) {
      callback(detail)
    }
  }

  private _emitReconnect (): void {
    this.hasDisconnected = false
    for (const callback of this.onReconnectCallbacks) {
      callback()
    }
  }

  create (): Bot {
    console.log('[MC] Creating bot...')
    this.acceptedResourcePacks.clear()
    this.hasCompletedInitialSpawn = false
    const gen = ++this.botGeneration
    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username!,
      auth: this.config.auth as 'microsoft' | 'mojang' | 'offline',
      profilesFolder: this.config.profilesFolder,
      checkTimeoutInterval: this.config.checkTimeoutInterval || 300000,
      connectTimeout: 60000,
      keepAlive: true,
      skipValidation: true,
      hideErrors: true,
      physicsEnabled: true,
      viewDistance: this.config.viewDistance,
      ...(this.config.version !== false ? { version: this.config.version } : {})
    } as BotOptions

    // 微软账号走 OAuth，不能传 password
    if (this.config.auth !== 'microsoft' && this.config.password) {
      options.password = this.config.password
    }

    if (this.config.auth === 'microsoft') {
      console.log('[MC] 使用微软账号登录，首次运行需在终端完成浏览器授权')
    }

    this.bot = mineflayer.createBot(options)

    this._setupEvents(gen)
    return this.bot
  }

  private _setupEvents (gen: number): void {
    if (!this.bot) return
    this._suppressProtocolErrors()
    const isCurrent = (): boolean => gen === this.botGeneration

    this.bot.on('login', () => {
      if (!isCurrent()) return
      console.log(`[MC] Logged in as ${this.bot!.username}`)
    })

    this.bot.on('spawn', () => {
      if (!isCurrent()) return
      // 成功进入世界才重置重连次数，连接建立但未 spawn 不算真正恢复。
      console.log('[MC] Bot spawned in world')
      const didReconnect = this.hasDisconnected
      this.isReady = true
      this.reconnectAttempts = 0
      this.reconnecting = false
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.bot!.physicsEnabled = true

      if (this.messageQueue) {
        this.messageQueue.setBot(this)
      }

      // Mineflayer 死亡复活、切维度也会再发 spawn。恢复锁定、注册监听
      // 只应在本次连接第一次进世界时做；避免重复装配事件监听。
      if (!this.hasCompletedInitialSpawn) {
        this.hasCompletedInitialSpawn = true
        for (const callback of this.onSpawnCallbacks) {
          callback(this)
        }
      } else {
        console.log('[MC] Spawn after initial login (respawn or world change), skip service setup')
      }

      if (didReconnect) {
        console.log('[MC] 重连成功')
        this._emitReconnect()
      }
    })

    // mount 会暂停物理；dismount 后 mineflayer 不会自动恢复，需手动打开
    this.bot.on('dismount', () => {
      if (!isCurrent()) return
      console.log('[MC] dismount → 恢复物理')
      resumeBotPhysics(this.bot!)
    })

    this.bot.on('mount', () => {
      if (!isCurrent()) return
      console.log('[MC] mount → 物理由 mineflayer 暂停（载具模式）')
    })

    this.bot.on('kicked', (reason) => {
      if (!isCurrent()) return
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason)
      console.log('[MC] Kicked:', reasonStr)
      this.isReady = false
      const lower = reasonStr.toLowerCase()
      const isSpamKick = lower.includes('spam')
      const isDuplicateLogin = lower.includes('duplicate_login')
      const isChatValidationKick = lower.includes('chat_validation_failed')
      if (lower.includes('illegal characters')) {
        console.error('[MC] 聊天内容含非法字符被踢出；后续发送的文本已自动净化（过滤特殊符号/emoji）')
      }
      if (isChatValidationKick) {
        console.error('[MC] 服务器聊天校验失败被踢：通常因短时间内连续发消息或消息签名问题。')
        console.error(`[MC] 被踢前最后发送的消息: ${this.lastSentMessage || '(无)'}`)
      }
      // 任何被踢都清空待发队列，避免重连后重放旧消息再次触发校验/限速踢出。
      this.messageQueue?.clear()
      if (isDuplicateLogin) {
        const now = Date.now()
        // 两次 duplicate 间隔超过 10 分钟视为新的冲突，重置计数。
        if (now - this.lastDuplicateKickAt > 10 * 60 * 1000) {
          this.consecutiveDuplicateKicks = 0
        }
        this.lastDuplicateKickAt = now
        this.consecutiveDuplicateKicks++
        console.error('[MC] \u26A0\uFE0F 重复登录被踢（连续第 ' + this.consecutiveDuplicateKicks + ' 次）：同一账号正在别处在线！')
        console.error('[MC]    请关闭其他机器人实例或游戏客户端（另一台电脑/手动登录），否则会反复被踢')
      } else {
        this.consecutiveDuplicateKicks = 0
      }
      this._handleReconnect(
        isChatValidationKick ? 'chat' : isSpamKick ? 'spam' : isDuplicateLogin ? 'duplicate' : 'kicked'
      )
    })

    this.bot.on('error', (err: NodeJS.ErrnoException) => {
      if (!isCurrent()) return
      if (err.message && (err.message.includes('PartialReadError') ||
          err.message.includes('Read error') ||
          err.message.includes('resource_pack') ||
          err.message.includes('UUID') ||
          err.message.includes('configuration'))) {
        return
      }
      console.error('[MC] Error:', err.message)

      const isAuthError = !!err.message && (
        err.message.includes('fetch failed') ||
        err.message.includes('Sign in failed') ||
        err.message.includes('Failed to obtain profile data')
      )
      if (isAuthError) {
        console.error('[MC] 登录失败提示:')
        console.error('  - 微软账号 (MC_AUTH=microsoft) 不需要填写 MC_PASSWORD')
        console.error('  - 若提示 Failed to obtain profile data，请确认该账号已购买 Minecraft Java 版')
        console.error('  - 删除 mc-tokens 目录后重新运行，在终端按提示完成浏览器授权')
        console.error('  - 若仍失败，检查网络是否能访问 Microsoft 登录服务')
        // 认证失败也自动重试（偶发的微软服务/网络抖动），避免 bot 直接挂死。
        this._handleReconnect('auth')
        return
      }

      const reconnectableErrors = new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ECONNABORTED',
        'ETIMEDOUT',
        'EPIPE',
        'ENETUNREACH',
        'EHOSTUNREACH'
      ])
      if (err.code && reconnectableErrors.has(err.code)) {
        this._handleReconnect('连接错误')
      }
    })

    this.bot.on('resourcePack', (url, hash) => {
      if (!isCurrent()) return
      this._handleResourcePack(url, hash ?? '')
    })

    getBotClient(this.bot)?.on('add_resource_pack', (data: unknown) => {
      if (!isCurrent()) return
      console.log('[MC] add_resource_pack received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    getBotClient(this.bot)?.on('resource_pack_send', (data: unknown) => {
      if (!isCurrent()) return
      console.log('[MC] resource_pack_send received')
      this._acceptResourcePackOnce(String((data as { uuid?: string }).uuid || ''))
    })

    this.bot.on('end', (reason) => {
      if (!isCurrent()) return
      console.log('[MC] Disconnected:', reason)
      this.isReady = false
      this._handleReconnect('连接断开')
    })
  }

  private _suppressProtocolErrors (): void {
    if (!this.bot) return
    const client = getBotClient(this.bot)
    if (!client) return

    client.on('error', (err: Error) => {
      if (err?.message) {
        const msg = err.message
        if (msg.includes('PartialReadError') ||
            msg.includes('Read error') ||
            msg.includes('protocol') ||
            msg.includes('decoder') ||
            msg.includes('parser') ||
            msg.includes('f32') ||
            msg.includes('intArray')) {
          return
        }
      }
    })

    if (client.socket) {
      client.socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.message) {
          const msg = err.message
          if (msg.includes('PartialReadError') ||
              msg.includes('read') ||
              msg.includes('ECONNRESET') ||
              msg.includes('EPIPE')) {
            return
          }
        }
      })
    }

    const originalEmit = client.emit.bind(client)
    client.emit = function (event: string, ...args: unknown[]) {
      if (event === 'error') {
        const err = args[0] as Error
        if (err?.message &&
            (err.message.includes('PartialReadError') ||
             err.message.includes('Read error') ||
             err.message.includes('f32'))) {
          return false
        }
      }
      return originalEmit(event, ...args)
    }
  }

  private _handleResourcePack (url: string, hash: { ascii?: string } | string): void {
    if (!this.bot) return
    console.log('[MC] Resource pack received')
    const hashObj = typeof hash === 'object' ? hash : { ascii: String(hash) }
    const packKey = String(hashObj?.ascii || hash || url || '')

    if (packKey && this.acceptedResourcePacks.has(packKey)) {
      console.log('[MC] Resource pack already accepted')
      return
    }

    try {
      const uuidStr = hashObj?.ascii ? hashObj.ascii : String(hash || '')
      console.log('[MC] Pack UUID:', uuidStr)

      const statuses: Array<[string, number]> = [
        ['ACCEPTED', 3],
        ['DOWNLOADED', 4],
        ['SUCCESSFULLY_LOADED', 0]
      ]

      const client = getBotClient(this.bot)
      if (!client) return
      for (const [label, result] of statuses) {
        try {
          client.write('resource_pack_receive', {
            uuid: uuidStr,
            result: result
          })
          console.log(`[MC] Resource pack ${label} sent`)
        } catch (err) {
          console.error(`[MC] Resource pack ${label} failed:`, (err as Error).message)
        }
      }

      if (packKey) {
        this.acceptedResourcePacks.add(packKey)
      }
      console.log('[MC] Resource pack response completed')
    } catch (err) {
      console.error('[MC] Resource pack error:', (err as Error).message)
    }
  }

  private _acceptResourcePackOnce (uuid: string): void {
    const key = String(uuid || '')
    if (key && this.acceptedResourcePacks.has(key)) {
      return
    }
    this._handleResourcePack('', uuid)
  }

  private _handleReconnect (reason: string): void {
    if (this.reconnecting) return

    // 连续 duplicate_login 说明同一账号仍有其他实例/客户端在线：暂停 10 分钟后自动恢复重试，
    // 而不是永久停止（另一个实例可能已被关闭）。
    if (reason === 'duplicate' && this.consecutiveDuplicateKicks >= this.maxDuplicateKicks) {
      console.error(`[MC] 连续 ${this.maxDuplicateKicks} 次重复登录被踢，暂停重连 10 分钟。`)
      console.error('[MC] 请确认同一账号没有其他实例/客户端在线；10 分钟后将自动恢复重试。')
      this._emitDisconnect(reason, 10 * 60 * 1000, true)
      this._pauseReconnect(10 * 60 * 1000, true)
      return
    }

    // 达到最大重连次数：暂停 5 分钟后重置计数继续尝试（应对服务器维护等长时间故障），不永久停止。
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[MC] 连续 ${this.maxReconnectAttempts} 次重连失败，暂停 5 分钟后自动恢复。`)
      this._emitDisconnect(reason, 5 * 60 * 1000, true)
      this._pauseReconnect(5 * 60 * 1000, false)
      return
    }

    this.reconnecting = true
    this.reconnectAttempts++
    // chat/spam 30 秒、duplicate 60 秒、其他 5 秒。
    const delay = reason === 'spam' || reason === 'chat' ? 30000 : reason === 'duplicate' || reason === 'auth' ? 60000 : this.reconnectDelay
    console.log(`[MC] ${reason} - 第 ${this.reconnectAttempts}/${this.maxReconnectAttempts} 次重连，等待 ${delay / 1000} 秒...`)

    // 只在首次掉线时通知，重连尝试过程中的连续失败不重复打扰。
    if (this.reconnectAttempts === 1) {
      this._emitDisconnect(reason, delay, false)
    }

    this._cleanupBot()

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      console.log('[MC] Reconnecting...')
      this.reconnecting = false
      this.safeCreate()
    }, delay)
  }

  /** 暂停一段时间后自动恢复重连，避免 reconnecting 永久卡死。 */
  private _pauseReconnect (pauseMs: number, resetDuplicate: boolean): void {
    this.reconnecting = true
    this._cleanupBot()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (resetDuplicate) this.consecutiveDuplicateKicks = 0
      this.reconnectAttempts = 0
      this.reconnecting = false
      console.log('[MC] 恢复自动重连...')
      this.safeCreate()
    }, pauseMs)
  }

  /** 创建 bot 的容错入口：创建失败不崩溃、不卡死，5 秒后自动重试。 */
  private safeCreate (): void {
    try {
      this.create()
    } catch (err) {
      console.error('[MC] 创建 bot 失败:', (err as Error).message)
      this.reconnecting = false
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.safeCreate()
      }, 5000)
    }
  }

  private _cleanupBot (): void {
    const bot = this.bot
    // 保留插件的 end 清理回调；用代次隔离旧连接的迟到事件。
    // 提前 removeAllListeners 会使物理定时器、周期操作等无法释放旧 bot。
    ++this.botGeneration
    this.bot = null
    this.isReady = false
    this.lastSentMessage = ''
    if (!bot) return
    try {
      bot.quit()
    } catch {
      // ignore cleanup errors
    }
  }

  chat (message: string): boolean {
    if (!this.isReady || !this.bot || this.reconnecting) return false
    const sanitized = sanitizeChatText(message)
    if (!sanitized) return false
    // 所有公屏消息走限速队列，避免短时间连续发送被服务器聊天校验踢出。
    if (this.messageQueue) {
      return this.messageQueue.enqueue({ kind: 'chat', message: sanitized })
    }
    return this.sendChatDirect(sanitized)
  }

  whisper (username: string, message: string): boolean {
    if (!this.isReady || !this.bot || this.reconnecting) return false
    const sanitized = sanitizeChatText(message)
    if (!sanitized) return false
    if (this.messageQueue) {
      return this.messageQueue.enqueue({ kind: 'whisper', username, message: sanitized })
    }
    return this.sendWhisperDirect(username, sanitized)
  }

  /** 队列直接发送公屏消息（不再入队），并记录最后发出的内容。 */
  sendChatDirect (message: string): boolean {
    if (!this.isReady || !this.bot || this.reconnecting) return false
    this.lastSentMessage = message
    this.bot.chat(message)
    return true
  }

  /** 队列直接发送私聊消息（不再入队），并记录最后发出的内容。 */
  sendWhisperDirect (username: string, message: string): boolean {
    if (!this.isReady || !this.bot || this.reconnecting) return false
    const full = `${this.whisperCommand} ${username} ${message}`
    this.lastSentMessage = full
    this.bot.chat(full)
    return true
  }

  /** 单条私聊可承载的正文长度，预留 /msg <玩家名> 的命令前缀。 */
  getWhisperMessageLimit (username: string): number {
    return Math.max(1, this.maxChatInputLength - `${this.whisperCommand} ${username} `.length)
  }

  /** 单条普通聊天可承载的最大长度。 */
  getChatMessageLimit (): number {
    return this.maxChatInputLength
  }
}
