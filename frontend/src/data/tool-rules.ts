import type { EntryRow } from './types'

// 工具领用的状态只能顺次推进：待领用 → 使用中 → 已归还 → 已报损，不允许倒着回。
export const TOOL_STATUSES = ['待领用', '使用中', '已归还', '已报损'] as const

export const TOOL_ACTION_TARGETS: Record<string, (typeof TOOL_STATUSES)[number]> = {
  确认领用: '使用中',
  登记归还: '已归还',
  登记报损: '已报损',
}

export type ToolVerdict = { ok: true } | { ok: false; message: string }

const TOOL_TERMINAL = TOOL_STATUSES[TOOL_STATUSES.length - 1]

// 列表页与详情面板共用同一份领用单号读法，两处展示必须一致。
export function readRequisitionNo(row: EntryRow): string {
  return String(row['领用单号'] ?? '').trim()
}

// 归还办结同步到安全巡查清单时使用的巡查编号，同步与查询都按这个编号对。
export function safetySyncCodeForTool(toolId: number | string): string {
  return `SAFE-TOOL-${toolId}`
}

export function isToolTerminal(status: string): boolean {
  return status === TOOL_TERMINAL
}

// 当前状态允许顺次推进到的下一状态；已是终态时返回 null。
export function nextToolStatus(current: string): string | null {
  const index = TOOL_STATUSES.findIndex((status) => status === current)
  if (index < 0 || index >= TOOL_STATUSES.length - 1) {
    return null
  }
  return TOOL_STATUSES[index + 1]
}

// 流转门槛：只能往后顺次走一格，已归还不能倒回使用中，也不能跳级。
export function judgeToolFlow(current: string, target: string): ToolVerdict {
  if (current === target) {
    return { ok: false, message: `领用单已经是「${target}」，不用重复操作` }
  }
  const expected = nextToolStatus(current)
  if (expected === null) {
    return { ok: false, message: `领用单已到终态「${current}」，不能再推进或回退` }
  }
  if (expected !== target) {
    return {
      ok: false,
      message: `领用单当前为「${current}」，只能顺次推进到「${expected}」，不能改成「${target}」`,
    }
  }
  return { ok: true }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseDate(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!DATE_PATTERN.test(text)) {
    return null
  }
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return text
}

// 归还、报损两个入口共用的办结判定口径，只此一份，不允许各写一套。
// 判定所需的字段一律以领用单原单（row）为准，入口侧不另传覆盖值，冲突时按原单下结论。
export function judgeToolCloseout(rows: EntryRow[], row: EntryRow, target: string): ToolVerdict {
  const targetIndex = TOOL_STATUSES.findIndex((status) => status === target)
  if (targetIndex < 0) {
    return { ok: false, message: `「${target}」不是工具领用的办结状态` }
  }

  // 口径一：领用单号在原单上必须存在；同一单号在本环节及之后已有结论的，不得再次办结。
  const requisitionNo = readRequisitionNo(row)
  if (!requisitionNo) {
    return { ok: false, message: '领用单原单缺少领用单号，无法核对办结' }
  }
  const alreadyClosed = rows.some((candidate) => {
    if (Number(candidate.id) === Number(row.id) || readRequisitionNo(candidate) !== requisitionNo) {
      return false
    }
    const candidateIndex = TOOL_STATUSES.findIndex((status) => status === String(candidate.status))
    return candidateIndex >= targetIndex
  })
  if (alreadyClosed) {
    return target === '已报损'
      ? { ok: false, message: `领用单号 ${requisitionNo} 已报损过，不能重复报损` }
      : { ok: false, message: `领用单号 ${requisitionNo} 已归还过，不能重复归还` }
  }

  // 口径二：规格型号与领用数量按领用单原单核对，对不上原单不予办结。
  const spec = String(row['规格型号'] ?? '').trim()
  const quantity = Number(row['领用数量'])
  if (!spec || !Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      message: `规格型号或领用数量与领用单原单不符（原单号 ${requisitionNo}），按原单核对后再办结`,
    }
  }

  // 口径三：归还日期不得早于领用日期；归还、报损两个入口都按这一条判定。
  const issueDate = parseDate(row['领用日期'])
  if (!issueDate) {
    return { ok: false, message: `领用单原单的领用日期缺失或不正确（原单号 ${requisitionNo}）` }
  }
  const returnDate = parseDate(row['归还日期'])
  if (!returnDate) {
    return { ok: false, message: '归还日期缺失，不能办结归还或报损' }
  }
  if (returnDate < issueDate) {
    return { ok: false, message: `归还日期 ${returnDate} 早于领用日期 ${issueDate}，不能办结` }
  }

  return { ok: true }
}
