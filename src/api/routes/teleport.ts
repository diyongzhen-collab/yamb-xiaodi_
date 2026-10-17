import { Router, Request, Response } from 'express'
import type TeleportService from '../../features/teleport/service'
import type Whitelist from '../../permissions/whitelist'
import type AdminStore from '../../permissions/admin-store'

export default function createTeleportRoutes (
  teleportService: TeleportService,
  whitelist: Whitelist,
  adminStore: AdminStore
): Router {
  const router = Router()

  /** 管理员或白名单玩家均可使用传送/锁定等游戏内能力。 */
  const isAuthorized = (gameName: string): boolean => {
    return whitelist.isAllowed(gameName) || adminStore.isAdmin(gameName)
  }

  router.post('/tp/accept', async (req: Request, res: Response) => {
    const { game_name } = req.body as { game_name?: string }
    if (!game_name) {
      return res.status(400).json({ success: false, message: 'Missing game_name' })
    }
    if (!isAuthorized(game_name)) {
      return res.json({ success: false, message: `${game_name} 不在白名单或管理员列表中` })
    }

    const result = await teleportService.acceptRequest(game_name, 'tpa')
    res.json(result)
  })

  router.post('/home', async (req: Request, res: Response) => {
    const { game_name, waypoint } = req.body as { game_name?: string; waypoint?: string }
    if (!game_name || !waypoint) {
      return res.status(400).json({ success: false, message: 'Missing game_name or waypoint' })
    }
    if (!isAuthorized(game_name)) {
      return res.json({ success: false, message: `${game_name} 不在白名单或管理员列表中` })
    }

    const result = await teleportService.goToPlayerViaWaypoint(game_name, waypoint)
    res.json(result)
  })

  router.post('/lock', async (req: Request, res: Response) => {
    const { game_name } = req.body as { game_name?: string }
    if (!game_name) {
      return res.status(400).json({ success: false, message: 'Missing game_name' })
    }
    if (!isAuthorized(game_name)) {
      return res.json({ success: false, message: `${game_name} 不在白名单或管理员列表中` })
    }

    const result = await teleportService.prepareAndLock(game_name)
    if (!result.success) {
      const message = result.code === 'already'
        ? 'bot 已锁定'
        : result.code === 'not_ready'
          ? '机器人未就绪'
          : result.code === 'hover_failed'
            ? '悬空失败，未进入锁定'
            : '锁定失败'
      return res.json({ success: false, message, code: result.code })
    }
    res.json({ success: true, message: '已锁定' })
  })

  router.post('/unlock', (req: Request, res: Response) => {
    const { game_name } = req.body as { game_name?: string }
    if (!game_name) {
      return res.status(400).json({ success: false, message: 'Missing game_name' })
    }
    if (!isAuthorized(game_name)) {
      return res.json({ success: false, message: `${game_name} 不在白名单或管理员列表中` })
    }
    if (!teleportService.isLocked()) {
      return res.json({ success: false, message: 'bot 未锁定' })
    }

    teleportService.unlock()
    res.json({ success: true, message: '已解锁' })
  })

  router.post('/whitelist/add', (req: Request, res: Response) => {
    const { game_name, added_by } = req.body as { game_name?: string; added_by?: string }
    if (!game_name) {
      return res.status(400).json({ success: false, message: 'Missing game_name' })
    }

    if (whitelist.isAllowed(game_name)) {
      return res.json({ success: false, message: `${game_name} 已在白名单中` })
    }

    whitelist.add(game_name, added_by)
    res.json({ success: true, message: `已添加白名单: ${game_name}` })
  })

  router.post('/whitelist/remove', (req: Request, res: Response) => {
    const { game_name } = req.body as { game_name?: string }
    if (!game_name) {
      return res.status(400).json({ success: false, message: 'Missing game_name' })
    }

    if (!whitelist.isAllowed(game_name)) {
      return res.json({ success: false, message: `${game_name} 不在白名单中` })
    }

    whitelist.remove(game_name)
    res.json({ success: true, message: `已移除白名单: ${game_name}` })
  })

  router.get('/whitelist/list', (_req: Request, res: Response) => {
    const list = whitelist.list()
    res.json({ success: true, whitelist: list, count: whitelist.count() })
  })

  router.get('/whitelist/check/:game_name', (req: Request, res: Response) => {
    const { game_name } = req.params
    const allowed = whitelist.isAllowed(game_name)
    const info = whitelist.get(game_name)
    res.json({ success: true, allowed, info })
  })

  return router
}
