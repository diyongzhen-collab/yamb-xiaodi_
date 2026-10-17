import fs from 'node:fs'
import path from 'node:path'

/** 启动时读取一次发布 README，与打包脚本写入的版本保持一致。 */
function readVersionLabel (): string {
  try {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8')
    const versionLine = readme.split(/\r?\n/).find(line => line.startsWith('**版本：')) ?? ''
    const version = versionLine.match(/版本：`(\d+\.\d+)`/)?.[1]
    if (version) return `v${version}`
  } catch {
    // 老部署目录未附带 README 时仍可启动界面。
  }
  return '版本未知'
}

export const VERSION_LABEL = readVersionLabel()
