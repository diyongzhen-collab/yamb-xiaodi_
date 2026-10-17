/** 本地命令窗口控制：常驻监听 F2，手动输入并发送一条服务器聊天消息。 */
import readline from 'node:readline'
import type { ServiceResult } from '../types'
import { setConsolePrompt } from './logger'

type SendChat = (message: string) => ServiceResult | Promise<ServiceResult>

export function installConsoleCommandInput (sendChat: SendChat): void {
  // 后台启动或无终端环境没有可读取的键盘输入，直接跳过该功能。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('[Console] F2 manual input is unavailable (not an interactive terminal)')
    return
  }

  let prompting = false
  let inputBuffer = ''
  const promptText = '[Console] > '
  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  const clearPrompt = (): void => {
    if (!prompting) return
    // 使用空格而非 ANSI 控制码，兼容默认 CMD 窗口。
    const width = Math.max(80, promptText.length + inputBuffer.length + 8)
    process.stdout.write(`\r${' '.repeat(width)}\r`)
  }

  const redrawPrompt = (): void => {
    if (prompting) process.stdout.write(`\r${promptText}${inputBuffer}`)
  }

  const closePrompt = (): void => {
    clearPrompt()
    process.stdout.write('\n')
    prompting = false
    inputBuffer = ''
  }

  setConsolePrompt({ clear: clearPrompt, redraw: redrawPrompt })

  process.stdin.on('keypress', async (character, key) => {

    // 原始模式下需要手动恢复 Ctrl+C 的退出行为。
    if (key?.ctrl && key.name === 'c') {
      process.emit('SIGINT')
      return
    }

    if (!prompting) {
      if (key?.name !== 'f2') return
      prompting = true
      inputBuffer = ''
      process.stdout.write('\n')
      redrawPrompt()
      return
    }

    if (key?.name === 'escape') {
      closePrompt()
      console.log('[Console] Cancelled')
      return
    }

    if (key?.name === 'backspace') {
      if (!inputBuffer) return
      inputBuffer = inputBuffer.slice(0, -1)
      clearPrompt()
      redrawPrompt()
      return
    }

    if (key?.name === 'return' || key?.name === 'enter') {
      const text = inputBuffer.trim()
      closePrompt()
      if (!text) {
        console.log('[Console] Cancelled')
        return
      }

      try {
        const result = await sendChat(text)
        if (result.success && result.message) {
          console.log(`[Console] ${result.message}`)
        } else if (result.success) {
          console.log(`[Console] Sent: ${text}`)
        } else {
          console.log(`[Console] Send failed: ${result.message || 'unknown error'}`)
        }
      } catch (err) {
        console.error('[Console] Send failed:', (err as Error).message)
      }
      return
    }

    // 只追加可打印字符；方向键等功能键在原始模式下不应进入命令内容。
    if (character && !key?.ctrl && !key?.meta && character >= ' ') {
      inputBuffer += character
      process.stdout.write(character)
    }
  })

  console.log('[Console] Press F2 to type a chat message or server command; Esc cancels')
}
