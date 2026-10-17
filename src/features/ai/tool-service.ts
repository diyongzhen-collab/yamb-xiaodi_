/**
 * OpenAI 兼容工具调用层：对话记忆、工具调用编排与 AI 权限边界。
 * 工具定义与实现见 ./tools/（注册表模式：query-tools / action-tools / admin-tools），
 * 本文件只负责与模型对话和按注册表分发，加工具无需改这里。
 */
import OpenAI from 'openai'
import type { AiConfig, ServiceResult } from '../../types'
import type MinecraftBot from '../../platform/minecraft-bot'
import type TeleportService from '../teleport/service'
import type InventoryActions from '../../actions/inventory'
import type GameApiService from '../../api/game-service'
import type Whitelist from '../../permissions/whitelist'
import type AdminStore from '../../permissions/admin-store'
import type ScheduledCommandService from '../scheduler/service'
import { buildToolDefinitions, executeToolByName, getToolDefinition } from './tools/registry'
import { parseToolArguments, type ToolContext, type ToolExecutionResult, type InteractionActions } from './tools/types'
import { SYSTEM_PROMPT } from './prompt'
import type ClickService from '../clicks/service'

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
interface CompletionMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

const MAX_CONVERSATIONS = 50

export default class AiToolService {
  private interactions?: InteractionActions
  setInteractionActions (actions: InteractionActions): void { this.interactions = actions }
  private clicks?: ClickService
  setClickService (clicks: ClickService): void { this.clicks = clicks }
  private client?: OpenAI
  private config: AiConfig
  private mcBot: MinecraftBot
  private teleportService: TeleportService
  private inventoryActions: InventoryActions
  private gameApiService: GameApiService
  private whitelist: Whitelist
  private adminStore: AdminStore
  private scheduler: ScheduledCommandService
  // 仅保存在进程内的短期记忆；机器人重启后不会恢复，避免数据库持续保存对话内容。
  private conversations = new Map<string, ChatMessage[]>()

  constructor (
    config: AiConfig,
    mcBot: MinecraftBot,
    teleportService: TeleportService,
    inventoryActions: InventoryActions,
    gameApiService: GameApiService,
    whitelist: Whitelist,
    adminStore: AdminStore,
    scheduler: ScheduledCommandService
  ) {
    this.config = config
    this.mcBot = mcBot
    this.teleportService = teleportService
    this.inventoryActions = inventoryActions
    this.gameApiService = gameApiService
    this.whitelist = whitelist
    this.adminStore = adminStore
    this.scheduler = scheduler
  }

