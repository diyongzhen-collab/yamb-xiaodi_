/** 管理员仓库：独立 SQLite 库（data/admins.db），与白名单分开管理。 */
import type { DatabaseSync } from 'node:sqlite'
import { NameStore } from './name-store'

export default class AdminStore extends NameStore {
  constructor (db: DatabaseSync) {
    super(db, 'admins')
  }

  isAdmin (name: string): boolean {
    return this.isAllowed(name)
  }
}
