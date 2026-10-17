import type ClickService from './service'
import type { ServiceResult } from '../../types'

export const CLICK_HELP = 'attack/use once | continuous | interval <1–1200 tick> | stop；use 可在末尾加 offhand；click status/stop。左键攻击所有实体（含玩家），不挖掘。'

export function executeClickCommand (service: ClickService, command: string, args: string[]): ServiceResult {
  if (command === 'click') {
    if (args.length === 1 && args[0] === 'status') return service.status()
    if (args.length === 1 && args[0] === 'stop') { service.stopAll(); return { success: true, message: '已停止左右键' } }
    return { success: false, message: CLICK_HELP }
  }
  const button = command === 'attack' ? 'attack' : command === 'use' ? 'use' : null
  if (!button) return { success: false, message: CLICK_HELP }
  const parts = [...args]
  const offhand = parts.at(-1) === 'offhand'
  if (offhand) parts.pop()
  const [mode, value] = parts
  if (mode === 'stop' && parts.length === 1 && !offhand) return service.stop(button)
  if ((mode === 'once' || mode === 'continuous') && parts.length === 1) return service.start(button, mode, 1, offhand)
  if (mode === 'interval' && parts.length === 2 && /^\d+$/.test(value)) return service.start(button, mode, Number(value), offhand)
  return { success: false, message: CLICK_HELP }
}