  async run (username: string, instruction: string, conversationId = username): Promise<ServiceResult> {
    if (!this.config.enabled) {
      return { success: false, message: 'AI 功能未启用' }
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      ...this.getConversation(conversationId),
      { role: 'user', content: instruction }
    ]

    try {
      // 空泛回复/未调工具的重试次数；空泛回复可提醒两次，普通未调工具提醒一次。
      let nudges = 0
      for (let round = 0; round < this.config.maxToolRounds; round++) {
        const message = await this.requestCompletion(messages)
        const toolCalls = message.tool_calls ?? []

        if (toolCalls.length === 0) {
          const reply = message.content?.trim() || ''
          // 上下文里已有工具返回结果时，模型正在收尾报告结果，属于正常回答，
          // 不再按“没调工具”处理，避免把“已加好/已移除”这类正常回复误判为空泛回复反复重试。
          const hasToolResultInContext = messages.some(m => m.role === 'tool')
          // 工具可能已经执行，不能因总结为空重试整套操作。
          if (!reply && hasToolResultInContext) {
            return { success: false, message: 'AI 未返回结果说明；本次已调用工具，请查询实际状态，勿直接重复操作。' }
          }
          // 涉及状态/操作的请求却没调用任何工具：提醒一次再试，防止模型直接凭记忆回答。
          const bland = !reply || this.isBlandReply(reply)
          const maxBlandNudges = 2
          const shouldNudge = !hasToolResultInContext && (bland
            ? nudges < maxBlandNudges
            : nudges === 0 && this.looksLikeBotRequest(instruction))
          if (shouldNudge) {
            nudges++
            messages.push({ role: 'assistant', content: message.content })
            messages.push({
              role: 'user',
              content: '请按请求类型给出具体答复：实时查询和可执行操作应调用对应工具；概念或用法问题直接解释；缺少参数时澄清；没有对应工具或权限时说明限制。未调用工具时不得声称已经执行或获得实时结果。'
            })
            continue
          }
          if (bland) {
            return { success: false, message: 'AI 未返回有效答复，无法确认请求结果。' }
          }
          // 空泛顺从回复不进对话记忆，避免模型后续继续学样。
          if (!bland) {
            this.rememberConversation(conversationId, instruction, reply)
          }
          return { success: true, message: reply }
        }

        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: toolCalls
        })

        for (const toolCall of toolCalls) {
          const result = await this.executeTool(username, toolCall)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          })
        }
      }

      return { success: false, message: `AI 工具调用超过 ${this.config.maxToolRounds} 轮限制` }
    } catch (err) {
      console.error('[AI] Tool call failed:', (err as Error).message)
      return { success: false, message: `AI 调用失败: ${(err as Error).message}` }
    }
  }

  clearConversation (username: string): void {
    this.conversations.delete(username)
  }

  isUnlockRequest (instruction: string): boolean {
    return ['unlock', '解锁', '解除锁定', '取消锁定'].includes(instruction.trim().toLowerCase())
  }

  /** 粗略判断指令是否涉及机器人状态/操作（用于“没调工具却直接回答”时提醒重试）。 */
  private looksLikeBotRequest (instruction: string): boolean {
    const text = instruction.trim().toLowerCase()
    // 分句识别，避免“介绍工具，然后查背包”被整体当成能力介绍。
    const clauses = text.split(/[，,。！？!?；;\n]|然后|并且/).filter(Boolean)
    if (clauses.length > 1) return clauses.some(clause => this.looksLikeBotRequest(clause))
    // 纯解释/概念性问题（问区别、含义、原因等）不需要工具；
    // 除非同时包含明确的执行动作（加/删/执行/传送/锁定等），否则不算“操作请求”。
    // 询问 AI 能力/工具清单（“你能做什么”“有哪些工具”）不属于状态查询或操作请求，不需要调用工具。
    const capabilityWords = ['工具清单', '工具列表', '有哪些工具', '有哪些可调用工具', '可调用工具清单', '查看ai可调用工具', '能做什么', '能干啥', '有啥功能', '什么功能']
    if (capabilityWords.some(word => text.includes(word))) {
      return false
    }
    const explanationWords = [
      '是什么', '什么意思', '啥意思', '有什么区别', '区别', '解释', '介绍', '讲讲',
      '含义', '意思', '怎么用', '如何使用'
    ]
    if (explanationWords.some(word => text.includes(word)) &&
        !/(现在|当前|实时|帮我|给我|请先|请把)/.test(text)) {
      return false
    }
    const queryWords = [
      '坐标', '位置', '在哪', '哪里', '血量', '血', '生命', '饥饿', '饿', '氧气', '等级', '经验',
      '几点', '时间', '背包', '物品', '白名单', '定时', '任务',
      '锁定', '解锁', '在线', '玩家', '小镇', '朝向', '方向', '月相', '雷暴', '下雨',
      '谁锁', '谁在', '看看', '查看', '查'
    ]
    const actionWords = [
      '下来', '回家', '回程', '过去', '传送', 'tp', '攻击', '右键', '发送', '发言',
      '存入', '取出', '丢弃', '移除', '执行', '开始', '停止', '关闭', '开启', '帮',
      '去', '打', '存', '取', '发', '锁', '解'
    ]
    return queryWords.some(word => text.includes(word)) ||
      actionWords.some(word => text.includes(word))
  }

  /** 判断回复是否为“你说得对/好的/明白”这类空泛应承话。 */
  private isBlandReply (reply: string): boolean {
    const text = reply.trim().toLowerCase()
    if (!text || text.length > 20) return false
    return /^(你说得?对|你说?的?对|好的?|明白|嗯+[嗯]*|哦|噢|ok|okay|可以|行|收到|知道[了]?|了解)[!！。，,~～.…\s]*$/.test(text)
  }

  private getConversation (username: string): ChatMessage[] {
    return this.conversations.get(username) ?? []
  }

  private rememberConversation (username: string, instruction: string, reply: string): void {
    if (this.config.memoryTurns <= 0) return
    const existing = this.getConversation(username)
    const updated: ChatMessage[] = [
      ...existing,
      { role: 'user', content: instruction },
      { role: 'assistant', content: reply }
    ]
    // 限制会话总数，避免 QQ 转发等来源创建无限多个会话导致内存增长。
    if (this.conversations.size >= MAX_CONVERSATIONS) {
      const oldestKey = this.conversations.keys().next().value
      if (oldestKey !== undefined) this.conversations.delete(oldestKey)
    }
    this.conversations.set(username, updated.slice(-this.config.memoryTurns * 2))
  }

  private async requestCompletion (messages: ChatMessage[]): Promise<CompletionMessage> {
    // 延迟创建，AI 关闭时不要求密钥；明确使用项目配置，避免回退到 SDK 环境变量。
    if (!this.config.apiKey || !this.config.baseUrl || !this.config.model) {
      throw new Error('AI_BASE_URL、AI_API_KEY 和 AI_MODEL 配置不完整')
    }
    this.client ??= new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      timeout: 30_000,
      maxRetries: 0
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      // 兼容扩展字段仅按配置发送；官方端点应关闭 AI_CACHE_PROMPT。
      const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { cache_prompt?: boolean } = {
        model: this.config.model,
        messages,
        tools: buildToolDefinitions(),
        tool_choice: 'auto',
        temperature: 0.2,
        stream: false,
        ...(this.config.cachePrompt !== false ? { cache_prompt: true } : {})
      }
      const payload = await this.client.chat.completions.create(request, { signal: controller.signal })
      if (payload.usage) {
        const u = payload.usage as OpenAI.CompletionUsage & {
          cached_tokens?: number
          prompt_cache_hit_tokens?: number
          credit?: number
        }
        // 兼容三种返回格式：OpenAI 嵌套 prompt_tokens_details.cached_tokens、
        // 部分中转顶层 cached_tokens、DeepSeek 官方 prompt_cache_hit_tokens。
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
        const prompt = u.prompt_tokens ?? 0
        const hitPercent = prompt > 0 ? Math.round((cached / prompt) * 100) : 0
        const num = (v: number | undefined): string => (v == null ? '-' : String(v))
        console.log(
          '[AI] 用量：缓存 ' + cached + '（命中 ' + hitPercent + '%）' +
          ' / 提示词 ' + num(prompt) +
          ' / 输出 ' + num(u.completion_tokens) +
          ' / 总计 ' + num(u.total_tokens) +
          ' / 费用 ' + num(u.credit)
        )
      }
      const message = payload.choices?.[0]?.message
      if (!message || message.role !== 'assistant' ||
          (message.content != null && typeof message.content !== 'string')) {
        throw new Error('AI API 返回了无效的回答格式')
      }
      const calls = message.tool_calls
      if (calls != null && !Array.isArray(calls)) throw new Error('AI API 返回了无效的工具调用格式')
      const ids = new Set<string>()
      const toolCalls: ToolCall[] = []
      for (const call of calls ?? []) {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
            !call.function || typeof call.function.name !== 'string' || !call.function.name ||
            typeof call.function.arguments !== 'string') {
          throw new Error('AI API 返回了无效或重复的工具调用')
        }
        ids.add(call.id)
        toolCalls.push(call)
      }
      return { role: 'assistant', content: message.content ?? null, tool_calls: toolCalls }
    } catch (err) {
      if (controller.signal.aborted || err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new Error('AI 请求超时（30 秒），请稍后查询实际状态')
      }
      if (err instanceof OpenAI.APIConnectionError) throw new Error('无法连接 AI 服务，请检查接口地址和网络')
      if (err instanceof OpenAI.APIError) {
        throw new Error('AI API 请求失败（HTTP ' + (err.status ?? '未知') + '）')
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 按注册表执行工具：锁定检查与管理员权限检查均取自工具定义字段，
   * 分发由 registry 完成，未注册工具直接拒绝。
   */
  private async executeTool (username: string, toolCall: ToolCall): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name
    const tool = getToolDefinition(toolName)
    if (!tool) return { success: false, message: `未允许的工具: ${toolName}` }

    const args = parseToolArguments(toolCall.function.arguments)
    if (this.teleportService.isLocked() && !tool.lockedAllowed) {
      return { success: false, message: 'bot 已锁定，该工具当前不可用' }
    }
    if (tool.permission === 'admin' && !this.adminStore.isAdmin(username)) {
      return { success: false, message: '该工具需要管理员权限' }
    }

    const ctx: ToolContext = {
      username,
      args,
      clicks: this.clicks,
      interactions: this.interactions,
      mcBot: this.mcBot,
      teleportService: this.teleportService,
      inventoryActions: this.inventoryActions,
      gameApiService: this.gameApiService,
      whitelist: this.whitelist,
      adminStore: this.adminStore,
      scheduler: this.scheduler,
      blockedSlashCommands: this.config.blockedSlashCommands,
      string: (name) => {
        const value = args[name]
        return typeof value === 'string' && value.trim() ? value.trim() : null
      },
      integer: (name) => {
        const value = args[name]
        return typeof value === 'number' && Number.isInteger(value) ? value : null
      }
    }

    const result = executeToolByName(toolName, ctx)
    return await result ?? { success: false, message: `未允许的工具: ${toolName}` }
  }
}
