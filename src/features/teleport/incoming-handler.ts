import type MinecraftBot from '../../platform/minecraft-bot'
import type Whitelist from '../../permissions/whitelist'
import type AdminStore from '../../permissions/admin-store'
import type TeleportService from './service'
import type CommandMessages from '../commands/messages'
import type StandbyManager from '../standby/manager'
import { parseIncomingTeleportRequest } from './tpa-parser'

export default class TeleportIncomingHandler {
  private teleportService: TeleportService
  private whitelist: Whitelist
  private adminStore: AdminStore
  private mcBot: MinecraftBot
  private messages: CommandMessages
  private standby: StandbyManager
  private _lastAccept?: { key: string; time: number }
  private _lastLockNotify?: { key: string; time: number }

  constructor (
    teleportService: TeleportService,
    whitelist: Whitelist,
    adminStore: AdminStore,
    mcBot: MinecraftBot,
    messages: CommandMessages,
    standby: StandbyManager
  ) {
    this.teleportService = teleportService
    this.whitelist = whitelist
    this.adminStore = adminStore
    this.mcBot = mcBot
    this.messages = messages
    this.standby = standby
  }

  handle (text: string): boolean {
    const request = parseIncomingTeleportRequest(text)
    if (!request) return false

    // 管理员与白名单分开管理：两者都能触发自动接受 tpa/tpahere。
    if (!this.whitelist.isAllowed(request.playerName) && !this.adminStore.isAdmin(request.playerName)) return false

    this.standby.touch()

    if (!this.teleportService.canAcceptRequest(request.type)) {
      if (request.type === 'tpahere' && this.teleportService.isLocked()) {
        this.notifyLocked(request.playerName)
      }
      this.standby.scheduleAfk()
      return true
    }

    const dedupeKey = `${request.type}:${request.playerName}`
    const now = Date.now()
    if (this._lastAccept?.key === dedupeKey && now - this._lastAccept.time < 3000) {
      return true
    }
    this._lastAccept = { key: dedupeKey, time: now }

    void this.teleportService.acceptRequest(request.playerName, request.type).then(() => {
      this.standby.scheduleAfk()
    }).catch(err => {
      console.error('[Teleport] 自动接受传送请求异常:', err)
    })
    return true
  }

  private notifyLocked (playerName: string): void {
    const lockedBy = this.teleportService.getLockedBy() || '未知'
    const dedupeKey = `lock:${playerName}:${lockedBy}`
    const now = Date.now()
    if (this._lastLockNotify?.key === dedupeKey && now - this._lastLockNotify.time < 5000) {
      return
    }
    this._lastLockNotify = { key: dedupeKey, time: now }

    const message = this.messages.text('lockedBlocked', { lockedBy })
    this.mcBot.whisper(playerName, message)
    console.log(`[Teleport] 锁定拒绝 -> 通知 ${playerName} (锁定者: ${lockedBy})`)
  }
}
