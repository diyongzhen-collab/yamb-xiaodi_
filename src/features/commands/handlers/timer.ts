/** 定时指令的文本解析：支持相对时间、当天时刻和绝对日期时间。 */
import type ScheduledCommandService from '../../scheduler/service'
import type { CommandSource } from '../parser'
import type { CommandContext } from './types'

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}
const DAILY_INTERVAL_MS = DURATION_UNITS.d

function parseClock (value: string): { hour: number; minute: number; second: number } | null {
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] ?? 0)
  if (hour > 23 || minute > 59 || second > 59) return null
  return { hour, minute, second }
}

function nextClockTime (value: string): Date | null {
  const clock = parseClock(value)
  if (!clock) return null
  const runAt = new Date()
  runAt.setHours(clock.hour, clock.minute, clock.second, 0)
  if (runAt.getTime() <= Date.now()) runAt.setDate(runAt.getDate() + 1)
  return runAt
}

function absoluteTime (dateText: string, timeText: string): Date | null {
  const dateMatch = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const clock = parseClock(timeText)
  if (!dateMatch || !clock) return null
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const runAt = new Date(year, month - 1, day, clock.hour, clock.minute, clock.second, 0)
  if (
    runAt.getFullYear() !== year ||
    runAt.getMonth() !== month - 1 ||
    runAt.getDate() !== day
  ) return null
  return runAt
}

function durationMs (value: string): number | null {
  // 最大延迟限制为一年，防止异常数字生成不可控的长期任务。
  const match = value.toLowerCase().match(/^(\d+)(s|m|h|d)$/)
  if (!match) return null
  const amount = Number(match[1])
  const delay = amount * DURATION_UNITS[match[2]]
  if (!Number.isSafeInteger(delay) || delay <= 0 || delay > 365 * DURATION_UNITS.d) return null
  return delay
}

function durationTime (value: string): Date | null {
  const delay = durationMs(value)
  return delay == null ? null : new Date(Date.now() + delay)
}

function formatRunAt (iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function usage (): string {
  return [
    'timer add <HH:mm[:ss]> <指令>',
    'timer add <YYYY-MM-DD> <HH:mm[:ss]> <指令>',
    'timer in <10s|5m|2h|1d> <指令>',
    'timer every <10s|5m|2h|1d> <指令>',
    'timer list',
    'timer remove <ID>'
  ].join('\n')
}

export async function handleTimer (
  ctx: CommandContext,
  scheduler: ScheduledCommandService,
  username: string,
  parts: string[],
  source: CommandSource
): Promise<void> {
  if (!ctx.isAdmin(username)) {
    await ctx.reply(username, ctx.messages.text('noPermission'), source)
    return
  }

  const action = (parts.shift() || '').toLowerCase()
  if (action === 'list') {
    const tasks = scheduler.list()
    if (tasks.length === 0) {
      await ctx.reply(username, '当前没有定时任务', source)
      return
    }
    const lines = tasks.slice(0, 12).map(task => {
      const repeat = task.repeatIntervalMs == null
        ? '单次'
        : task.repeatIntervalMs === DAILY_INTERVAL_MS ? '每天' : `每 ${Math.round(task.repeatIntervalMs / 1000)} 秒`
      return `#${task.id} [${repeat}] ${formatRunAt(task.runAt)} → ${task.command}`
    })
    if (tasks.length > lines.length) lines.push(`还有 ${tasks.length - lines.length} 个任务未显示`)
    await ctx.reply(username, lines.join('\n'), source)
    return
  }

  if (action === 'remove' || action === 'delete' || action === 'cancel') {
    const id = Number(parts[0])
    const result = scheduler.remove(id)
    await ctx.reply(username, result.message || (result.success ? '已删除' : '删除失败'), source)
    return
  }

  let runAt: Date | null = null
  let repeatIntervalMs: number | null = null
  let commandParts: string[] = []

  if (action === 'in') {
    runAt = durationTime(parts.shift() || '')
    commandParts = parts
  } else if (action === 'every') {
    const interval = durationMs(parts.shift() || '')
    if (interval != null) {
      runAt = new Date(Date.now() + interval)
      repeatIntervalMs = interval
    }
    commandParts = parts
  } else if (action === 'add') {
    const first = parts.shift() || ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
      runAt = absoluteTime(first, parts.shift() || '')
    } else {
      runAt = nextClockTime(first)
      // 未指定日期的 add 表示每天该时刻执行，符合“固定时间长期触发”的用法。
      repeatIntervalMs = DAILY_INTERVAL_MS
    }
    commandParts = parts
  }

  const command = commandParts.join(' ').trim()
  if (!runAt || !command || runAt.getTime() <= Date.now()) {
    await ctx.reply(username, usage(), source)
    return
  }

  const result = scheduler.add(username, command, runAt, repeatIntervalMs)
  await ctx.reply(username, result.success
    ? `${result.message}，执行时间 ${runAt.toLocaleString('zh-CN', { hour12: false })}：${command}`
    : result.message || '创建定时任务失败', source)
}
