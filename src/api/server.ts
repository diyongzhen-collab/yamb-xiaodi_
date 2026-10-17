import express, { Express } from 'express'
import { Server } from 'http'
import type { AstrbotConfig } from '../types'
import createTeleportRoutes from './routes/teleport'
import createGameRoutes from './routes/game'
import createAiRoutes from './routes/ai'
import createNotificationRoutes from './routes/notifications'
import type TeleportService from '../features/teleport/service'
import type GameApiService from './game-service'
import type Whitelist from '../permissions/whitelist'
import type AdminStore from '../permissions/admin-store'
import type AiToolService from '../features/ai/tool-service'
import type NotificationService from '../platform/notification'
import RequestRateLimit from './rate-limit'

export default class AstrbotServer {
  private config: AstrbotConfig
  private blockedSlashCommands: string[]
  private app: Express
  private server: Server | null = null
  /** 最近一次通过鉴权的 AstrBot 插件请求时间，用于 TUI 显示 QQ 连接状态。 */
  private lastRequestAt: number | null = null

  constructor (
    config: AstrbotConfig,
    blockedSlashCommands: string[],
    teleportService: TeleportService,
    gameApiService: GameApiService,
    whitelist: Whitelist,
    adminStore: AdminStore,
    aiToolService: AiToolService,
    notifications: NotificationService
  ) {
    this.config = config
    this.blockedSlashCommands = blockedSlashCommands
    this.app = express()
    this.app.use(express.json())
    this._setupAuth()
    this._setupRateLimit()
    this._setupRoutes(teleportService, gameApiService, whitelist, adminStore, aiToolService, notifications)
  }

  /** 简单内存速率限制：每 IP 每分钟最多 maxRequests 次请求，防止 API 被滥用。 */
  private _setupRateLimit (): void {
    const limiter = new RequestRateLimit()
    this.app.use((req, res, next) => {
      const ip = req.ip || 'unknown'
      if (!limiter.allow(ip)) {
        return res.status(429).json({ success: false, message: 'Too many requests, please slow down' })
      }
      next()
    })
  }

  private _setupAuth (): void {
    this.app.use((req, res, next) => {
      const apiKey = req.headers['x-api-key']
      if (apiKey !== this.config.apiKey) {
        return res.status(401).json({ success: false, message: 'Unauthorized' })
      }
      this.lastRequestAt = Date.now()
      next()
    })
  }

  private _setupRoutes (
    teleportService: TeleportService,
    gameApiService: GameApiService,
    whitelist: Whitelist,
    adminStore: AdminStore,
    aiToolService: AiToolService,
    notifications: NotificationService
  ): void {
    this.app.use('/api', createTeleportRoutes(teleportService, whitelist, adminStore))
    this.app.use('/api', createGameRoutes(gameApiService, this.blockedSlashCommands))
    this.app.use('/api', createAiRoutes(aiToolService, this.config.aiActor!))
    this.app.use('/api', createNotificationRoutes(notifications))
  }

  /** 最近一次 AstrBot 插件请求时间（毫秒时间戳）；从未请求过则为 null。 */
  getLastRequestAt (): number | null {
    return this.lastRequestAt
  }

  start (): Promise<boolean> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, this.config.host)
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[AstrBot] ❌ API 端口 ${this.config.host}:${this.config.port} 已被占用，AstrBot/QQ 接口未能启动。`)
          console.error(`[AstrBot]    可能原因：上一个 bot 进程未完全退出，端口仍被占用。`)
          console.error(`[AstrBot]    处理方法（任选）：`)
          console.error(`[AstrBot]      1. 打开任务管理器 → 结束所有残留的 node.exe 进程后重新启动；`)
          console.error(`[AstrBot]      2. 或修改 .env 中 API_PORT 换一个端口，并在 AstrBot 插件中同步修改；`)
          console.error(`[AstrBot]      3. 若不用 QQ 接口，可将 .env 的 ASTRBOT_ENABLED 设为 false 禁用。`)
          console.error(`[AstrBot]    游戏内 bot 功能不受影响，可正常使用。`)
        } else {
          console.error(`[AstrBot] API server 启动失败: ${err.message}`)
        }
        // 不阻塞 MC bot 启动：API 失败仅影响 QQ 接口。
        this.server = null
        resolve(false)
      })
      this.server.on('listening', () => {
        console.log(`[AstrBot] API server listening on ${this.config.host}:${this.config.port}`)
        resolve(true)
      })
    })
  }

  stop (): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}
