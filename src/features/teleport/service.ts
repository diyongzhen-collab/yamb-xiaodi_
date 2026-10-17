import type { ServiceResult, TeleportConfig } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { jumpAndHover } from '../../actions/shared/entity-utils'
import { sleep } from '../../platform/sleep'
import type { DatabaseSync } from 'node:sqlite'
import { watchTeleportView } from './view-sync'

export default class TeleportService {
  private mcBot: MinecraftBot
  private tpacceptCommand: string
  private tpahereCommand: string
  private phomeCommand: string
  private waypointByAlias: Map<string, string>
  /** phome 传送成功后记录的传送点坐标（key 为别名），供「坐标」命令判断附近传送点。 */
  private waypointCoords = new Map<string, { x: number; y: number; z: number }>()
  private waypointDelayMs: number
  private locked = false
  private lockedBy: string | null = null
  private hoverLocked = false
  /** 最近一次 phome 使用的传送点 id，用于 TUI 显示当前所在传送点。 */
  private lastWaypointId: string | null = null
  private beforeLock: (() => Promise<void>) | null = null
  private onLock: (() => void) | null = null
  private onUnlock: ((info: { wasHover: boolean }) => void) | null = null
  private db: DatabaseSync | null
  private cancelViewSync: (() => void) | null = null

  constructor (mcBot: MinecraftBot, config: TeleportConfig, db: DatabaseSync | null = null) {
    this.mcBot = mcBot
    this.db = db
    this.tpacceptCommand = config.tpacceptCommand
    this.tpahereCommand = config.tpahereCommand
    this.phomeCommand = config.phomeCommand
    this.waypointByAlias = new Map(
      config.waypoints.map(w => [w.alias, w.id])
    )
    this.waypointDelayMs = config.waypointDelayMs ?? 3000
    this.loadWaypointCoords()
  }

  /** 从 game.db 加载已持久化的 phome 传送点坐标。 */
  private loadWaypointCoords (): void {
    if (!this.db) return
    try {
      const rows = this.db.prepare('SELECT alias, x, y, z FROM waypoint_coords').all() as Array<{ alias: string; x: number; y: number; z: number }>
      for (const row of rows) {
        this.waypointCoords.set(row.alias, { x: row.x, y: row.y, z: row.z })
      }
      if (rows.length > 0) {
        console.log(`[Teleport] Loaded ${rows.length} waypoint coordinate(s) from database`)
      }
    } catch (err) {
      console.warn('[Teleport] 加载传送点坐标失败:', (err as Error).message)
    }
  }

