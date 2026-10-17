/** 将 Mineflayer 的聊天、私聊和系统包统一转换为机器人内部事件，并记录带时间戳的动态日志。 */
import { componentToText, stripColorCodes, usernameFromUuid } from '../../platform/chat-utils'
import { getBotClient } from '../../platform/bot-client'
import { parseWhisperMessage, shouldIgnoreSystemMessage } from './whisper-parser'
import MessageDeduper from './message-deduper'
import type { CommandSource } from './parser'
import type MinecraftBot from '../../platform/minecraft-bot'
import type CommandHandler from './handler'
import type TeleportIncomingHandler from '../teleport/incoming-handler'
import type SystemMessageBuffer from './system-buffer'

type BotWithFlag = NonNullable<MinecraftBot['bot']> & { _mchatbotListenersRegistered?: boolean }

function logMcEvent (type: string, text: string): void {
  // 时间与级别只由 logger 加一次，TUI 与 logs/ 文件看到同一条正文。
  console.log(`[MC:${type}] ${text}`)
}

export function registerChatListeners (
  mcBot: MinecraftBot,
  commandHandler?: CommandHandler,
  teleportHandler?: TeleportIncomingHandler,
  systemBuffer?: SystemMessageBuffer
): void {
  const bot = mcBot.bot as BotWithFlag | null
  if (!bot) return
  // 重连后 spawn 可能重复触发，标记可避免同一 bot 重复注册监听器。
  if (bot._mchatbotListenersRegistered) return
  bot._mchatbotListenersRegistered = true

  const deduper = new MessageDeduper()

  function dispatch (username: string, message: string, source: CommandSource): void {
    // 服务器会把 bot 自己发送的私聊回显为来自 "You" 的消息；忽略，避免 bot 自己回复自己
    // （如把回显当陌生玩家判"不在白名单"再回一条私聊，形成多余回环）。
    if (username === 'You') return
    // 先剥掉颜色码（&#FFD7BC 等），日志与指令处理都使用干净文本。
    const text = stripColorCodes(message.trim())
    // 服务器会通过多个协议事件重复推送同一消息，先去重再执行指令。
    if (!text || !username || deduper.shouldSkip(`${source}:${username}`, text)) return

    logMcEvent(source, `${username}: ${text}`)
    teleportHandler?.handle(text)
    if (commandHandler) {
      // handle() 内部已有异常边界；这里再兜一层，防止边界本身出错。
      void commandHandler.handle(username, text, source).catch(err => {
        console.error('[Command] 异步指令处理异常:', err)
      })
    }
  }

  function handleSystemText (text: string): void {
    const trimmed = stripColorCodes(text.trim())
    if (!trimmed || deduper.shouldSkipSystem(trimmed)) return

    if (shouldIgnoreSystemMessage(trimmed)) return

    systemBuffer?.push(trimmed)
    teleportHandler?.handle(trimmed)

    const chatMatch = trimmed.match(/^『[^』]*』(.+?)\s*>\s*(.+)$/)
    if (chatMatch) {
      dispatch(chatMatch[1].trim(), chatMatch[2].trim(), 'chat')
      return
    }

    const whisper = parseWhisperMessage(trimmed)
    if (whisper) {
      dispatch(whisper.username, whisper.message, 'whisper')
      return
    }

    logMcEvent('system', trimmed)
  }

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    dispatch(username, message, 'chat')
  })

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    dispatch(username, message, 'whisper')
  })

  getBotClient(bot)?.on('system_chat', (packet: unknown) => {
    try {
      const content = (packet as { content?: unknown }).content
      const message = componentToText(content as Parameters<typeof componentToText>[0])
      if (message) handleSystemText(message)
    } catch (error) {
      console.error('[Command] system_chat 处理失败:', error)
    }
  })

  bot.on('messagestr', (message, position) => {
    const text = String(message || '').trim()
    if (!text || position === 'chat') return
    handleSystemText(text)
  })

  getBotClient(bot)?.on('player_chat', (packet: unknown) => {
    const p = packet as Record<string, unknown>
    try {
      let message = ''
      let username: string | null = null

      if (p.senderUuid) {
        username = usernameFromUuid(bot, String(p.senderUuid))
      }
      if (!username && p.senderName) {
        username = componentToText(p.senderName as Parameters<typeof componentToText>[0])
      }

      if (p.plainMessage) {
        message = String(p.plainMessage)
      } else if (p.unsignedChatContent) {
        message = componentToText(p.unsignedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.signedChatContent) {
        message = componentToText(p.signedChatContent as Parameters<typeof componentToText>[0])
      } else if (p.message) {
        message = componentToText(p.message as Parameters<typeof componentToText>[0])
      }

      if (username && message) {
        dispatch(username, message, 'chat')
      }
    } catch (error) {
      console.error('[Command] player_chat 处理失败:', error)
    }
  })

  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`join:${player.username}`)) return
    logMcEvent('join', `${player.username} 加入了游戏`)
  })

  bot.on('playerLeft', (player) => {
    if (player.username === bot.username) return
    if (deduper.shouldSkipEvent(`leave:${player.username}`)) return
    logMcEvent('leave', `${player.username} 离开了游戏`)
  })

  bot.on('death', () => {
    logMcEvent('death', '机器人死亡')
  })

  bot.on('respawn', () => {
    logMcEvent('respawn', '机器人重生')
  })
}
