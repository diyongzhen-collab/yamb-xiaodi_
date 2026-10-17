/** AstrBot 到 bot AI 的转发接口：QQ 身份在插件校验，游戏执行身份固定由服务端配置。 */
import { Router, Request, Response } from 'express'
import type AiToolService from '../../features/ai/tool-service'

const CLEAR_MEMORY_COMMANDS = new Set(['clear', 'reset', '清空记忆', '重置记忆', '忘记上下文'])
const MAX_INSTRUCTION_LENGTH = 2_000
const MAX_CONCURRENT_REQUESTS = 2

export default function createAiRoutes (aiToolService: AiToolService, actor: string): Router {
  const router = Router()
  let activeRequestCount = 0
  const activeConversations = new Set<string>()

  router.post('/ai', async (req: Request, res: Response) => {
    const { instruction, conversation_id: conversationId } = req.body as {
      instruction?: unknown
      conversation_id?: unknown
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ success: false, message: 'Missing instruction' })
    }
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 120) {
      return res.status(400).json({ success: false, message: 'Invalid conversation_id' })
    }

    const normalizedInstruction = instruction.trim()
    const normalizedConversationId = conversationId.trim()
    if (normalizedInstruction.length > MAX_INSTRUCTION_LENGTH) {
      return res.status(413).json({ success: false, message: `Instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters` })
    }
    if (CLEAR_MEMORY_COMMANDS.has(normalizedInstruction.toLowerCase())) {
      aiToolService.clearConversation(normalizedConversationId)
      return res.json({ success: true, message: '已清空本次 QQ 对话的 AI 记忆' })
    }

    if (activeConversations.has(normalizedConversationId)) {
      console.warn(`[AstrBot:AI] ${normalizedConversationId} rejected: conversation already running`)
      return res.status(409).json({ success: false, message: '该对话已有 AI 请求正在处理' })
    }
    if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
      console.warn(`[AstrBot:AI] ${normalizedConversationId} rejected: concurrent request limit reached`)
      return res.status(429).json({ success: false, message: 'AI 请求过多，请稍后再试' })
    }

    activeRequestCount++
    activeConversations.add(normalizedConversationId)
    console.log(`[AstrBot:AI] ${normalizedConversationId} -> ${normalizedInstruction}`)
    try {
      const result = await aiToolService.run(actor, normalizedInstruction, normalizedConversationId)
      console.log(`[AstrBot:AI] ${normalizedConversationId} <- ${result.success ? 'success' : 'failed'}: ${result.message}`)
      res.json(result)
    } finally {
      activeRequestCount--
      activeConversations.delete(normalizedConversationId)
    }
  })

  return router
}
