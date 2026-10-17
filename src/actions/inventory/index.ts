/** 背包、快捷栏与容器交互：所有物品移动都通过 Mineflayer 原生窗口 API 完成。 */
import { Vec3 } from 'vec3'
import type { Item } from 'prismarine-item'
import type { Block } from 'prismarine-block'
import type { Bot } from 'mineflayer'
import type { ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import { ensurePathfinder, createNearGoal } from '../shared/entity-utils'
import { sleep } from '../../platform/sleep'

export function normalizeItemKey (name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, '').trim()
}

export function findMatchingItems (items: Item[], query: string): Item[] {
  const key = normalizeItemKey(query)
  const exact = findExactMatchingItems(items, query)
  if (exact.length > 0) return exact
  return items.filter(i => normalizeItemKey(i.name).includes(key))
}

export function findExactMatchingItems (items: Item[], query: string): Item[] {
  const key = normalizeItemKey(query)
  return items.filter(item => normalizeItemKey(item.name) === key)
}

export function formatItemList (items: Item[]): string[] {
  const merged = new Map<string, number>()
  for (const item of items) {
    const name = normalizeItemKey(item.name)
    merged.set(name, (merged.get(name) ?? 0) + item.count)
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} x${count}`)
}

function itemMatchesQuery (item: Item, query: string): boolean {
  const key = normalizeItemKey(query)
  return normalizeItemKey(item.name) === key || normalizeItemKey(item.name).includes(key)
}

function sameItemStack (item: Item, sample: Item): boolean {
  return item.type === sample.type && (item.metadata ?? null) === (sample.metadata ?? null)
}

function totalSameItem (items: Item[], sample: Item): number {
  return items
    .filter(item => sameItemStack(item, sample))
    .reduce((sum, item) => sum + item.count, 0)
}

function resolveMoveCount (total: number, count: number | undefined): number {
  if (count != null && count > 0) return Math.min(count, total)
  return total
}

export default class InventoryActions {
  private mcBot: MinecraftBot

  constructor (mcBot: MinecraftBot) {
    this.mcBot = mcBot
  }

  listInventory (): ServiceResult & { lines?: string[] } {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const items = bot.inventory.items()
    if (items.length === 0) {
      return { success: true, message: '背包为空', lines: [] }
    }

    return { success: true, message: 'ok', lines: formatItemList(items) }
  }

  selectHotbarSlot (slot: number): ServiceResult {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
      return { success: false, message: '快捷栏位必须是 1 到 9' }
    }

    bot.setQuickBarSlot(slot - 1)
    const item = bot.heldItem
    const itemName = item ? normalizeItemKey(item.name) : '空手'
    console.log(`[Inventory] Selected hotbar slot ${slot}: ${itemName}`)
    return { success: true, message: `已切换到快捷栏第 ${slot} 格（${itemName}）` }
  }

  /**
   * 将主背包中第一个匹配物品与目标快捷栏交换，并自动选中目标栏位。
   * 不会丢弃物品，避免 AI 或指令操作造成背包物品丢失。
   */
  async moveBackpackItemToHotbar (itemQuery: string, targetSlot: number): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }
    if (!itemQuery.trim()) {
      return { success: false, message: '需要指定物品名称' }
    }
    if (!Number.isInteger(targetSlot) || targetSlot < 1 || targetSlot > 9) {
      return { success: false, message: '快捷栏位必须是 1 到 9' }
    }

    const sourceSlot = bot.inventory.slots.findIndex((item, index) =>
      index >= bot.inventory.inventoryStart &&
      index < bot.inventory.hotbarStart &&
      item != null && itemMatchesQuery(item, itemQuery)
    )

    if (sourceSlot < 0) {
      return { success: false, message: `主背包中没有 ${itemQuery}` }
    }

    const destinationSlot = bot.inventory.hotbarStart + targetSlot - 1
    const sourceItem = bot.inventory.slots[sourceSlot]
    try {
      await bot.moveSlotItem(sourceSlot, destinationSlot)
      bot.setQuickBarSlot(targetSlot - 1)
      const itemName = sourceItem ? normalizeItemKey(sourceItem.name) : itemQuery
      console.log(`[Inventory] Moved ${itemName} to hotbar slot ${targetSlot}`)
      return { success: true, message: `已将 ${itemName} 换到快捷栏第 ${targetSlot} 格并选中` }
    } catch (err) {
      return { success: false, message: `物品栏交换失败: ${(err as Error).message}` }
    }
  }

  async dropItem (itemQuery: string, count?: number): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    const item = matches[0]
    const dropCount = resolveMoveCount(totalSameItem(matches, item), count)

    try {
      await bot.toss(item.type, item.metadata ?? null, dropCount)
      console.log(`[Inventory] 丢弃 ${item.name} x${dropCount}`)
      return { success: true, message: `已丢弃 ${normalizeItemKey(item.name)} x${dropCount}` }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  }

  async approachBlock (
    x: number,
    y: number,
    z: number,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!bot) return { success: false, message: '机器人未就绪' }

    const target = new Vec3(x + 0.5, y + 0.5, z + 0.5)
    let distance = bot.entity.position.distanceTo(target)
    if (distance > approachDistance) {
      return {
        success: false,
        message: `容器超过 ${approachDistance} 格 (当前 ${distance.toFixed(1)} 格)`
      }
    }

    if (distance <= interactionDistance) {
      return { success: true }
    }

    const pfBot = ensurePathfinder(bot)
    const goal = createNearGoal(
      target.x,
      target.y,
      target.z,
      Math.max(1, interactionDistance - 0.5)
    )

    try {
      await pfBot.pathfinder.goto(goal)
      await sleep(150)
      distance = bot.entity.position.distanceTo(target)
      if (distance > interactionDistance + 0.5) {
        return { success: false, message: `无法接近容器 (当前 ${distance.toFixed(1)} 格)` }
      }
      return { success: true }
    } catch (err) {
      pfBot.pathfinder.stop()
      return { success: false, message: `无法接近容器: ${(err as Error).message}` }
    }
  }

  async storeInContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const matches = findMatchingItems(bot.inventory.items(), itemQuery)
    if (matches.length === 0) {
      return { success: false, message: `背包中没有 ${itemQuery}` }
    }

    const item = matches[0]
    const moveCount = resolveMoveCount(totalSameItem(matches, item), count)

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await this.openContainer(block)
      await chest.deposit(item.type, item.metadata ?? null, moveCount)
      chest.close()
      console.log(`[Container] 存入 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已存入 ${normalizeItemKey(item.name)} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  async takeFromContainer (
    x: number,
    y: number,
    z: number,
    itemQuery: string,
    count: number | undefined,
    interactionDistance: number,
    approachDistance: number
  ): Promise<ServiceResult> {
    const bot = this.mcBot.bot
    if (!this.mcBot.isReady || !bot) {
      return { success: false, message: '机器人未就绪' }
    }

    const approach = await this.approachBlock(x, y, z, interactionDistance, approachDistance)
    if (!approach.success) return approach

    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block) {
      return { success: false, message: '容器方块不可见' }
    }

    try {
      const chest = await this.openContainer(block)
      const containerItems = chest.containerItems()
      const matches = findMatchingItems(containerItems, itemQuery)
      if (matches.length === 0) {
        chest.close()
        return { success: false, message: `容器中没有 ${itemQuery}` }
      }

      const item = matches[0]
      const totalInContainer = containerItems
        .filter(i => i.type === item.type && (i.metadata ?? null) === (item.metadata ?? null))
        .reduce((sum, i) => sum + i.count, 0)
      const moveCount = count != null && count > 0
        ? Math.min(count, totalInContainer)
        : totalInContainer

      await chest.withdraw(item.type, item.metadata ?? null, moveCount)
      chest.close()
      console.log(`[Container] 取出 ${item.name} x${moveCount} @ ${x},${y},${z}`)
      return { success: true, message: `已取出 ${normalizeItemKey(item.name)} x${moveCount}` }
    } catch (err) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch { /* */ }
      return { success: false, message: (err as Error).message }
    }
  }

  /**
   * 连续开关容器时服务端可能尚未处理上一个 close，导致 windowOpen 超时。
   * 开启前清理残留窗口，并对失败做一次短暂退避重试。
   */
  private async openContainer (
    block: Block
  ): Promise<Awaited<ReturnType<Bot['openContainer']>>> {
    const bot = this.mcBot.bot
    if (!bot) throw new Error('机器人未就绪')

    let lastError: Error | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch { /* ignore */ }
        await sleep(250)
      }
      try {
        return await bot.openContainer(block)
      } catch (err) {
        lastError = err as Error
        try {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        } catch { /* ignore */ }
        if (attempt === 0) await sleep(750)
      }
    }
    throw lastError ?? new Error('打开容器失败')
  }
}

