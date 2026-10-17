/** 指令文本规范化与识别：私聊未知内容会留给 AI，已知命令优先本地执行。 */
export function stripMcFormatting (text: string): string {
  return text.replace(/§./g, '').trim()
}

export function normalizeInput (text: string): string {
  return stripMcFormatting(text).replace(/^\/+/, '').trim()
}

export function matchesPrefix (text: string, prefix: string): boolean {
  const normalized = normalizeInput(text)
  if (normalized === prefix) return true
  return normalized.startsWith(`${prefix} `)
}

export function parsePrefixedArgs (text: string, prefix: string): string[] {
  const normalized = normalizeInput(text)
  if (!matchesPrefix(normalized, prefix)) return []
  const rest = normalized.slice(prefix.length).trim()
  if (!rest) return []
  return rest.split(/\s+/)
}

export const KNOWN_COMMANDS = new Set([
  'attack', 'use', 'click',
  // 这里列出的私聊命令不会走隐式 AI，避免自然语言处理抢占确定性指令。
  'phome', 'lock', 'unlock', 'add', 'remove', 'status', 'say', 'forward',
  'help', '帮助', 'mount', 'unmount', 'cart', 'container',
  'inv', 'slot', 'store', 'take', 'drop', 'ai', 'timer', 'players',
  'morph', '变成', '工具', 'tools',
  // 白名单可直接触发的指定服务器指令；不等于开放任意 say。
  'home', 'signin'
])

export function isKnownCommand (cmd: string): boolean {
  return KNOWN_COMMANDS.has(cmd.toLowerCase())
}

/** 旧入口只用于明确拒绝，避免退回 AI 或让旧定时任务反复重试。 */
export function isRemovedCommand (text: string): boolean {
  const [command, subcommand] = normalizeInput(text).toLowerCase().split(/\s+/)
  return ['build', 'autoclick', 'rightclick', 'rc', '攻击', '停止攻击', '右键', '停止右键'].includes(command) ||
    (command === 'container' && ['list', 'info'].includes(subcommand))
}

export function parseWhisperCommand (text: string): string[] | null {
  const normalized = normalizeInput(text)
  if (!normalized || isRemovedCommand(normalized)) return null
  const parts = normalized.split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  if (!cmd || !isKnownCommand(cmd)) return null
  return parts
}

export type CommandSource = 'chat' | 'whisper'

/**
 * 私聊固定短语 -> 本地命令：命中后直接走确定性指令，不经过 AI。
 * 键为 normalizeInput 后的整句文本（不含前缀斜杠/格式化符，大小写敏感）。
 */
const FIXED_WHISPER_COMMANDS: Record<string, string> = {
  '锁定': 'lock',
  '解锁': 'unlock',
  '悬空锁定': 'lock hover',
  '状态': 'status',
  '背包': 'inv',
  '在线': 'players',
  '玩家': 'players',
  '回家': 'home',
  '签到': 'signin',
  '下马': 'unmount',
  '矿车': 'cart',
  '上车': 'cart',
  '任务': 'timer list',
  '定时任务': 'timer list',
  '变成我': 'morph',
  '查看ai可调用工具': '工具',
  'ai工具': '工具',
  '工具列表': '工具',
  '帮助': 'help'
}

/** 交互私聊支持中文别名；定时任务仍使用明确的标准命令。 */
export function parseInteractiveWhisper (text: string): string[] | null {
  const normalized = normalizeInput(text)
  if (isRemovedCommand(normalized)) return null
  const standard = parseWhisperCommand(normalized)
  if (standard) return standard
  const fixed = FIXED_WHISPER_COMMANDS[normalized]
  if (fixed) return parseWhisperCommand(fixed)
  const morph = normalized.match(/^变成我\s+(\S+)$/) || normalized.match(/^变成\s*(\S+)$/)
  return morph ? ['morph', morph[1]] : null
}
