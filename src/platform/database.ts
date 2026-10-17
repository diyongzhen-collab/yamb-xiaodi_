/**
 * SQLite 初始化与关闭。
 * - game.db：容器别名、定时任务（运行主库）
 * - whitelist.db：白名单（独立库，统一小写存储，忽略大小写）
 * - admins.db：管理员（独立库，与白名单分开管理）
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

let db: DatabaseSync | null = null
let whitelistDb: DatabaseSync | null = null
let adminDb: DatabaseSync | null = null

export function initDatabase (dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS containers (
      alias     TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      x         INTEGER NOT NULL,
      y         INTEGER NOT NULL,
      z         INTEGER NOT NULL,
      dimension TEXT NOT NULL DEFAULT 'overworld',
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );

    -- 一次性定时任务在进程重启后仍然存在，由 Scheduler 在下次 spawn 时恢复。
    CREATE TABLE IF NOT EXISTS scheduled_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      owner      TEXT NOT NULL,
      command    TEXT NOT NULL,
      run_at     TEXT NOT NULL,
      repeat_interval_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_commands_run_at
      ON scheduled_commands (run_at);

    -- 锁定状态持久化：重启后恢复普通锁定（滞空状态不恢复，重启后物理上必然落地）。
    CREATE TABLE IF NOT EXISTS lock_state (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      locked    INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT
    );

    -- phome 传送点坐标持久化：TUI 判断 bot 是否在传送点正负 500 格内。
    CREATE TABLE IF NOT EXISTS waypoint_coords (
      alias TEXT PRIMARY KEY,
      x     REAL NOT NULL,
      y     REAL NOT NULL,
      z     REAL NOT NULL
    );
  `)

  // 旧版主库没有循环间隔列时平滑升级，不影响已有的一次性任务。
  const columns = db.prepare('PRAGMA table_info(scheduled_commands)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'repeat_interval_ms')) {
    db.exec('ALTER TABLE scheduled_commands ADD COLUMN repeat_interval_ms INTEGER')
  }

  console.log(`[DB] SQLite ready: ${dbPath}`)
  return db
}

/** 白名单独立库；首次运行时将旧版主库（原 player.db）的白名单表平滑迁移过来。 */
export function initWhitelistDatabase (dbPath: string, legacyDb?: DatabaseSync): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const wdb = new DatabaseSync(dbPath)
  wdb.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      game_name    TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      added_by     TEXT NOT NULL,
      added_at     TEXT NOT NULL
    );
  `)

  // 兼容旧表结构：缺失 display_name 列时补列（同名按小写唯一，故不会冲突）。
  const columns = wdb.prepare('PRAGMA table_info(whitelist)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'display_name')) {
    wdb.exec('ALTER TABLE whitelist ADD COLUMN display_name TEXT NOT NULL DEFAULT \'\'')
  }

  // 仅当新库为空时迁移旧版主库中的白名单（保留显示名原始大小写）。
  if (legacyDb) {
    const count = wdb.prepare('SELECT COUNT(*) AS c FROM whitelist').get() as { c: number }
    if (count.c === 0) {
      const legacyTable = legacyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'whitelist'"
      ).get()
      if (legacyTable) {
        const rows = legacyDb.prepare('SELECT game_name, added_by, added_at FROM whitelist').all() as Array<{
          game_name: string
          added_by: string
          added_at: string
        }>
        const insert = wdb.prepare(
          'INSERT OR IGNORE INTO whitelist (game_name, display_name, added_by, added_at) VALUES (?, ?, ?, ?)'
        )
        wdb.exec('BEGIN')
        try {
          for (const row of rows) {
            insert.run(String(row.game_name).trim().toLowerCase(), String(row.game_name), row.added_by, row.added_at)
          }
          wdb.exec('COMMIT')
        } catch (err) {
          wdb.exec('ROLLBACK')
          throw err
        }
        if (rows.length > 0) {
          console.log(`[DB] Migrated ${rows.length} whitelist entries from legacy database`)
          // 迁移成功后移除旧版主库中的白名单表，避免与独立白名单库并存。
          legacyDb.exec('DROP TABLE IF EXISTS whitelist')
          console.log('[DB] Dropped legacy whitelist table from main database')
        }
      }
    }
  }

  whitelistDb = wdb
  console.log(`[DB] Whitelist SQLite ready: ${dbPath}`)
  return wdb
}

/** 管理员独立库。 */
export function initAdminDatabase (dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const adb = new DatabaseSync(dbPath)
  adb.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      game_name    TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      added_by     TEXT NOT NULL,
      added_at     TEXT NOT NULL
    );
  `)

  const columns = adb.prepare('PRAGMA table_info(admins)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'display_name')) {
    adb.exec('ALTER TABLE admins ADD COLUMN display_name TEXT NOT NULL DEFAULT \'\'')
  }

  adminDb = adb
  console.log(`[DB] Admins SQLite ready: ${dbPath}`)
  return adb
}

export function closeDatabase (): void {
  if (db) {
    db.close()
    db = null
  }
  if (whitelistDb) {
    whitelistDb.close()
    whitelistDb = null
  }
  if (adminDb) {
    adminDb.close()
    adminDb = null
  }
}

/** 从旧版 whitelist.json 迁移数据（仅当白名单库为空时） */
export function migrateFromJson (jsonPath: string): void {
  const database = whitelistDb
  if (!database) throw new Error('Whitelist database not initialized')
  const count = database.prepare('SELECT COUNT(*) AS c FROM whitelist').get() as { c: number }
  if (count.c > 0) return

  if (!fs.existsSync(jsonPath)) return

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, { addedBy?: string; addedAt?: string }>
    const insert = database.prepare(
      'INSERT OR IGNORE INTO whitelist (game_name, display_name, added_by, added_at) VALUES (?, ?, ?, ?)'
    )

    database.exec('BEGIN')
    try {
      let migrated = 0
      for (const [name, info] of Object.entries(data)) {
        insert.run(name.trim().toLowerCase(), name, info.addedBy || 'migration', info.addedAt || new Date().toISOString())
        migrated++
      }
      database.exec('COMMIT')
      if (migrated > 0) {
        console.log(`[DB] Migrated ${migrated} entries from ${jsonPath}`)
      }
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    console.warn('[DB] JSON migration skipped:', (err as Error).message)
  }
}

export type { DatabaseSync }
