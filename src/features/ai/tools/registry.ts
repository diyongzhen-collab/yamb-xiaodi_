/**
 * AI 工具注册表：汇总全部工具定义并提供统一分发。
 * - 加工具 = 在对应域的 tools 文件中新增一个 ToolDefinition 对象；
 * - 分发、权限、锁定豁免由本模块自动生效，无需改 switch。
 */
import type { ToolDefinition, ToolExecutionResult, ToolContext } from './types'
import { QUERY_TOOLS } from './query-tools'
import { ACTION_TOOLS } from './action-tools'
import { ADMIN_TOOLS } from './admin-tools'
import { CLICK_TOOLS } from './click-tools'
import { INTERACTION_TOOLS } from './interaction-tools'

/** 全部工具（顺序即 OpenAI 展示顺序：查询 → 操作 → 管理）。 */
export const TOOLS: ToolDefinition[] = [...QUERY_TOOLS, ...ACTION_TOOLS, ...ADMIN_TOOLS, ...CLICK_TOOLS, ...INTERACTION_TOOLS]

const TOOL_MAP = new Map<string, ToolDefinition>(TOOLS.map(tool => [tool.name, tool]))

/** 转换为 OpenAI function 定义列表（请求时随消息发送给模型）。 */
export function buildToolDefinitions (): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return TOOLS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

/** 按名称执行工具；未注册的工具返回 null（由调用方报"未允许的工具"）。 */
export function executeToolByName (
  name: string,
  ctx: ToolContext
): ToolExecutionResult | Promise<ToolExecutionResult> | null {
  const tool = TOOL_MAP.get(name)
  if (!tool) return null
  return tool.handler(ctx)
}

/** 查询工具定义（权限/锁定豁免），供 AiToolService 做边界检查。 */
export function getToolDefinition (name: string): ToolDefinition | undefined {
  return TOOL_MAP.get(name)
}
