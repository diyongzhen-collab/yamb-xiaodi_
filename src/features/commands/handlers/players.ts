/** 在线玩家查询与模糊匹配结果的展示，包含 tab/小镇等显示标签。 */
import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

function formatPlayer (player: { username: string; tabDisplayName: string; teamDisplayName?: string; town?: string }): string {
  const labels = [player.town, player.tabDisplayName, player.teamDisplayName]
    .filter((label, index, all) => label && label !== player.username && all.indexOf(label) === index)
  return labels.length > 0 ? `${player.username} (${labels.join(' | ')})` : player.username
}

export async function handlePlayers (
  ctx: CommandContext,
  username: string,
  query: string,
  source: CommandSource
): Promise<void> {
  const normalizedQuery = query.trim()
  const townQuery = normalizedQuery.match(/^(?:town|小镇)\s+(.+)$/i)?.[1]?.trim()
  const result = townQuery
    ? ctx.gameApiService.findPlayersByTown(townQuery)
    : normalizedQuery
      ? ctx.gameApiService.findPlayers(normalizedQuery)
      : ctx.gameApiService.getPlayers()

  if (!result.success) {
    await ctx.reply(username, `查询在线玩家失败：${result.message || '机器人未就绪'}`, source)
    return
  }

  if (!result.players?.length) {
    await ctx.reply(username, townQuery
      ? `没有找到属于小镇 “${townQuery}” 的在线玩家`
      : normalizedQuery
        ? `没有找到与 “${normalizedQuery}” 接近的在线玩家`
      : '当前没有其他在线玩家', source)
    return
  }

  const title = townQuery
    ? `小镇 “${townQuery}” 在线 ${result.count ?? result.players.length} 人（总在线 ${result.totalCount ?? 0} 人）：`
    : normalizedQuery
      ? `匹配到 ${result.players.length} 名在线玩家（总在线 ${result.totalCount ?? 0} 人）：`
      : `在线玩家总数 ${result.totalCount ?? result.players.length} 人：`
  const infoByName = new Map((result.playerInfo ?? []).map(player => [player.username, player]))
  const formatted = result.players.map(name => formatPlayer(infoByName.get(name) ?? {
    username: name,
    tabDisplayName: name
  }))
  await ctx.reply(username, `${title}${formatted.join(', ')}`, source)
}
