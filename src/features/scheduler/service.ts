/** 基于 SQLite 的定时任务服务；支持一次性与循环任务，重启后仍会保留并继续调度。 */
import type { DatabaseSync } from 'node:sqlite'
import type { ServiceResult } from '../../types'
import { isRemovedCommand } from '../commands/parser'

const MAX_TIMER_DELAY_MS = 2_147_000_000
const RETRY_DELAY_MS = 30_000
const MAX_REPEAT_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000

export interface ScheduledCommandRecord {
  id: number
  owner: string
  command: string
  runAt: string
  repeatIntervalMs: number | null
  createdAt: string
}

type ScheduledCommandExecutor = (task: ScheduledCommandRecord) => Promise<void>

export function parseScheduleDateTime (value: string): Date | null {
  const normalized = value.trim().replace('T', ' ')
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText ?? 0)
  const date = new Date(year, month - 1, day, hour, minute, second, 0)

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) return null

  return date
}

export default class ScheduledCommandService {
  private db: DatabaseSync
  private executor: ScheduledCommandExecutor | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private running = false
  private generation = 0

  constructor (db: DatabaseSync) {
    this.db = db
  }

  setExecutor (executor: ScheduledCommandExecutor): void {
    this.executor = executor
  }

  start (): void {
    if (this.started) return
    this.started = true
    this.generation++
    console.log(`[Scheduler] Started with ${this.count()} pending task(s)`)
    this.scheduleNext()
  }

  stop (): void {
    this.started = false
    this.generation++
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  add (
    owner: string,
    command: string,
    runAt: Date,
    repeatIntervalMs: number | null = null
  ): ServiceResult & { task?: ScheduledCommandRecord } {
    // 去掉开头 /，因为存储的是机器人自己的指令，而不是服务器聊天指令。
    const normalizedCommand = command.trim().replace(/^\/+/, '')
    if (!normalizedCommand) return { success: false, message: '定时指令不能为空' }
    if (isRemovedCommand(normalizedCommand)) return { success: false, message: '此功能已在 3.0 中移除，不能创建定时任务' }
    if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now()) {
      return { success: false, message: '执行时间必须晚于当前时间' }
    }
    if (repeatIntervalMs != null && (
      !Number.isSafeInteger(repeatIntervalMs) || repeatIntervalMs <= 0 || repeatIntervalMs > MAX_REPEAT_INTERVAL_MS
    )) {
      return { success: false, message: '循环间隔必须在 1 毫秒到 365 天之间' }
    }

    const createdAt = new Date().toISOString()
    const runAtIso = runAt.toISOString()
    const result = this.db.prepare(`
      INSERT INTO scheduled_commands (owner, command, run_at, repeat_interval_ms, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(owner, normalizedCommand, runAtIso, repeatIntervalMs, createdAt)
    const id = Number(result.lastInsertRowid)
    const task = { id, owner, command: normalizedCommand, runAt: runAtIso, repeatIntervalMs, createdAt }
    console.log(`[Scheduler] Added #${id} for ${runAtIso}: ${normalizedCommand}`)
    this.scheduleNext()
    return { success: true, message: repeatIntervalMs == null ? `已创建一次性定时任务 #${id}` : `已创建循环定时任务 #${id}`, task }
  }

  remove (id: number): ServiceResult {
    if (!Number.isInteger(id) || id <= 0) return { success: false, message: '任务 ID 无效' }
    const result = this.db.prepare('DELETE FROM scheduled_commands WHERE id = ?').run(id)
    if (result.changes === 0) return { success: false, message: `没有找到任务 #${id}` }
    console.log(`[Scheduler] Removed #${id}`)
    this.scheduleNext()
    return { success: true, message: `已删除定时任务 #${id}` }
  }

  list (): ScheduledCommandRecord[] {
    return this.db.prepare(`
      SELECT id, owner, command, run_at AS runAt,
             repeat_interval_ms AS repeatIntervalMs, created_at AS createdAt
      FROM scheduled_commands
      ORDER BY run_at, id
    `).all() as unknown as ScheduledCommandRecord[]
  }

  count (): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM scheduled_commands').get() as { count: number }
    return row.count
  }

