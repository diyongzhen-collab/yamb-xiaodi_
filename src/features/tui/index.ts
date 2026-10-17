/** 单实例终端 TUI：一行式状态头 + 彩色滚动日志 + 底部输入框。需在 Windows Terminal 中运行以获得正确渲染。 */
import blessed from 'blessed'
import type { ServiceResult } from '../../types'
import { setLogListener } from '../../platform/logger'
import { VERSION_LABEL } from '../../platform/version'

export interface TuiOptions {
  /** 输入框回车：发送公屏消息、服务器命令，或识别「锁定/解锁」本地指令。 */
  sendChat: (message: string) => ServiceResult | Promise<ServiceResult>
  /** 刷新状态头：返回一行文本及配色。 */
  getStatus: () => { line: string; color: 'green' | 'yellow' | 'red' | 'cyan' }
  /** Ctrl+C 退出时的清理回调（TUI 已销毁后调用）。 */
  onExit: () => void
}

export interface TuiHandle {
  destroy: () => void
}

const MAX_LOG_LINES = 1000
const SCROLL_STEP = 3

/** 计算文本在终端中的显示宽度：CJK 字符按 2 格，其余按 1 格。 */
function displayWidth (text: string): number {
  let width = 0
  for (const char of text) {
    width += char.charCodeAt(0) > 0xff ? 2 : 1
  }
  return width
}

/** 按显示宽度截断，超长时尾部加省略号。 */
function truncateByDisplayWidth (text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text
  let result = ''
  let width = 0
  for (const char of text) {
    const charWidth = char.charCodeAt(0) > 0xff ? 2 : 1
    if (width + charWidth > maxWidth - 1) break
    result += char
    width += charWidth
  }
  return `${result}…`
}

/** 将 logger 行 `[日期 时间] [LEVEL] 内容` 解析成 {time, level, text}；解析失败返回 null。 */
function parseLogLine (line: string): { time: string; level: string; text: string } | null {
  const match = line.match(/^\[([^\]]+)\] \[([^\]]+)\] (.*)$/)
  if (!match) return null
  const time = (match[1].split(' ')[1] ?? match[1]).slice(0, 8)
  return { time, level: match[2].toUpperCase(), text: match[3] }
}

