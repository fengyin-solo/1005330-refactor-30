<template>
  <section class="page" data-module="tool">
    <header class="page-head">
      <div>
        <h2>工具领用管理</h2>
        <p class="page-desc">维护工具领用单，围绕领用单号、领用人、工具名称、规格型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记工具领用单</button>
        <button class="btn" type="button" @click="exportRows">导出工具领用清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="table-layout">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">
              <!-- 领用单号与详情面板读同一个口径，保证两处一致 -->
              <button v-if="column === '领用单号'" class="link" type="button" @click="openDetail(row)">
                {{ entryNo(row) }}
              </button>
              <template v-else>{{ row[column] ?? '—' }}</template>
            </td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <button class="link" type="button" @click="openDetail(row)">详情</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无工具领用数据，可先登记工具领用单</td>
          </tr>
        </tbody>
      </table>

      <aside v-if="selected" class="detail-panel">
        <header class="detail-head">
          <div>
            <span class="detail-caption">工具领用单详情</span>
            <strong class="detail-no">{{ entryNo(selected) }}</strong>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd :class="{ 'detail-key': column === '领用单号' }">{{ selected[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ selected.status }}</dd>
        </dl>

        <!-- 归还、报损两个入口：面板里填报后同样走共用判定 -->
        <fieldset class="detail-form">
          <legend>办结填报（归还 / 报损）</legend>
          <label class="detail-field">
            <span>办结日期</span>
            <input v-model="closingDate" placeholder="YYYY-MM-DD" />
          </label>
          <label class="detail-field">
            <span>规格型号</span>
            <input v-model="closingSpec" placeholder="与领用单原单核对" />
          </label>
          <label class="detail-field">
            <span>领用数量</span>
            <input v-model.number="closingQty" type="number" min="0" placeholder="与领用单原单核对" />
          </label>
          <div class="detail-actions">
            <button
              v-for="action in closingActions"
              :key="action"
              class="btn"
              :class="{ primary: action === '登记归还' }"
              type="button"
              @click="runClosing(action)"
            >
              {{ action }}
            </button>
          </div>
        </fieldset>

        <div class="detail-flow">
          <span v-for="item in statusSummary" :key="item.status" class="flow-item">
            {{ item.status }}
          </span>
        </div>
      </aside>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条工具领用记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  TOOL_FIELD_QTY,
  TOOL_FIELD_SPEC,
  toolEntryNo,
} from '@/data/tool-flow'

const meta = moduleMeta('tool')
const columns = ["领用单号", "领用人", "工具名称", "规格型号", "领用数量", "领用日期", "归还日期", "领用状态"]
const actions = ["确认领用", "登记归还", "登记报损"]
const closingActions = ["登记归还", "登记报损"]
const statuses = ["待领用", "使用中", "已归还", "已报损"]
const stats = [{"label": "使用中工具", "value": 0}, {"label": "逾期未还工具", "value": 0}, {"label": "本月报损数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 领用单号的唯一读法：列表单元格与详情面板都用它。
const entryNo = toolEntryNo

const selectedId = ref<number | null>(null)
const selected = computed<EntryRow | null>(
  () => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

const closingDate = ref('')
const closingSpec = ref('')
const closingQty = ref<number | null>(null)

watch(selected, (row) => {
  // 面板填报默认带出原单口径，冲突时后端仍以领用单原单为准。
  closingDate.value = ''
  closingSpec.value = row ? String(row[TOOL_FIELD_SPEC] ?? '') : ''
  closingQty.value = row ? Number(row[TOOL_FIELD_QTY] ?? 0) : null
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '工具领用单登记入口尚未接入审批流'
  okMessage.value = ''
}

function openDetail(row: EntryRow) {
  selectedId.value = Number(row.id)
  errorMessage.value = ''
  okMessage.value = ''
}

function closeDetail() {
  selectedId.value = null
}

// 列表入口：不带填报值，仍走同一份共用判定。
function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

// 详情面板入口：归还、报损填报后走同一份共用判定。
function runClosing(action: string) {
  if (!selected.value) {
    return
  }
  errorMessage.value = ''
  okMessage.value = ''
  const payload = {
    办结日期: closingDate.value.trim(),
    [TOOL_FIELD_SPEC]: closingSpec.value.trim(),
    [TOOL_FIELD_QTY]:
      closingQty.value === null || Number.isNaN(closingQty.value)
        ? undefined
        : Number(closingQty.value),
  }
  const result = applyAction(meta.key, Number(selected.value.id), action, payload)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selectedId.value !== null && !rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工具领用列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.table-layout { display: flex; gap: 12px; align-items: flex-start; }
.table-layout .data-table { flex: 1; }
.detail-panel {
  width: 320px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  position: sticky;
  top: 12px;
}
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.detail-caption { display: block; font-size: 12px; color: var(--muted); }
.detail-no { font-size: 15px; }
.detail-grid { display: grid; grid-template-columns: 88px 1fr; gap: 4px 8px; margin: 0 0 10px; }
.detail-grid dt { color: var(--muted); font-size: 12px; }
.detail-grid dd { margin: 0; font-size: 13px; word-break: break-all; }
.detail-key { font-weight: 600; }
.detail-form { border: 1px dashed var(--border); border-radius: 6px; padding: 8px 10px; margin: 0 0 10px; }
.detail-form legend { font-size: 12px; color: var(--muted); padding: 0 4px; }
.detail-field { display: block; margin-bottom: 6px; }
.detail-field span { display: block; font-size: 12px; color: var(--muted); }
.detail-field input { width: 100%; }
.detail-actions { display: flex; gap: 8px; margin-top: 4px; }
.detail-flow { display: flex; flex-wrap: wrap; gap: 6px; }
.flow-item { font-size: 12px; background: #eef2f7; border-radius: 999px; padding: 2px 10px; }
.ok-text { color: #067647; }
</style>
