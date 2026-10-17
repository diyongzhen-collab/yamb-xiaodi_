/**
 * AI 工具注册表类型：工具定义、执行上下文与通用辅助。
 * 每个工具 = 一个 ToolDefinition（名称/描述/参数 Schema/权限/锁定豁免/实现），
 * 由 registry 统一分发：加工具只需新增一个对象，分发与权限边界自动生效。
 */
import type { ServiceResult } from '../../../types'
import type MinecraftBot from '../../../platform/minecraft-bot'
import type TeleportService from '../../teleport/service'
import type InventoryActions from '../../../actions/inventory'
import type GameApiService from '../../../api/game-service'
import type Whitelist from '../../../permissions/whitelist'
import type AdminStore from '../../../permissions/admin-store'
import type ScheduledCommandService from '../../scheduler/service'
import type ClickService from '../../clicks/service'

export interface ToolArguments {
  [key: string]: unknown
}

export interface ToolExecutionResult {
  success: boolean
  message: string
  data?: unknown
}

export interface InteractionActions {
  morph (username: string, target: string): Promise<ServiceResult>
  mount (username: string, target: string): Promise<ServiceResult>
  cart (): Promise<ServiceResult>
}

/** 工具执行上下文：由 AiToolService 构造，持有全部服务引用与参数读取。 */
export interface ToolContext {
  clicks?: ClickService
  interactions?: InteractionActions
  /** 发起调用的玩家（游戏名）。 */
  username: string
  args: ToolArguments
  mcBot: MinecraftBot
  teleportService: TeleportService
  inventoryActions: InventoryActions
  gameApiService: GameApiService
  whitelist: Whitelist
  adminStore: AdminStore
  scheduler: ScheduledCommandService
  blockedSlashCommands: string[]
  /** 读取字符串参数；缺失或空串返回 null。 */
  string (name: string): string | null
  /** 读取整数参数；缺失或非整数返回 null。 */
  integer (name: string): number | null
}

export interface ToolDefinition {
  name: string
  description: string
  /** OpenAI function parameters（JSON Schema）。 */
  parameters: Record<string, unknown>
  /** 权限：admin = 仅管理员可调；whitelist = 白名单可调。 */
  permission: 'admin' | 'whitelist'
  /** 锁定期间是否可用。 */
  lockedAllowed: boolean
  handler: (ctx: ToolContext) => ToolExecutionResult | Promise<ToolExecutionResult>
}

/** ServiceResult -> 工具执行结果。 */
export function toToolResult (result: ServiceResult): ToolExecutionResult {
  return { success: result.success, message: result.message || (result.success ? '操作完成' : '操作失败') }
}

/** 解析模型返回的工具参数 JSON；解析失败或非对象返回空对象。 */
export function parseToolArguments (raw: string): ToolArguments {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ToolArguments
      : {}
  } catch {
    return {}
  }
}
