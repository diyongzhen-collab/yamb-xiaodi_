/** 全局配置与跨模块数据结构；字段集中声明，避免功能模块各自定义不一致的数据形状。 */
export interface MinecraftConfig {
  host: string
  port: number
  username: string | undefined
  password: string | undefined
  auth: string
  profilesFolder: string
  version: string | false
  checkTimeoutInterval: number
  /** 向服务器请求的区块视距（2–32），与网页 Viewer 渲染视距独立。 */
  viewDistance: number
}

export interface AstrbotConfig {
  enabled: boolean
  /** HTTP 监听地址；默认仅本机 127.0.0.1，可用 API_BIND 覆盖。 */
  host: string
  port: number
  apiKey: string | undefined
  /** AstrBot 请求执行 bot AI 工具时使用的 Minecraft 管理员身份。 */
  aiActor: string | undefined
}

export interface AiConfig {
  enabled: boolean
  /** 非标准兼容参数；设为 false 时不发送 cache_prompt。 */
  cachePrompt?: boolean
  baseUrl: string
  apiKey: string | undefined
  model: string
  maxToolRounds: number
  memoryTurns: number
  /** AI 的 say 工具禁止发送的服务器斜杠指令名（不含开头 /）。 */
  blockedSlashCommands: string[]
}

export interface MessagesConfig {
  emptyCommand?: string
  unknownCommand?: string
  noPermission?: string
  notWhitelisted?: string
  phomeUsage?: string
  phomeError?: string
  lockedBlocked?: string
  lockAlready?: string
  lockUsage?: string
  lockSuccess?: string
  lockHoverSuccess?: string
  lockHoverFailed?: string
  unlockNotLocked?: string
  unlockSuccess?: string
  addUsage?: string
  addAlready?: string
  addSuccess?: string
  removeUsage?: string
  removeNotFound?: string
  removeSuccess?: string
  statusLines?: string[]
  statusLocked?: string
  statusUnlocked?: string
  statusIdle?: string
  statusRidingPlayer?: string
  statusRidingMinecart?: string
  sayUsage?: string
  saySuccess?: string
  sayError?: string
  forwardUsage?: string
  forwardSuccess?: string
  forwardEmpty?: string
  forwardError?: string
  mountUsage?: string
  mountSuccess?: string
  mountError?: string
  mountAlready?: string
  unmountSuccess?: string
  unmountError?: string
  cartSuccess?: string
  cartError?: string
  invHeader?: string
  invEmpty?: string
  invError?: string
  slotUsage?: string
  slotSuccess?: string
  slotError?: string
  storeUsage?: string
  storeSuccess?: string
  storeError?: string
  takeUsage?: string
  takeSuccess?: string
  takeError?: string
  dropUsage?: string
  dropSuccess?: string
  dropError?: string
  aiUsage?: string
  aiSuccess?: string
  aiError?: string
  containerAddUsage?: string
  containerAddSuccess?: string
  containerRemoveUsage?: string
  containerRemoveSuccess?: string
  containerRemoveNotFound?: string
  containerNoTarget?: string
  helpLines?: string[]
}

export interface CommandConfig {
  prefix: string
  whisperCommand: string
  allowPublicCommands: boolean
  replyAlwaysWhisper: boolean
  messages: MessagesConfig
}

export interface WaypointConfig {
  id: string
  alias: string
}

export interface TeleportConfig {
  databaseFile: string
  tpacceptCommand: string
  tpahereCommand: string
  phomeCommand: string
  waypoints: WaypointConfig[]
  waypointDelayMs?: number
}

export interface BotBehaviorConfig {
  idleTimeoutMs: number
  idleCheckIntervalMs: number
  homeCommand: string
  afkCommand: string
  afkDelayMs: number
  homeWaitMs: number
  replyDelayMs: number
  interactionDistance: number
  approachDistance: number
  forwardWaitMs: number
  ridingCheckIntervalMs: number
  /** 已在待命点且已 AFK 后，后续空闲周期是否仍重复发送 /afk（默认 false：只发一次，保持安静）。 */
  resendAfkAtStandby?: boolean
}

export interface ViewerConfig {
  enabled: boolean
  port: number
  firstPerson: boolean
  viewDistance: number
}

export interface MessageQueueConfig {
  maxSize: number
  delayMs: number
}

export interface AppConfig {
  minecraft: MinecraftConfig
  astrbot: AstrbotConfig
  ai: AiConfig
  adminList: string[]
  whitelistList: string[]
  command: CommandConfig
  teleport: TeleportConfig
  bot: BotBehaviorConfig
  viewer: ViewerConfig
  messageQueue: MessageQueueConfig
}

export interface ServiceResult {
  success: boolean
  message?: string
  code?: 'locked' | 'not_ready' | 'unknown_waypoint' | 'permanent'
  lockedBy?: string | null
  /** true 表示失败是永久性的（如任务格式无效/权限丢失），调度器应删除任务而非无限重试。 */
  permanent?: boolean
}

export interface PlayersResult extends ServiceResult {
  players?: string[]
  /** 当前查询结果中的人数；查询小镇/玩家时不等于总在线。 */
  count?: number
  /** 机器人可见的总在线人数（不含机器人自身）。 */
  totalCount?: number
  playerInfo?: OnlinePlayerInfo[]
  towns?: TownPlayerGroup[]
}

export interface OnlinePlayerInfo {
  username: string
  tabDisplayName: string
  teamDisplayName?: string
  /** 从 Tab 关联的计分板队伍中识别的小镇名；缺失代表服务器未提供。 */
  town?: string
}

export interface TownPlayerGroup {
  /** 未能从 Tab/计分板读取时为“未识别小镇”。 */
  town: string
  count: number
  players: OnlinePlayerInfo[]
}

export interface StatusResult extends ServiceResult {
  minecraft?: boolean
  username?: string | null
  uptime?: number
  whitelist_count?: number
}

export interface WhitelistEntry {
  displayName: string
  addedBy: string
  addedAt: string
}

export type WhitelistData = Record<string, WhitelistEntry>

export interface QueueTask {
  kind: 'chat' | 'whisper'
  /** kind 为 whisper 时私聊对象 */
  username?: string
  message: string
  sender: string | null
  timestamp: number
}

export interface QueueStatus {
  size: number
  isProcessing: boolean
  isLocked: boolean
  maxSize: number
}