export function startTui (options: TuiOptions): TuiHandle {
  const screen = blessed.screen({
    smartCSR: true,
    title: `yamb ${VERSION_LABEL}`,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false
  })

  // 顶部一行式状态头（高度 3 = 上下边框 + 1 行内容）
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    label: ` Status | ${VERSION_LABEL} `
  })

  const logBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    bottom: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } }
  })

  const input = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    keys: true,
    mouse: true,
    inputOnFocus: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      focus: { border: { fg: 'yellow' } }
    },
    label: ' Send (Enter) '
  })

  const logLines: string[] = []
  let viewOffset = 0
  let destroyed = false

  const cursorInput = input as typeof input & {
    _updateCursor?: (get?: boolean) => void
  }
  const cursorProgram = screen.program as typeof screen.program & {
    x: number
    y: number
  }

  // 屏幕重绘会让终端硬件光标短暂跟随日志输出。重绘期间隐藏光标，
  // 完成后强制 blessed 重新计算输入框位置再显示，避免光标停在日志/状态区。
  screen.on('prerender', () => {
    cursorProgram.hideCursor()
  })
  screen.on('render', () => {
    if (destroyed || screen.focused !== input) return
    // 绕过 blessed 对 program.x/y 的错误缓存判断，强制发出光标定位。
    cursorProgram.x = -1
    cursorProgram.y = -1
    cursorInput._updateCursor?.(true)
    cursorProgram.showCursor()
  })

  const viewportHeight = (): number => {
    const h = typeof logBox.height === 'number' ? logBox.height : 10
    return Math.max(1, h - 2)
  }

  const maxOffset = (): number => {
    return Math.max(0, logLines.length - viewportHeight())
  }

  const renderLogs = (): void => {
    if (destroyed) return
    const vh = viewportHeight()
    const maxOff = maxOffset()
    if (viewOffset > maxOff) viewOffset = maxOff

    if (logLines.length === 0) {
      logBox.setContent('{gray-fg}(no logs){/}')
      return
    }

    // 从底部往上取视口：offset=0 显示最后 vh 行（贴底跟随）
    const end = logLines.length - viewOffset
    const start = Math.max(0, end - vh)
    const slice = logLines.slice(start, end)
    logBox.setContent(slice.join('\n'))
  }

  const renderStatus = (): void => {
    if (destroyed) return
    try {
      let { line, color } = options.getStatus()
      const scrollHint = viewOffset > 0 ? ` {yellow-fg}↑${viewOffset}{/}` : ''
      // 状态行按显示宽度截断，避免超宽换行溢出到日志区。
      const screenWidth = typeof screen.width === 'number' ? screen.width : 80
      const maxWidth = Math.max(10, screenWidth - 6 - displayWidth(scrollHint))
      line = truncateByDisplayWidth(line, maxWidth)
      header.setContent(` {${color}-fg}${blessed.escape(line)}{/}${scrollHint} `)
    } catch (err) {
      header.setContent(` {red-fg}状态刷新失败: ${blessed.escape((err as Error).message)}{/} `)
    }
    screen.render()
  }

  const appendLog = (line: string): void => {
    const parsed = parseLogLine(line)
    if (parsed) {
      // 与文件日志同一条：`[HH:mm:ss] [LEVEL] 正文`（文件里日期更长，正文与级别一致）。
      const display = `[${parsed.time}] [${parsed.level}] ${blessed.escape(parsed.text)}`
      const colored = parsed.level === 'ERROR'
        ? `{red-fg}${display}{/}`
        : parsed.level === 'WARN'
          ? `{yellow-fg}${display}{/}`
          : display
      logLines.push(colored)
    } else {
      logLines.push(blessed.escape(line))
    }
    if (logLines.length > MAX_LOG_LINES) {
      logLines.splice(0, logLines.length - MAX_LOG_LINES)
    }
    renderLogs()
    screen.render()
  }

  setLogListener(line => {
    if (!destroyed) appendLog(line)
  })

  const statusTimer = setInterval(renderStatus, 2000)

  // 鼠标滚轮滚动日志：向上看更旧，向下回底部。
  screen.on('wheelup', () => scrollBy(SCROLL_STEP))
  screen.on('wheeldown', () => scrollBy(-SCROLL_STEP))
  const scrollBy = (delta: number): void => {
    viewOffset = Math.max(0, Math.min(maxOffset(), viewOffset + delta))
    renderLogs()
    renderStatus()
  }

  input.on('keypress', (_ch: string, key: { name?: string }) => {
    if (!key?.name) return
    switch (key.name) {
      case 'up':
        scrollBy(SCROLL_STEP)
        break
      case 'down':
        scrollBy(-SCROLL_STEP)
        break
      case 'pageup':
        scrollBy(viewportHeight())
        break
      case 'pagedown':
        scrollBy(-viewportHeight())
        break
      case 'home':
        scrollBy(Number.MAX_SAFE_INTEGER)
        break
      case 'end':
        scrollBy(-Number.MAX_SAFE_INTEGER)
        break
    }
  })

  input.on('submit', async () => {
    const text = (input.getValue() || '').trim()
    input.clearValue()
    input.focus()
    if (!text) return
    try {
      const result = await options.sendChat(text)
      if (result.success && result.message) {
        console.log(`[TUI] ${result.message}`)
      } else if (result.success) {
        console.log(`[TUI] 已发送: ${text}`)
      } else {
        console.warn(`[TUI] 发送失败: ${result.message || '未知错误'}`)
      }
    } catch (err) {
      console.error(`[TUI] 发送异常: ${(err as Error).message}`)
    }
  })
  input.key(['escape'], () => {
    input.clearValue()
    input.focus()
  })

  screen.key(['C-c'], () => {
    if (destroyed) return
    destroy()
    options.onExit()
  })

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    clearInterval(statusTimer)
    setLogListener(null)
    try {
      screen.destroy()
    } catch {
      // 终端已关闭时忽略
    }
  }

  input.focus()
  renderStatus()
  renderLogs()
  console.log('[TUI] 终端界面已启动：↑/↓/PageUp/PageDown/Home/End 翻日志，Enter 发送，Esc 清空，Ctrl+C 退出')
  return { destroy }
}
