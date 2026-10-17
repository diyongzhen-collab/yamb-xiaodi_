interface TextField {
  value?: string
}

interface ChatComponentObject {
  text?: string | TextField
  translate?: string | TextField
  extra?: ChatComponent | ChatComponent[]
  with?: ChatComponent | ChatComponent[]
}

type ChatComponent = string | ChatComponent[] | ChatComponentObject

function isObject (value: ChatComponent): value is ChatComponentObject {
  return typeof value === 'object' && !Array.isArray(value)
}

export function componentToText (component: ChatComponent | null | undefined): string {
  if (!component) return ''
  if (typeof component === 'string') {
    try {
      return componentToText(JSON.parse(component) as ChatComponent)
    } catch {
      return component
    }
  }
  if (Array.isArray(component)) {
    return component.map(part => componentToText(part)).join('')
  }
  if (!isObject(component)) return String(component)

  let text = ''

  if (component.text) {
    if (typeof component.text === 'string') text += component.text
    else if (component.text.value) text += component.text.value
  }

  if (component.translate) {
    if (typeof component.translate === 'string') text += component.translate
    else if (component.translate.value) text += component.translate.value
  }

  if (component.extra) {
    const extra = Array.isArray(component.extra) ? component.extra : [component.extra]
    text += extra.map(part => componentToText(part)).join('')
  }

  if (component.with) {
    const withArr = Array.isArray(component.with) ? component.with : [component.with]
    text += withArr.map(part => componentToText(part)).join('')
  }

  return text
}

export function usernameFromUuid (bot: { players?: Record<string, { uuid?: string }> }, uuid: string): string | null {
  if (!uuid || !bot) return null
  const normalized = String(uuid).toLowerCase()
  for (const [username, player] of Object.entries(bot.players || {})) {
    if (String(player.uuid || '').toLowerCase() === normalized) return username
  }
  return null
}

/**
 * 发送前净化聊天文本：去掉 MC 格式码、控制字符、零宽/方向/格式字符以及 emoji（非 BMP），
 * 避免服务器以 "Illegal characters in chat" 将 bot 踢出。保留常见 CJK 与可见符号。
 */
export function sanitizeChatText (text: string): string {
  return text
    .replace(/§./g, '')                                           // MC 格式码
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')             // 控制字符
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '') // 零宽/方向/格式字符
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')                    // emoji 等非 BMP 字符
    .replace(/\s+/g, ' ')                                        // 压缩空白
    .trim()
}

/**
 * 去除聊天中常见的颜色格式码，仅保留文字本身：
 * - &#RRGGBB：插件常用的十六进制颜色（如 &#FFD7BC）
 * - §x：Minecraft 原生格式码
 * - &x：经典旧式格式码（仅小写，避免误删 "R&B" 这类正常文本）
 */
export function stripColorCodes (text: string): string {
  return text
    .replace(/&#[0-9a-fA-F]{6};?/g, '')
    .replace(/§./g, '')
    .replace(/&[0-9a-fk-or]/g, '')
}