  private scheduleNext (forcedDelayMs?: number): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)

    let delay = forcedDelayMs
    if (delay == null) {
      const next = this.db.prepare(`
        SELECT run_at AS runAt FROM scheduled_commands ORDER BY run_at, id LIMIT 1
      `).get() as { runAt: string } | undefined
      if (!next) {
        this.timer = null
        return
      }
      delay = Math.max(0, Date.parse(next.runAt) - Date.now())
    }

    // Node 的单个定时器有毫秒上限，远期任务分段等待。
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runDue()
    }, Math.min(delay, MAX_TIMER_DELAY_MS))
  }

  private async runDue (): Promise<void> {
    if (!this.started || this.running) return
    this.running = true
    const generation = this.generation
    let shouldRetry = false

    try {
      const due = this.db.prepare(`
        SELECT id, owner, command, run_at AS runAt,
               repeat_interval_ms AS repeatIntervalMs, created_at AS createdAt
        FROM scheduled_commands
        WHERE run_at <= ?
        ORDER BY run_at, id
      `).all(new Date().toISOString()) as unknown as ScheduledCommandRecord[]

      for (const task of due) {
        if (!this.started || generation !== this.generation) break
        // 之前的任务执行期间，管理员可能已删除同一批次中的后续任务。
        if (!this.db.prepare('SELECT id FROM scheduled_commands WHERE id = ?').get(task.id)) continue
        try {
          if (!this.executor) throw new Error('定时任务执行器未初始化')
          console.log(`[Scheduler] Running #${task.id}: ${task.command}`)
          await this.executor(task)
          if (!this.started || generation !== this.generation) break
          if (task.repeatIntervalMs != null) {
            // 以原计划时间为基准推进，避免一次执行延迟让循环任务逐渐漂移。
            const nextRunAt = this.nextRepeatRunAt(task.runAt, task.repeatIntervalMs)
            this.db.prepare('UPDATE scheduled_commands SET run_at = ? WHERE id = ?').run(nextRunAt.toISOString(), task.id)
            console.log(`[Scheduler] Repeated #${task.id}, next run: ${nextRunAt.toISOString()}`)
          } else {
            this.db.prepare('DELETE FROM scheduled_commands WHERE id = ?').run(task.id)
            console.log(`[Scheduler] Completed #${task.id}`)
          }
        } catch (err) {
          if (!this.started || generation !== this.generation) break
          const error = err as Error & { permanent?: boolean }
          if (error.permanent === true) {
            // 任务内容/权限等永久性错误：删除任务，避免每 30 秒无限重试刷日志。
            this.db.prepare('DELETE FROM scheduled_commands WHERE id = ?').run(task.id)
            console.error(`[Scheduler] Task #${task.id} 配置无效，已删除:`, error.message)
          } else {
            // 机器人离线等暂时性失败不删除任务，30 秒后重新尝试。
            shouldRetry = true
            console.error(`[Scheduler] Task #${task.id} failed, retrying later:`, error.message)
          }
        }
      }
    } catch (err) {
      shouldRetry = true
      console.error('[Scheduler] 读取或更新任务失败，稍后重试:', err)
    } finally {
      this.running = false
      this.scheduleNext(shouldRetry ? RETRY_DELAY_MS : undefined)
    }
  }

  /** 计算未来的下一次执行点；停机期间错过的周期不会在重启后连续补跑。 */
  private nextRepeatRunAt (previousRunAt: string, intervalMs: number): Date {
    const previousMs = Date.parse(previousRunAt)
    const now = Date.now()
    const steps = Math.max(1, Math.floor((now - previousMs) / intervalMs) + 1)
    return new Date(previousMs + steps * intervalMs)
  }
}
