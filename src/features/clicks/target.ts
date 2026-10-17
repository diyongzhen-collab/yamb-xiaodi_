import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

export type ClickTarget = { kind: 'entity'; entity: Entity; hit: Vec3 } |
  { kind: 'block'; position: Vec3; face: number; hit: Vec3 } | { kind: 'miss' }

/** 从眼睛沿当前准星射线选取最近交点，实体不能穿过方块或其他实体。 */
export function targetAtCrosshair (bot: Bot, reach: number): ClickTarget {
  const { position, yaw, pitch } = bot.entity
  const eye = position.offset(0, (bot.entity as Entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0)
  const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  // prismarine-world 返回带 position 的 Block；其声明误写成了迭代器坐标。
  const block = bot.world.raycast(eye, direction, reach) as { position: Vec3; face: number; intersect: Vec3 } | null
  let nearest = block ? eye.distanceTo(block.intersect) : reach
  let target: ClickTarget = block
    ? { kind: 'block', position: block.position, face: block.face, hit: block.intersect }
    : { kind: 'miss' }
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || entity.id === bot.entity.id || !entity.position ||
        !Number.isFinite(entity.width) || !Number.isFinite(entity.height) || entity.width <= 0 || entity.height <= 0 ||
        ['item', 'experience_orb', 'arrow', 'spectral_arrow', 'snowball', 'egg', 'ender_pearl'].includes(entity.name ?? '')) continue
    const width = entity.width / 2
    const min = entity.position.offset(-width, 0, -width)
    const max = entity.position.offset(width, entity.height, width)
    let near = 0
    let far = reach
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(direction[axis]) < 1e-9) {
        if (eye[axis] < min[axis] || eye[axis] > max[axis]) { far = -1; break }
      } else {
        const a = (min[axis] - eye[axis]) / direction[axis]
        const b = (max[axis] - eye[axis]) / direction[axis]
        near = Math.max(near, Math.min(a, b))
        far = Math.min(far, Math.max(a, b))
      }
    }
    if (near <= far && near < nearest) {
      nearest = near
      target = { kind: 'entity', entity, hit: eye.plus(direction.scaled(near)) }
    }
  }
  return target
}