  /** 记录 phome 传送点坐标（内存 + game.db）。 */
  private saveWaypointCoord (alias: string, x: number, y: number, z: number): void {
    this.waypointCoords.set(alias, { x, y, z })
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO waypoint_coords (alias, x, y, z) VALUES (?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z
      `).run(alias, x, y, z)
    } catch (err) {
      console.warn('[Teleport] 持久化传送点坐标失败:', (err as Error).message)
    }
  }

  /** 锁定前钩子（例如骑乘时先下马，保证空闲/骑乘/锁定互斥） */
  setBeforeLock (beforeLock: () => Promise<void>): void {
    this.beforeLock = beforeLock
  }

  setOnLock (onLock: () => void): void {
    this.onLock = onLock
  }

  setOnUnlock (onUnlock: (info: { wasHover: boolean }) => void): void {
    this.onUnlock = onUnlock
  }

  isLocked (): boolean {
    return this.locked
  }

  isHoverLocked (): boolean {
    return this.locked && this.hoverLocked
  }

  getLockedBy (): string | null {
    return this.lockedBy
  }

  /** 最近一次 phome 使用的传送点 id；从未传送过则为 null。 */
  getLastWaypointId (): string | null {
    return this.lastWaypointId
  }

  /** 标记当前位置（例如自动 /home 后标记为主城），供 TUI 显示。 */
  markLocation (label: string): void {
    this.lastWaypointId = label
  }

  /**
   * 进入锁定：先执行 beforeLock；
   * options.hover 时先滞空再锁定。
   */
  async prepareAndLock (
    by: string,
    options?: { hover?: boolean }
  ): Promise<{ success: boolean; code?: 'already' | 'not_ready' | 'hover_failed' }> {
    if (this.locked) return { success: false, code: 'already' }
    if (this.beforeLock) await this.beforeLock()

    if (options?.hover) {
      const bot = this.mcBot.bot
      if (!bot || !this.mcBot.isReady) {
        return { success: false, code: 'not_ready' }
      }
      const hovered = await jumpAndHover(bot)
      if (!hovered) return { success: false, code: 'hover_failed' }
      this.hoverLocked = true
    } else {
      this.hoverLocked = false
    }

    this.lock(by)
    return { success: true }
  }

  lock (by: string): void {
    this.locked = true
    this.lockedBy = by
    this.persistLockState()
    this.onLock?.()
    console.log(`[Teleport] Locked by ${by}${this.hoverLocked ? ' (hover)' : ''}`)
  }

  unlock (): { wasHover: boolean } {
    const wasHover = this.hoverLocked
    this.locked = false
    this.lockedBy = null
    this.hoverLocked = false
    this.clearPersistedLockState()
    this.onUnlock?.({ wasHover })
    console.log(`[Teleport] Unlocked${wasHover ? ' (resume physics)' : ''}`)
    return { wasHover }
  }

  /** 重启后恢复普通锁定状态（不恢复滞空）。应在 bot 上线后调用。 */
  restoreLocked (): void {
    if (this.locked || !this.db) return
    const row = this.db.prepare(
      'SELECT locked, locked_by AS lockedBy FROM lock_state WHERE id = 1'
    ).get() as { locked: number; lockedBy: string | null } | undefined
    if (!row?.locked || !row.lockedBy) return
    this.locked = true
    this.lockedBy = row.lockedBy
    this.hoverLocked = false
    console.log(`[Teleport] 重启后恢复锁定（by ${this.lockedBy}，滞空不恢复）`)
    this.onLock?.()
  }

  private persistLockState (): void {
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO lock_state (id, locked, locked_by) VALUES (1, 1, ?)
        ON CONFLICT(id) DO UPDATE SET locked = 1, locked_by = excluded.locked_by
      `).run(this.lockedBy)
    } catch (err) {
      console.warn('[Teleport] 持久化锁定状态失败:', (err as Error).message)
    }
  }

  private clearPersistedLockState (): void {
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO lock_state (id, locked, locked_by) VALUES (1, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET locked = 0, locked_by = NULL
      `).run()
    } catch (err) {
      console.warn('[Teleport] 清除锁定状态失败:', (err as Error).message)
    }
  }

  canAcceptRequest (type: 'tpa' | 'tpahere'): boolean {
    if (type === 'tpa') return true
    return !this.locked
  }

  canUseWaypoint (): boolean {
    return !this.locked
  }

  listWaypointAliases (): string[] {
    return [...this.waypointByAlias.keys()].sort()
  }

  resolveWaypointId (alias: string): string | null {
    return this.waypointByAlias.get(alias) ?? null
  }

  /** 已记录坐标的 phome 传送点（key 为别名）。 */
  getWaypointCoords (): ReadonlyMap<string, { x: number; y: number; z: number }> {
    return this.waypointCoords
  }

  /** 传送点显示名：优先中文 id（如「凋零玫瑰塔」），无映射时回退别名。 */
  getWaypointDisplayName (alias: string): string {
    return this.waypointByAlias.get(alias) ?? alias
  }

  async acceptRequest (playerName: string, type: 'tpa' | 'tpahere'): Promise<ServiceResult> {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪', code: 'not_ready' }
    }

    const bot = this.mcBot.bot
    let cancelSync: (() => void) | undefined
    if (type === 'tpahere' && bot && this.canAcceptRequest(type)) {
      this.cancelViewSync?.()
      cancelSync = watchTeleportView(bot, playerName, () =>
        this.mcBot.bot === bot && this.mcBot.isReady && !this.locked,
      () => { this.cancelViewSync = null })
      this.cancelViewSync = cancelSync
    }
    try {
      // 传送请求有 60 秒时限，tpaccept 必须立即发出：绕过限速队列直发，
      // 避免排在定时任务/AI 回复后面导致超时或明显延迟。
      const sent = this.mcBot.sendChatDirect(`${this.tpacceptCommand} ${playerName}`)
      if (!sent) {
        cancelSync?.()
        return { success: false, message: '机器人未就绪', code: 'not_ready' }
      }
      console.log(`[Teleport] Auto-accepted ${type} from ${playerName}`)
      return { success: true }
    } catch (err) {
      cancelSync?.()
      console.error('[Teleport] Accept error:', (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }

  async goToPlayerViaWaypoint (playerName: string, alias: string): Promise<ServiceResult> {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪', code: 'not_ready' }
    }
    if (!this.canUseWaypoint()) {
      return {
        success: false,
        code: 'locked',
        lockedBy: this.lockedBy,
        message: 'bot 已锁定，无法使用传送点'
      }
    }

    const waypointId = this.resolveWaypointId(alias)
    if (!waypointId) {
      const available = this.listWaypointAliases()
      const hint = available.length > 0 ? `可用: ${available.join(', ')}` : '未配置传送点'
      return {
        success: false,
        code: 'unknown_waypoint',
        message: `未知传送点 "${alias}"，${hint}`
      }
    }

    try {
      // phome 传送与 tpahere 拉人都绕过限速队列直发：
      // 传送指令应立即生效（队列固定 1 秒延迟会打乱 waypointDelayMs 节奏），
      // tpahere 请求有 60 秒时限，玩家在等待时越早发出越好。
      if (!this.mcBot.sendChatDirect(`${this.phomeCommand} ${waypointId}`)) {
        return { success: false, message: '机器人未就绪', code: 'not_ready' }
      }
      this.lastWaypointId = waypointId
      console.log(`[Teleport] Sent ${this.phomeCommand} ${waypointId} (${alias}) for ${playerName}`)
      await sleep(this.waypointDelayMs)
      // phome 传送完成后 bot 即位于传送点，记录该点坐标（内存 + game.db）供 TUI 判断附近。
      const pos = this.mcBot.bot?.entity?.position
      if (pos) {
        this.saveWaypointCoord(alias, pos.x, pos.y, pos.z)
        console.log(`[Teleport] Recorded waypoint "${alias}" at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`)
      }
      if (!this.mcBot.sendChatDirect(`${this.tpahereCommand} ${playerName}`)) {
        return { success: false, message: '机器人未就绪', code: 'not_ready' }
      }
      console.log(`[Teleport] Sent ${this.tpahereCommand} ${playerName} via ${alias}`)
      return { success: true }
    } catch (err) {
      console.error('[Teleport] Waypoint error:', (err as Error).message)
      return { success: false, message: (err as Error).message }
    }
  }
}
