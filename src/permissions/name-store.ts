/**
 * 名字仓库公共实现：白名单与管理员共用。
 * 统一以「小写」作为唯一键存储，因此 xiaodi_ / Xiaodi_ / XIAODI_ 视为同一人；
 * 查询、删除、启动同步均忽略大小写，删除时不会残留大小写变体。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface NameEntry {
  displayName: string
  addedBy: string
  addedAt: string
}

export type NameData = Record<string, NameEntry>

export abstract class NameStore {
  private onChange: (() => void) | null = null

  protected constructor (
    protected readonly db: DatabaseSync,
    protected readonly table: string
  ) {}

  /** 游戏内增删后写回 .env；启动时从 .env 增量入库不要走这里。 */
  setOnChange (handler: () => void): void {
    this.onChange = handler
  }

  /** Minecraft 用户名仅含 ASCII 字符，小写即可稳定地忽略大小写。 */
  protected normalize (name: string): string {
    return name.trim().toLowerCase()
  }

  add (name: string, addedBy?: string, notify = true): void {
    const key = this.normalize(name)
    if (!key) return
    this.db.prepare(
      `INSERT OR REPLACE INTO ${this.table} (game_name, display_name, added_by, added_at) VALUES (?, ?, ?, ?)`
    ).run(key, name.trim(), addedBy || 'system', new Date().toISOString())
    if (notify) this.onChange?.()
  }

  /** 按小写删除，命中所有大小写变体（防御旧库可能残留的大小写重复行）。 */
  remove (name: string): void {
    const key = this.normalize(name)
    if (!key) return
    this.db.prepare(`DELETE FROM ${this.table} WHERE LOWER(game_name) = ?`).run(key)
    this.onChange?.()
  }

  isAllowed (name: string): boolean {
    const key = this.normalize(name)
    if (!key) return false
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM ${this.table} WHERE game_name = ?`
    ).get(key) as { ok: number } | undefined
    return row !== undefined
  }

  get (name: string): NameEntry | null {
    const key = this.normalize(name)
    if (!key) return null
    const row = this.db.prepare(
      `SELECT display_name AS displayName, added_by AS addedBy, added_at AS addedAt FROM ${this.table} WHERE game_name = ?`
    ).get(key) as NameEntry | undefined
    return row ?? null
  }

  list (): NameData {
    const rows = this.db.prepare(
      `SELECT game_name AS gameName, display_name AS displayName, added_by AS addedBy, added_at AS addedAt
       FROM ${this.table} ORDER BY game_name COLLATE NOCASE`
    ).all() as Array<{ gameName: string; displayName: string; addedBy: string; addedAt: string }>

    const result: NameData = {}
    for (const row of rows) {
      result[row.gameName] = {
        displayName: row.displayName,
        addedBy: row.addedBy,
        addedAt: row.addedAt
      }
    }
    return result
  }

  count (): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${this.table}`).get() as { c: number }
    return row.c
  }

  /** 写入 .env 用的显示名，顺序与 list() 一致。 */
  namesForEnv (): string[] {
    return Object.values(this.list())
      .map(entry => entry.displayName.trim())
      .filter(Boolean)
  }

  /** 启动时从环境变量增量写入，不删除运行时添加的条目。 */
  syncFromConfig (names: string[]): number {
    let added = 0
    for (const name of new Set(names.map(name => name.trim()).filter(Boolean))) {
      if (this.isAllowed(name)) continue
      this.add(name, 'env', false)
      added++
    }
    return added
  }
}
