import { MODULE_BY_KEY } from './modules'
import type { EntryRow, ModuleMeta } from './types'

// 工具领用的流转口径集中在这里：归还、报损两个入口都走同一份判定，
// 不再各写一套，避免两边慢慢走样。

export const TOOL_KEY = 'tool'
export const SAFETY_KEY = 'safety'

export const TOOL_FIELD_NO = '领用单号'
export const TOOL_FIELD_SPEC = '规格型号'
export const TOOL_FIELD_QTY = '领用数量'
export const TOOL_FIELD_REQ_DATE = '领用日期'
export const TOOL_FIELD_RETURN_DATE = '归还日期'
export const TOOL_FIELD_NAME = '工具名称'
export const TOOL_FIELD_HOLDER = '领用人'

export const TOOL_ACTION_CONFIRM = '确认领用'
export const TOOL_ACTION_RETURN = '登记归还'
export const TOOL_ACTION_LOSS = '登记报损'

// 办结类入口：共用同一套判定。
export const TOOL_CLOSING_ACTIONS: ReadonlySet<string> = new Set([
  TOOL_ACTION_RETURN,
  TOOL_ACTION_LOSS,
])

const TOOL_META: ModuleMeta = MODULE_BY_KEY.get(TOOL_KEY) ?? (() => {
  throw new Error('工具领用模块元数据缺失')
})()

// 领用这一步只能顺次推进：待领用 → 使用中 → 已归还 → 已报损。
export const TOOL_STATUSES: readonly string[] = TOOL_META.statuses

// 办结入口随表单提交的填报值；列表入口不带填报值，只做单号、状态与日期的判定。
export type ToolActionPayload = {
  [TOOL_FIELD_SPEC]?: string
  [TOOL_FIELD_QTY]?: number
  办结日期?: string
}

export type ToolEvaluation = {
  ok: boolean
  message: string
  warnings: string[]
  target: string | null
  // 需要写回原单的修正：归还日期回填、填报值冲突时以原单为准。
  patch: Partial<EntryRow>
}

// 列表页与详情面板读领用单号都走这里，保证两处看到的编号一致。
export function toolEntryNo(row: EntryRow | null | undefined): string {
  const value = row?.[TOOL_FIELD_NO]
  return value === undefined || value === null ? '' : String(value)
}

export function toolStatusIndex(status: string): number {
  return TOOL_STATUSES.indexOf(status)
}

// 顺次推进时，当前状态的下一个状态；已到终点返回 null。
export function nextToolStatus(current: string): string | null {
  const index = toolStatusIndex(current)
  if (index < 0 || index >= TOOL_STATUSES.length - 1) {
    return null
  }
  return TOOL_STATUSES[index + 1]
}

function isClosingAction(action: string): boolean {
  return TOOL_CLOSING_ACTIONS.has(action)
}

function closingVerb(action: string): string {
  return action === TOOL_ACTION_RETURN ? '归还' : '报损'
}

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return Number.NaN
  }
  const [year, month, day] = value.trim().split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const valid =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  return valid ? date.getTime() : Number.NaN
}

