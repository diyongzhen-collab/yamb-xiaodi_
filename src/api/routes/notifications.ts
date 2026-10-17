/** 运行事件通知接口：AstrBot 插件轮询拉取掉线/重连等未读通知。 */
import { Router, Request, Response } from 'express'
import type NotificationService from '../../platform/notification'

export default function createNotificationRoutes (notifications: NotificationService): Router {
  const router = Router()

  /** 一次性取走全部未读通知（AstrBot 插件为唯一消费者）。 */
  router.get('/notices', (_req: Request, res: Response) => {
    res.json({ success: true, notices: notifications.drain() })
  })

  return router
}
