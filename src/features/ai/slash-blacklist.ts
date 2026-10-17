/** 发送服务器斜杠指令时的统一黑名单：AI 与 HTTP API 都使用这套校验，避免危险/敏感指令被自动执行。 */
export const DEFAULT_BLOCKED_SLASH_COMMANDS = [
  'pay',
  'op', 'deop',
  'stop', 'restart',
  'ban', 'ban-ip', 'banlist', 'pardon', 'pardon-ip', 'kick',
  'whitelist',
  'save-all', 'save-off', 'save-on', 'seed',
  'give', 'summon', 'execute', 'gamemode', 'defaultgamemode',
  'effect', 'clear', 'fill', 'setblock', 'clone', 'replaceitem',
  'function', 'datapack', 'debug', 'reload', 'tickingarea',
  'difficulty', 'gamerule', 'setworldspawn', 'setspawn',
  'experience', 'xp', 'scoreboard', 'team', 'tag', 'title', 'bossbar', 'tellraw'
]

/** 从消息中提取斜杠指令名（支持 minecraft:name 命名空间写法）；不以 / 开头视为普通聊天，返回 null。 */
export function extractSlashCommand (message: string): string | null {
  const match = message.trim().match(/^\/+\s*([^\s]+)/)
  if (!match) return null
  const rawCommand = match[1].toLowerCase()
  return rawCommand.includes(':')
    ? rawCommand.slice(rawCommand.lastIndexOf(':') + 1)
    : rawCommand
}

/** 若消息是以 / 开头的黑名单指令，返回指令名；否则返回 null。 */
export function getBlockedSlashCommand (message: string, blockedCommands: string[]): string | null {
  const command = extractSlashCommand(message)
  if (!command) return null
  return blockedCommands.includes(command) ? command : null
}
