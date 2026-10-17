export function shouldIgnoreSystemMessage (text: string): boolean {
  const trimmed = text.trim()
  const ignorePatterns = [
    /^\[ ! \]\s*You(?:'ve| have) received a message from/i,
    /^\[ ! \]\s*你收到了来自/i,
    /^\[ ! \]\s*You have mail/i,
    // Minecraft 原版/服务端常见的睡觉人数提示，例如 “53/54 players sleeping”。
    /^\d+\s*\/\s*\d+\s+players?\s+sleeping\b/i
  ]
  return ignorePatterns.some(p => p.test(trimmed))
}

export function parseWhisperMessage (text: string): { username: string; message: string } | null {
  const trimmed = text.trim()
  const patterns: RegExp[] = [
    /^\[([^\]]+?)\s*(?:➥|→|->)\s*[^\]]+\]\s*(.+)$/,
    /^\[([^\]]+)\s*->\s*你\]\s*(.+)$/,
    /^\[([^\]]+)\s*->\s*我\]\s*(.+)$/,
    /^([^\s\[]+)\s*->\s*你[：:\s]\s*(.+)$/,
    /^([^\s\[]+)\s*->\s*我[：:\s]\s*(.+)$/,
    /^([^\s\[]+)\s*(?:->|→)\s*你\s*[：:]\s*(.+)$/,
    /^([^\s]+)\s*whispers?(?:\s+to\s+you)?[：:\s]\s*(.+)$/i,
    /^([^\s]+)\s*悄悄对你说[：:\s]\s*(.+)$/,
    /^([^\s]+)\s*对你说[：:\s]\s*(.+)$/,
    /^From\s+([^:：]+)[：:\s]\s*(.+)$/i,
    /^来自\s+([^:：]+)[：:\s]\s*(.+)$/,
    /^\[私聊\]\s*([^\s:：]+)[：:\s]\s*(.+)$/,
    /^\[PM\]\s*([^\s:：]+)[：:\s]\s*(.+)$/i,
    /^『[^』]*私[^』]*』(.+?)\s*>\s*(.+)$/,
    /^§.*?\]?\s*([A-Za-z0-9_\u4e00-\u9fa5]{2,16})\s*(?:->|→)\s*你[：:\s]\s*(.+)$/
  ]

  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) {
      return { username: match[1].trim(), message: match[2].trim() }
    }
  }
  return null
}
