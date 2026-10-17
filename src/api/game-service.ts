/** 对外游戏能力的统一入口：聊天、状态与在线玩家查询均在这里做就绪检查。 */
import type { OnlinePlayerInfo, PlayersResult, ServiceResult, StatusResult, TownPlayerGroup } from '../types'
import type MinecraftBot from '../platform/minecraft-bot'
import type Whitelist from '../permissions/whitelist'

function levenshteinDistance (left: string, right: string): number {
  // 编辑距离用于处理玩家名的轻微拼写错误。
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]
        : Math.min(previous[j - 1], previous[j], current[j - 1]) + 1
    }
    for (let j = 0; j < current.length; j++) previous[j] = current[j]
  }
  return previous[right.length]
}

function chatToPlainText (value: unknown): string {
  if (value == null) return ''
  const text = typeof (value as { toString?: unknown }).toString === 'function'
    ? String((value as { toString: () => string }).toString())
    : String(value)
  return text.replace(/§[0-9a-fk-or]/gi, '').trim()
}

function labelWithoutPlayerName (value: string, username: string): string {
  // 玩家名位于队伍前后缀拼出的显示名末尾或接近末尾；只移除最后一次匹配，
  // 不能直接 replace，否则短用户名会误删小镇名中的同一个字母。
  const lowerValue = value.toLowerCase()
  const index = lowerValue.lastIndexOf(username.toLowerCase())
  const withoutPlayer = index >= 0
    ? `${value.slice(0, index)}${value.slice(index + username.length)}`
    : value
  return withoutPlayer
    .replace(/^[\s|:：\-—]+|[\s|:：\-—]+$/g, '')
    .trim()
}

function normalizeTownLookup (value: string): string {
  // 小镇标签常带 []、【】、空格或装饰分隔符，查询时忽略这些外层字符。
  return value.toLowerCase().replace(/[\s\[\]【】()（）{}<>《》|:：\-—_]/g, '')
}

function getTownName (
  username: string,
  tabDisplayName: string,
  teamName: string,
  teamPrefix: string,
  teamSuffix: string,
  teamId: string,
  teamDisplayName: string
): string | undefined {
  // 不同服务器会把小镇放在队伍显示名、前缀或内部队伍名；最后再回退到 Tab 名中玩家名前的标签。
  const candidates = [
    // 优先采用玩家在 Tab 中实际可见的标签；内部队伍名可能只是技术 ID，不能抢在前面。
    labelWithoutPlayerName(teamDisplayName, username),
    labelWithoutPlayerName(tabDisplayName, username),
    teamPrefix,
    teamSuffix,
    teamName,
    teamId
  ]
  for (const candidate of candidates) {
    const normalized = candidate.trim()
    if (normalized && normalized !== username) return normalized
  }
  return undefined
}

function groupByTown (players: OnlinePlayerInfo[]): TownPlayerGroup[] {
  const byTown = new Map<string, OnlinePlayerInfo[]>()
  for (const player of players) {
    const town = player.town || '未识别小镇'
    const group = byTown.get(town) ?? []
    group.push(player)
    byTown.set(town, group)
  }
  return [...byTown.entries()]
    .map(([town, townPlayers]) => ({ town, count: townPlayers.length, players: townPlayers }))
    .sort((left, right) => right.count - left.count || left.town.localeCompare(right.town))
}

/** 在给定玩家集合中按名称做与 findPlayers 相同的模糊匹配。 */
function findMatchingPlayers (players: OnlinePlayerInfo[], query: string): OnlinePlayerInfo[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return players

  const maxDistance = normalized.length <= 4 ? 1 : normalized.length <= 8 ? 2 : 3
  return players
    .map(player => {
      const candidate = player.username.toLowerCase()
      if (candidate === normalized) return { player, score: 0 }
      if (candidate.startsWith(normalized)) return { player, score: 1 }
      if (candidate.includes(normalized)) return { player, score: 2 }
      const distance = levenshteinDistance(candidate, normalized)
      return { player, score: distance <= maxDistance ? 10 + distance : Number.POSITIVE_INFINITY }
    })
    .filter(item => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.player.username.localeCompare(right.player.username))
    .slice(0, 8)
    .map(item => item.player)
}

export default class GameApiService {
  private mcBot: MinecraftBot
  private whitelist: Whitelist
  private isLocked: () => boolean

  constructor (mcBot: MinecraftBot, whitelist: Whitelist, isLocked: () => boolean = () => false) {
    this.mcBot = mcBot
    this.whitelist = whitelist
    this.isLocked = isLocked
  }

  say (message: string, bypassLock = false): ServiceResult {
    if (!this.mcBot.isReady) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!bypassLock && this.isLocked()) {
      return { success: false, message: 'bot 已锁定，无法发送公屏消息' }
    }

