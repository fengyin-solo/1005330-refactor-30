import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import {
  buildReturnConclusion,
  evaluateToolAction,
  SAFETY_KEY,
  TOOL_ACTION_RETURN,
  TOOL_FIELD_RETURN_DATE,
  TOOL_KEY,
  TOOL_STATUSES,
  type ToolActionPayload,
} from '@/data/tool-flow'

// 工具领用的两个办结入口（列表动作、详情面板）统一走这里，
// 判定口径只有 evaluateToolAction 一份。
export function runToolAction(
  id: number,
  action: string,
  payload?: ToolActionPayload,
): ActionResult {
  const rows = listRows(TOOL_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工具领用单` }
  }
  const current = rows[index]

  const evaluation = evaluateToolAction(action, current, rows, payload)
  if (!evaluation.ok || !evaluation.target) {
    return { ok: false, message: evaluation.message }
  }

  const target = evaluation.target
  const lastStatus = TOOL_STATUSES[TOOL_STATUSES.length - 1]
  const updated: EntryRow = {
    ...current,
    ...evaluation.patch,
    status: target,
    pending: target !== lastStatus,
    abnormal: false,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(TOOL_KEY, next)

  // 归还办结的结论同步到安全巡查清单，按巡查编号幂等更新。
  if (action === TOOL_ACTION_RETURN) {
    syncReturnConclusion(
      updated,
      String(evaluation.patch[TOOL_FIELD_RETURN_DATE] ?? updated[TOOL_FIELD_RETURN_DATE] ?? ''),
    )
  }

  return { ok: true, message: evaluation.message }
}

function nextSafetyId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function syncReturnConclusion(row: EntryRow, conclusionDate: string): void {
  const conclusion = buildReturnConclusion(row, conclusionDate)
  const rows = listRows(SAFETY_KEY)
  const index = rows.findIndex(
    (candidate) => String(candidate['巡查编号']) === conclusion.fields['巡查编号'],
  )
  if (index >= 0) {
    const next = [...rows]
    next[index] = { ...rows[index], ...conclusion.fields }
    saveRows(SAFETY_KEY, next)
    return
  }
  saveRows(SAFETY_KEY, [...rows, { id: nextSafetyId(rows), ...conclusion.fields }])
}
