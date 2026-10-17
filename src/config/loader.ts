/** 集中加载 .env 与 config/game 配置，并在这里处理默认值和边界限制。 */
import fs from 'fs'
import path from 'path'
import type {
  AppConfig,
  MessagesConfig,
  WaypointConfig
} from '../types'
import { DEFAULT_BLOCKED_SLASH_COMMANDS } from '../features/ai/slash-blacklist'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const GAME_CONFIG_DIR = path.join(PROJECT_ROOT, 'config', 'game')

function envBool (value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return value === 'true' || value === '1'
}

function envInt (value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue
  return parseInt(value, 10)
}

function stripJsonComments (text: string): string {
  let result = ''
  let i = 0
  let inString = false
  let escape = false

  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]

    if (inString) {
      result += char
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      i++
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      i++
      continue
    }

    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }

    result += char
    i++
  }

  return result
}

function readJson<T> (filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[Config] File not found: ${filePath}`)
      return null
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(stripJsonComments(raw)) as T
  } catch (err) {
    console.warn(`[Config] Failed to read ${filePath}:`, (err as Error).message)
    return null
  }
}

function resolvePath (relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  return path.join(PROJECT_ROOT, relativePath)
}

function parseAdminList (value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value.split(',').map(name => name.trim()).filter(Boolean)
}

function parseCommandList (value: string | undefined, defaults: string[] = []): string[] {
  // 统一去掉开头斜杠和大小写，保证 /pay 与 pay 配置等价。
  const entries = value === undefined ? defaults : value.split(',')
  return [...new Set(entries
    .map(command => command.trim().replace(/^\/+/, '').toLowerCase())
    .filter(Boolean))]
}

function loadMessagesConfig (): MessagesConfig {
  const messagesPath = path.join(GAME_CONFIG_DIR, 'messages.json')
  const messages = readJson<MessagesConfig>(messagesPath)
  if (!messages) {
    console.error('[Config] Error: config/game/messages.json is required')
    process.exit(1)
  }
  return messages
}

function loadEnvConfig (): Pick<AppConfig, 'minecraft' | 'astrbot' | 'ai' | 'messageQueue' | 'adminList' | 'whitelistList'> {
  const mcVersion = process.env.MC_VERSION
  const requestedViewDistance = Number(process.env.MC_VIEW_DISTANCE ?? 4)
  const viewDistance = Number.isFinite(requestedViewDistance) && requestedViewDistance >= 2
    ? Math.min(32, Math.floor(requestedViewDistance))
    : 4
  const password = process.env.MC_PASSWORD?.trim()
  const adminList = parseAdminList(process.env.MC_ADMIN_LIST)
  return {
    minecraft: {
      host: process.env.MC_HOST || 'mc.zenoxs.cn',
      port: envInt(process.env.MC_PORT, 25565),
      username: process.env.MC_USERNAME,
      password: password || undefined,
      auth: process.env.MC_AUTH || 'microsoft',
      profilesFolder: resolvePath(process.env.MC_PROFILES_FOLDER || './mc-tokens'),
      version: !mcVersion || mcVersion === 'false' ? false : mcVersion,
      checkTimeoutInterval: envInt(process.env.MC_CHECK_TIMEOUT, 300000),
      viewDistance
    },
    astrbot: {
      enabled: envBool(process.env.ASTRBOT_ENABLED, false),
      host: process.env.API_BIND?.trim() || '127.0.0.1',
      port: envInt(process.env.API_PORT, 15100),
      apiKey: process.env.API_KEY,
      // QQ 调用不接受外部传入的游戏身份，固定使用服务器配置的管理员。
      aiActor: process.env.ASTRBOT_AI_ACTOR?.trim() || adminList[0]
    },
    ai: {
      enabled: envBool(process.env.AI_ENABLED, false),
      cachePrompt: envBool(process.env.AI_CACHE_PROMPT, true),
      baseUrl: (process.env.AI_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || '',
      maxToolRounds: Math.max(1, Math.min(8, envInt(process.env.AI_MAX_TOOL_ROUNDS, 4))),
      memoryTurns: Math.max(0, Math.min(20, envInt(process.env.AI_MEMORY_TURNS, 8))),
      // 仅供 AI 的 say 工具使用；未配置时默认禁止 /pay 转账。
      blockedSlashCommands: parseCommandList(process.env.AI_BLOCKED_SLASH_COMMANDS, DEFAULT_BLOCKED_SLASH_COMMANDS)
    },
    messageQueue: {
      maxSize: envInt(process.env.QUEUE_MAX_SIZE, 100),
      delayMs: envInt(process.env.QUEUE_DELAY_MS, 1000)
    },
    adminList,
    whitelistList: parseAdminList(process.env.MC_WHITELIST)
  }
}

function normalizeWaypoints (raw: unknown): WaypointConfig[] {
  if (!Array.isArray(raw)) return []

  const waypoints: WaypointConfig[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      waypoints.push({ id: item, alias: item })
      continue
    }
    if (item && typeof item === 'object') {
      const w = item as Partial<WaypointConfig>
      const id = w.id?.trim()
      const alias = w.alias?.trim()
      if (id && alias) waypoints.push({ id, alias })
    }
  }
  return waypoints
}

function loadFeatureConfig (): Pick<AppConfig, 'command' | 'teleport' | 'bot' | 'viewer'> {
  const commandPath = path.join(GAME_CONFIG_DIR, 'command.json')
  const teleportPath = path.join(GAME_CONFIG_DIR, 'teleport.json')
  const botPath = path.join(GAME_CONFIG_DIR, 'bot.json')
  const viewerPath = path.join(GAME_CONFIG_DIR, 'viewer.json')

  const commandConfig = readJson<Partial<AppConfig['command']>>(commandPath) ?? {}
  const teleportConfig = readJson<Partial<AppConfig['teleport']>>(teleportPath) ?? {}
  const botConfig = readJson<Partial<AppConfig['bot']>>(botPath) ?? {}
  const viewerConfig = readJson<Partial<AppConfig['viewer']>>(viewerPath) ?? {}
  const messages = loadMessagesConfig()

  console.log(`[Config] Game config dir: ${GAME_CONFIG_DIR}`)
  console.log(`[Config] command.json -> prefix="${commandConfig.prefix ?? '(default #ybot)'}"`)

  const prefix = commandConfig.prefix || '#ybot'

  return {
    command: {
      prefix,
      whisperCommand: commandConfig.whisperCommand || '/msg',
      allowPublicCommands: commandConfig.allowPublicCommands ?? false,
      replyAlwaysWhisper: commandConfig.replyAlwaysWhisper ?? true,
      messages
    },
    teleport: {
      databaseFile: teleportConfig.databaseFile || './data/game.db',
      tpacceptCommand: teleportConfig.tpacceptCommand || '/tpaccept',
      tpahereCommand: teleportConfig.tpahereCommand || '/tpahere',
      phomeCommand: teleportConfig.phomeCommand || '/phome',
      waypoints: normalizeWaypoints(teleportConfig.waypoints),
      waypointDelayMs: teleportConfig.waypointDelayMs ?? 3000
    },
    bot: {
      idleTimeoutMs: botConfig.idleTimeoutMs ?? 90000,
      idleCheckIntervalMs: botConfig.idleCheckIntervalMs ?? 10000,
      homeCommand: botConfig.homeCommand || '/home',
      afkCommand: botConfig.afkCommand || '/afk',
      afkDelayMs: botConfig.afkDelayMs ?? 500,
      homeWaitMs: botConfig.homeWaitMs ?? 3000,
      replyDelayMs: botConfig.replyDelayMs ?? 500,
      interactionDistance: botConfig.interactionDistance ?? (botConfig as { mountRange?: number }).mountRange ?? 3,
      approachDistance: botConfig.approachDistance ?? 10,
      forwardWaitMs: botConfig.forwardWaitMs ?? (botConfig as { fwdWaitMs?: number }).fwdWaitMs ?? 2000,
      ridingCheckIntervalMs: botConfig.ridingCheckIntervalMs ?? 1500,
      resendAfkAtStandby: botConfig.resendAfkAtStandby ?? false
    },
    viewer: {
      enabled: viewerConfig.enabled ?? false,
      port: viewerConfig.port ?? 3007,
      firstPerson: viewerConfig.firstPerson ?? false,
      viewDistance: viewerConfig.viewDistance ?? 6
    }
  }
}

export function loadConfig (): AppConfig {
  return { ...loadEnvConfig(), ...loadFeatureConfig() }
}

function readEnvLineValue (text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return match ? match[1] : undefined
}

function upsertEnvKey (text: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, line)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return text.replace(/\s*$/, `${newline}${line}${newline}`)
}

function sameNameSet (left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const wanted = new Set(right.map(name => name.toLowerCase()))
  return left.every(name => wanted.has(name.toLowerCase()))
}

/**
 * 游戏内增删白名单/管理员后调用：把库写回 MC_ADMIN_LIST、MC_WHITELIST。
 * 人员集合未变则不改文件。启动时不要调用。
 */
export function syncEnvNameLists (adminNames: string[], whitelistNames: string[]): void {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    console.warn('[Config] .env 不存在，跳过写回管理员/白名单')
    return
  }

  const original = fs.readFileSync(envPath, 'utf8')
  const adminsUnchanged = sameNameSet(parseAdminList(readEnvLineValue(original, 'MC_ADMIN_LIST')), adminNames)
  const whitelistUnchanged = sameNameSet(parseAdminList(readEnvLineValue(original, 'MC_WHITELIST')), whitelistNames)
  if (adminsUnchanged && whitelistUnchanged) return

  let next = original
  if (!adminsUnchanged) next = upsertEnvKey(next, 'MC_ADMIN_LIST', adminNames.join(','))
  if (!whitelistUnchanged) next = upsertEnvKey(next, 'MC_WHITELIST', whitelistNames.join(','))
  if (next === original) return

  fs.writeFileSync(envPath, next)
  console.log('[Config] 已将数据库管理员/白名单写回 .env')
}

export function validateConfig (config: AppConfig): void {
  if (!config.minecraft.username) {
    console.error('[Config] Error: MC_USERNAME is required in .env')
    process.exit(1)
  }

  if (config.minecraft.username === 'your_microsoft_email@example.com') {
    console.warn('[Config] Warning: MC_USERNAME 仍是示例值。它只用作微软 OAuth 缓存标识，')
    console.warn('[Config]    建议改为固定标识（如机器人名），避免缓存失效后走示例邮箱授权失败。')
  }

  if (config.astrbot.enabled && !config.astrbot.apiKey) {
    console.error('[Config] Error: API_KEY is required in .env when ASTRBOT_ENABLED=true')
    process.exit(1)
  }

  if (config.astrbot.enabled && !config.ai.enabled) {
    console.error('[Config] Error: AI_ENABLED=true is required when ASTRBOT_ENABLED=true')
    process.exit(1)
  }

  if (config.astrbot.enabled && (!config.astrbot.aiActor || !config.adminList.includes(config.astrbot.aiActor))) {
    console.error('[Config] Error: ASTRBOT_AI_ACTOR must be an entry in MC_ADMIN_LIST')
    process.exit(1)
  }

  if (config.ai.enabled && (!config.ai.baseUrl || !config.ai.apiKey || !config.ai.model)) {
    console.error('[Config] Error: AI_BASE_URL, AI_API_KEY and AI_MODEL are required when AI_ENABLED=true')
    process.exit(1)
  }
}

export function resolveDataPath (relativePath: string): string {
  return path.join(PROJECT_ROOT, relativePath)
}

export { PROJECT_ROOT, GAME_CONFIG_DIR }
