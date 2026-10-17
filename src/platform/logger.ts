/** 持久化控制台日志：保留原始输出，同时按日期写入 logs/bot-YYYY-MM-DD.log。 */
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

const logDirectory = path.resolve(process.cwd(), 'logs')
let installed = false
let consolePrompt: { clear: () => void; redraw: () => void } | null = null
let logListener: ((line: string) => void) | null = null
let logStream: fs.WriteStream | null = null
let activeLogPath = ''
let streamBackpressured = false
let droppedLineCount = 0
let originalConsoleError: ((...args: unknown[]) => void) | null = null
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit'
})
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
})

/** 注册交互式输入行：日志输出前暂时擦除，输出后再重绘，避免覆盖正在输入的命令。 */
export function setConsolePrompt (prompt: { clear: () => void; redraw: () => void } | null): void {
  consolePrompt = prompt
}

/** 注册日志行监听（供 TUI 等界面实时展示）；同一时间只允许一个监听者。 */
export function setLogListener (listener: ((line: string) => void) | null): void {
  logListener = listener
}

function timestamp (): string {
  const now = new Date()
  const date = dateFormatter.format(now).replace(/\//g, '-')
  return `${date} ${timeFormatter.format(now)}`
}

function logPath (): string {
  const date = timestamp().slice(0, 10)
  return path.join(logDirectory, `bot-${date}.log`)
}

/**
 * 使用异步写入流，而不是在每条日志上 appendFileSync。
 * Mineflayer 收到大量数据或聊天时，同步磁盘 I/O 会卡住事件循环，进而造成连接超时。
 */
function getLogStream (): fs.WriteStream {
  const nextPath = logPath()
  if (logStream && activeLogPath === nextPath) return logStream

  if (logStream) logStream.end()
  activeLogPath = nextPath
  logStream = fs.createWriteStream(nextPath, { flags: 'a', encoding: 'utf8' })
  logStream.on('error', (err) => {
    // 不能调用被包装后的 console.error，否则日志故障可能递归写入。
    originalConsoleError?.('[Logger] failed to write log:', err)
  })
  return logStream
}

function writeLog (line: string): void {
  const stream = getLogStream()
  // 磁盘写入暂时跟不上时优先保护游戏连接，恢复后留下汇总提示。
  if (streamBackpressured) {
    droppedLineCount++
    return
  }

  if (!stream.write(line)) {
    streamBackpressured = true
    stream.once('drain', () => {
      streamBackpressured = false
      if (droppedLineCount === 0) return
      const dropped = droppedLineCount
      droppedLineCount = 0
      writeLog(`[${timestamp()}] [WARN] [Logger] Disk backlog: skipped ${dropped} log line(s)\n`)
    })
  }
}

export function installLogger (): void {
  // 防止热重载或重复启动入口时多次包裹 console，造成重复写日志。
  if (installed) return
  installed = true
  fs.mkdirSync(logDirectory, { recursive: true })

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }
  originalConsoleError = original.error

  for (const level of Object.keys(original) as Array<keyof typeof original>) {
    console[level] = (...args: unknown[]) => {
      const line = `[${timestamp()}] [${level.toUpperCase()}] ${util.format(...args)}\n`
      // 控制台输入行不属于日志内容；先擦掉它，写完日志后再显示原输入。
      consolePrompt?.clear()
      try {
        writeLog(line)
      } catch (err) {
        original.error('[Logger] failed to write log:', err)
      }
      logListener?.(line.trimEnd())
      // TUI 激活时（存在日志监听者），不直接写原始 stdout，避免破坏 blessed 的全屏渲染；
      // 显示交给 TUI 的日志区，文件日志照常写入。
      if (!logListener) {
        original[level](...args)
      }
      consolePrompt?.redraw()
    }
  }

  original.log(`[Logger] Persistent logs: ${logDirectory}`)
}