    this.mcBot.chat(message)
    console.log(`[Command] Sent chat: ${message}`)
    return { success: true, message: '已发送消息' }
  }

  getPlayers (): PlayersResult {
    if (!this.mcBot.isReady || !this.mcBot.bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const bot = this.mcBot.bot
    // 同时读取 tab 显示名和队伍显示名，以兼容服务器把小镇名放在计分板队伍中的情况。
    const townDebug: Array<Record<string, string>> = []
    const playerInfo: OnlinePlayerInfo[] = Object.entries(bot.players || {})
      .filter(([username]) => username !== bot.username)
      .map(([username, player]) => {
        const tabDisplayName = chatToPlainText(player.displayName) || username
        const team = bot.teamMap?.[username]
        const teamData = team as unknown as { name?: unknown; prefix?: unknown; suffix?: unknown; team?: unknown } | undefined
        const teamName = chatToPlainText(teamData?.name)
        const teamPrefix = chatToPlainText(teamData?.prefix)
        const teamSuffix = chatToPlainText(teamData?.suffix)
        const teamId = chatToPlainText(teamData?.team)
        const teamDisplayName = team ? chatToPlainText(team.displayName(username)) : ''
        const town = getTownName(username, tabDisplayName, teamName, teamPrefix, teamSuffix, teamId, teamDisplayName)
        townDebug.push({ username, tabDisplayName, teamName, teamPrefix, teamSuffix, teamId, teamDisplayName })
        return {
          username,
          tabDisplayName,
          ...(town ? { town } : {}),
          ...(teamDisplayName && teamDisplayName !== username && teamDisplayName !== tabDisplayName
            ? { teamDisplayName }
            : {})
        }
      })
      .sort((left, right) => left.username.localeCompare(right.username))
    if (playerInfo.length > 0 && !playerInfo.some(player => player.town)) {
      // 仅在完全识别不到小镇时输出样本，便于兼容不同服务器的 Tab/队伍格式。
      console.warn('[Players] 未识别到小镇标签，Tab/队伍样本:', townDebug.slice(0, 8))
    }
    return {
      success: true,
      players: playerInfo.map(player => player.username),
      count: playerInfo.length,
      totalCount: playerInfo.length,
      towns: groupByTown(playerInfo),
      playerInfo
    }
  }

  findPlayers (query: string): PlayersResult {
    const online = this.getPlayers()
    if (!online.success || !online.playerInfo) return online

    const playerInfo = findMatchingPlayers(online.playerInfo, query)
    return {
      success: true,
      players: playerInfo.map(player => player.username),
      count: playerInfo.length,
      totalCount: online.totalCount ?? online.count,
      towns: groupByTown(playerInfo),
      playerInfo
    }
  }

  findPlayersByTown (query: string): PlayersResult {
    const online = this.getPlayers()
    if (!online.success || !online.playerInfo) return online

    const normalized = normalizeTownLookup(query)
    if (!normalized) return online
    const matched = online.playerInfo.filter(player => {
      const town = player.town ? normalizeTownLookup(player.town) : ''
      if (!town) return false
      if (town === normalized || town.includes(normalized) || normalized.includes(town)) return true
      const maxDistance = normalized.length <= 4 ? 1 : normalized.length <= 8 ? 2 : 3
      return levenshteinDistance(town, normalized) <= maxDistance
    })
    if (matched.length === 0) {
      const knownTowns = [...new Set(online.playerInfo.map(player => player.town).filter(Boolean))]
      console.warn(`[Players] 小镇查询未匹配 "${query}"；当前可识别小镇: ${knownTowns.join(', ') || '无'}`)
    }
    return {
      success: true,
      players: matched.map(player => player.username),
      count: matched.length,
      totalCount: online.totalCount ?? online.count,
      towns: groupByTown(matched),
      playerInfo: matched
    }
  }

  /** 先按小镇筛选，再在该小镇的在线玩家中模糊匹配名称。 */
  findPlayersByTownAndQuery (townQuery: string, playerQuery: string): PlayersResult {
    const townResult = this.findPlayersByTown(townQuery)
    if (!townResult.success || !townResult.playerInfo) return townResult

    const playerInfo = findMatchingPlayers(townResult.playerInfo, playerQuery)
    return {
      success: true,
      players: playerInfo.map(player => player.username),
      count: playerInfo.length,
      totalCount: townResult.totalCount ?? townResult.count,
      towns: groupByTown(playerInfo),
      playerInfo
    }
  }

  getStatus (): StatusResult {
    return {
      success: true,
      minecraft: this.mcBot.isReady,
      username: this.mcBot.bot?.username || null,
      uptime: process.uptime(),
      whitelist_count: this.whitelist.count()
    }
  }
}
