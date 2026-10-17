/** SQLite 白名单仓库：独立库（data/whitelist.db），匹配忽略大小写。 */
import type { DatabaseSync } from 'node:sqlite'
import { NameStore } from './name-store'
import type { WhitelistData } from '../types'

export default class Whitelist extends NameStore {
  constructor (db: DatabaseSync) {
    super(db, 'whitelist')
  }

  list (): WhitelistData {
    return super.list()
  }
}
