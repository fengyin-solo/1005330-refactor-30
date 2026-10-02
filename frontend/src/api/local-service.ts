import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  TOOL_ACTION_TARGETS,
  isToolTerminal,
  judgeToolCloseout,
  judgeToolFlow,
  readRequisitionNo,
  safetySyncCodeForTool,
} from '@/data/tool-rules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = key === 'tool' ? TOOL_ACTION_TARGETS[action] : meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (key === 'tool') {
    // 工具领用只走顺次推进的硬流转；归还、报损两个入口共用同一份办结判定。
    const flow = judgeToolFlow(current, target)
    if (!flow.ok) {
      return flow
    }
    if (target === '已归还' || target === '已报损') {
      const verdict = judgeToolCloseout(rows, rows[index], target)
      if (!verdict.ok) {
        return verdict
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: key === 'tool' ? !isToolTerminal(target) : target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === 'tool' && target === '已归还') {
    syncToolReturnToSafety(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 归还办结后把结论同步到安全巡查清单；同一张领用单重复同步只更新不新增。
function syncToolReturnToSafety(toolRow: EntryRow): void {
  const safetyRows = [...listRows('safety')]
  const syncCode = safetySyncCodeForTool(toolRow.id)
  const requisitionNo = readRequisitionNo(toolRow)
  const payload: EntryRow = {
    id: 0,
    status: '已整改',
    pending: false,
    abnormal: false,
    巡查编号: syncCode,
    巡查区域: '工具归还核查',
    巡查类别: '工具领用归还',
    隐患描述: `领用单号 ${requisitionNo} 已归还办结，核对规格型号与领用数量一致`,
    整改措施: '归还办结自动同步，无需整改',
    巡查人: String(toolRow['领用人'] ?? ''),
    巡查日期: String(toolRow['归还日期'] ?? ''),
    巡查状态: '已整改',
  }
  const index = safetyRows.findIndex((row) => String(row['巡查编号']) === syncCode)
  if (index >= 0) {
    safetyRows[index] = { ...payload, id: safetyRows[index].id }
  } else {
    const nextId = safetyRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    safetyRows.push({ ...payload, id: nextId })
  }
  saveRows('safety', safetyRows)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