function todayText(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 归还、报损共用的判定，两个入口都只调这一个函数：
 * 1. 状态只能顺次推进，不允许跳步，也不允许从已归还倒着回；
 * 2. 领用单号有没有归还/报损过（同一单号不得重复办结）；
 * 3. 填报的规格型号、领用数量要与领用单原单对得上，冲突时以原单为准；
 * 4. 归还/报损日期不得早于领用日期。
 */
export function evaluateToolAction(
  action: string,
  row: EntryRow,
  allToolRows: EntryRow[],
  payload?: ToolActionPayload,
): ToolEvaluation {
  const blocked: ToolEvaluation = { ok: false, message: '', warnings: [], target: null, patch: {} }
  const target = TOOL_META.actionTargets[action]
  if (!target) {
    return { ...blocked, message: `工具领用单没有登记「${action}」这个动作` }
  }

  const current = String(row.status)
  const currentIndex = toolStatusIndex(current)
  const targetIndex = toolStatusIndex(target)
  const no = toolEntryNo(row)

  // 已经办结过：同一单号同一结论不允许重复登记（本单自己也视为归还/报损过）。
  if (current === target) {
    if (action === TOOL_ACTION_RETURN) {
      return { ...blocked, message: `领用单号 ${no} 已归还过，不能重复登记归还` }
    }
    if (action === TOOL_ACTION_LOSS) {
      return { ...blocked, message: `领用单号 ${no} 已报损过，不能重复登记报损` }
    }
    return { ...blocked, message: `工具领用单已经是「${target}」，不用重复操作` }
  }

  // 顺次推进：只允许走到紧邻的下一状态。
  if (currentIndex < 0) {
    return { ...blocked, message: `工具领用单当前状态「${current}」无法识别，不能${action}` }
  }
  if (targetIndex < currentIndex) {
    return {
      ...blocked,
      message: `领用流程只能顺次推进，不允许从「${current}」回退到「${target}」`,
    }
  }
  if (targetIndex > currentIndex + 1) {
    const expected = TOOL_STATUSES[currentIndex + 1]
    return {
      ...blocked,
      message: `领用流程只能顺次推进，「${current}」需先办理到「${expected}」，不能直接${action}`,
    }
  }

  // 同一领用单号是否已办结过；判定冲突时以领用单原单（被操作记录）为准。
  const alreadyConcluded = allToolRows.some(
    (candidate) =>
      Number(candidate.id) !== Number(row.id) &&
      toolEntryNo(candidate) === no &&
      String(candidate.status) === target,
  )
  if (alreadyConcluded) {
    return {
      ...blocked,
      message:
        action === TOOL_ACTION_RETURN
          ? `领用单号 ${no} 已归还过，不能重复登记归还`
          : `领用单号 ${no} 已报损过，不能重复登记报损`,
    }
  }

  const warnings: string[] = []
  const patch: Partial<EntryRow> = {}

  // 规格型号、领用数量要与原单对得上；对不上不阻断办结，一律以原单口径为准。
  if (isClosingAction(action) && payload) {
    const submittedSpec = payload[TOOL_FIELD_SPEC]
    if (submittedSpec !== undefined) {
      const originalSpec = String(row[TOOL_FIELD_SPEC] ?? '')
      if (submittedSpec.trim() !== originalSpec) {
        warnings.push(`填报的规格型号与领用单原单不一致，已按原单「${originalSpec}」为准`)
        patch[TOOL_FIELD_SPEC] = originalSpec
      }
    }
    const submittedQty = payload[TOOL_FIELD_QTY]
    if (submittedQty !== undefined) {
      const originalQty = Number(row[TOOL_FIELD_QTY] ?? 0)
      if (Number(submittedQty) !== originalQty) {
        warnings.push(`填报的领用数量与领用单原单不一致，已按原单 ${originalQty} 为准`)
        patch[TOOL_FIELD_QTY] = originalQty
      }
    }
  }

  // 归还/报损日期不得早于领用日期。
  if (isClosingAction(action)) {
    const verb = closingVerb(action)
    const requisitionDate = String(row[TOOL_FIELD_REQ_DATE] ?? '').trim()
    const effectiveDate =
      payload?.办结日期?.trim() ||
      (action === TOOL_ACTION_RETURN ? String(row[TOOL_FIELD_RETURN_DATE] ?? '').trim() : '') ||
      todayText()
    if (Number.isNaN(parseDate(effectiveDate))) {
      return { ...blocked, message: `${verb}日期格式无效，应为 YYYY-MM-DD` }
    }
    const requisitionTime = parseDate(requisitionDate)
    if (!Number.isNaN(requisitionTime) && parseDate(effectiveDate) < requisitionTime) {
      return {
        ...blocked,
        message: `${verb}日期不能早于领用日期（领用日期 ${requisitionDate}）`,
      }
    }
    if (action === TOOL_ACTION_RETURN) {
      patch[TOOL_FIELD_RETURN_DATE] = effectiveDate
    }
  }

  let message = `工具领用单已${action}，当前状态「${target}」`
  if (warnings.length > 0) {
    message = `${message}；${warnings.join('；')}`
  }
  return { ok: true, message, warnings, target, patch }
}

export type SafetyConclusionFields = {
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type SafetyConclusion = {
  // 关联的领用单号，安全巡查清单按巡查编号做幂等同步。
  linkNo: string
  fields: SafetyConclusionFields
}

// 归还办结的结论：同步成一条安全巡查清单记录。
export function buildReturnConclusion(row: EntryRow, conclusionDate: string): SafetyConclusion {
  const no = toolEntryNo(row)
  return {
    linkNo: no,
    fields: {
      status: '已整改',
      pending: false,
      abnormal: false,
      巡查编号: `SAFE-${no}`,
      巡查区域: `工具领用单 ${no}`,
      巡查类别: '工具归还核对',
      隐患描述: `领用单 ${no} 的「${String(row[TOOL_FIELD_NAME] ?? '')}」已归还办结，按领用单原单核对无误`,
      整改措施: '按领用单原单核对规格型号与领用数量后收回入库',
      巡查人: String(row[TOOL_FIELD_HOLDER] ?? ''),
      巡查日期: conclusionDate,
      巡查状态: '已整改',
    },
  }
}
