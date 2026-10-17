import type { Bot } from 'mineflayer'

// 其他玩家的朝向以一个字节传输（约 1.40625 度），不能覆盖更精确的传送朝向。
const ANGLE_TOLERANCE = 2 * Math.PI / 256 + 1e-6
export function needsViewCorrection (yaw: number, pitch: number, targetYaw: number, targetPitch: number): boolean {
  const deltaYaw = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw))
  return Math.abs(deltaYaw) > ANGLE_TOLERANCE || Math.abs(targetPitch - pitch) > ANGLE_TOLERANCE
}

/** 接受 tpahere 前安装，等实际到达后核对一次请求者视角。返回取消函数。 */
export function watchTeleportView (bot: Bot, playerName: string, isCurrent: () => boolean, onFinish: () => void = () => {}): () => void {
  let arrivedAt = 0
  let finished = false
  const deadline = Date.now() + 15_000
  const onMove = (): void => { arrivedAt = Date.now() }
  const cancel = (): void => {
    if (finished) return
    finished = true
    clearInterval(timer)
    bot.removeListener('forcedMove', onMove)
    bot.removeListener('end', cancel)
    onFinish()
  }
  const timer = setInterval(() => {
    if (finished || !isCurrent() || Date.now() >= deadline) { cancel(); return }
    // 给实体生成与朝向包留出到达时间。
    if (!arrivedAt || Date.now() - arrivedAt < 300) return
    const player = Object.values(bot.players).find(p => p.username.toLowerCase() === playerName.toLowerCase())?.entity
    if (!player || player.position.distanceTo(bot.entity.position) > 6) return
    const yaw = (player as typeof player & { headYaw?: number }).headYaw ?? player.yaw
    const pitch = player.pitch
    if (![yaw, pitch, bot.entity.yaw, bot.entity.pitch].every(Number.isFinite)) return
    cancel()
    if (!needsViewCorrection(bot.entity.yaw, bot.entity.pitch, yaw, pitch)) {
      console.log('[Teleport] 视角一致，保留服务器传送的精确朝向')
      return
    }
    void bot.look(yaw, pitch, true).then(() => {
      console.log(`[Teleport] 已校正到 ${playerName} 的可见朝向（单次同步）`)
    }).catch(err => console.warn('[Teleport] 朝向校正失败:', (err as Error).message))
  }, 100)
  timer.unref()
  bot.on('forcedMove', onMove)
  bot.once('end', cancel)
  return cancel
}
