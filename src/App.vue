<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { FUELS, statusLabel } from "./ledger/engine";
import type { AdjustOrder, OperationLog, OrderStatus } from "./ledger/types";
import { usePriceStore } from "./stores/priceStore";

const store = usePriceStore();

onMounted(() => store.init());

// ---------------------------------------------------------------------------
// 调价表单
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function blankForm() {
  return {
    fuel: FUELS[0],
    proposedPrice: store.latestPrice(FUELS[0]) ?? 0,
    operator: "",
    effectiveDate: today(),
    notes: "",
  };
}

const form = reactive(blankForm());

function onFuelChange(): void {
  form.proposedPrice = store.latestPrice(form.fuel) ?? 0;
}

const formDiff = computed(() => {
  const base = store.latestPrice(form.fuel);
  if (base === null) return null;
  return Math.round((form.proposedPrice - base) * 100) / 100;
});

const blockingHint = computed(() =>
  store.pendingOrders.find((order) => order.fuel === form.fuel) ?? null
);

async function submitForm() {
  if (!form.operator.trim()) {
    store.pushToast("warning", "请先填写操作员");
    return;
  }
  try {
    await store.submit({
      fuel: form.fuel,
      proposedPrice: Number(form.proposedPrice),
      operator: form.operator.trim(),
      effectiveDate: form.effectiveDate,
      notes: form.notes.trim(),
    });
    form.proposedPrice = store.latestPrice(form.fuel) ?? form.proposedPrice;
    form.notes = "";
  } catch {
    // 错误提示已在 store 中给出
  }
}

// ---------------------------------------------------------------------------
// 台账列表筛选
// ---------------------------------------------------------------------------

const fuelFilter = ref<"全部油品" | (typeof FUELS)[number]>("全部油品");
const statusFilter = ref<"全部状态" | OrderStatus>("全部状态");

const filteredOrders = computed<AdjustOrder[]>(() => {
  return (store.ledger?.orders ?? []).filter((order) => {
    if (fuelFilter.value !== "全部油品" && order.fuel !== fuelFilter.value) return false;
    if (statusFilter.value !== "全部状态" && order.status !== statusFilter.value) return false;
    return true;
  });
});

const statusOptions: Array<{ value: "全部状态" | OrderStatus; label: string }> = [
  { value: "全部状态", label: "全部状态" },
  { value: "pending", label: statusLabel("pending") },
  { value: "conflict_draft", label: statusLabel("conflict_draft") },
  { value: "effective", label: statusLabel("effective") },
  { value: "rolled_back", label: statusLabel("rolled_back") },
];

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function activate(order: AdjustOrder) {
  await store.activate(order.id);
}

async function rollback(order: AdjustOrder) {
  const reason = window.prompt(`回退「${order.fuel}」调价单，请填写原因：`, "复核未通过");
  if (reason === null) return;
  if (!reason.trim()) {
    store.pushToast("warning", "回退原因不能为空");
    return;
  }
  await store.rollback(order.id, reason.trim());
}

async function discard(order: AdjustOrder) {
  if (!window.confirm(`放弃「${order.fuel}」这张冲突草稿？放弃后可重新提交。`)) return;
  await store.discardDraft(order.id);
}

function copySummary(order: AdjustOrder) {
  const text = `${order.fuel} 拟调至 ${order.proposedPrice.toFixed(2)} 元 / ${statusLabel(order.status)} / ${order.operator} / ${order.effectiveDate}`;
  void navigator.clipboard?.writeText(text);
  store.pushToast("info", "调价单摘要已复制");
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

function signedDiff(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  if (value > 0) return `+${fixed}`;
  if (value < 0) return `-${fixed}`;
  return "0.00";
}

function diffClass(value: number): string {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

function actionLabel(log: OperationLog): string {
  const map: Record<OperationLog["action"], string> = {
    init: "台账初始化",
    migrate: "旧数据迁移",
    submit: "提交调价单",
    submit_conflict: "留存冲突草稿",
    activate: "挂牌价生效",
    rebase_promote: "草稿重算排队",
    rollback: "调价单回退",
    discard_draft: "放弃草稿",
    recover: "中断恢复",
    recover_abort: "恢复放弃",
  };
  return map[log.action];
}

const expandedLogs = ref<Set<string>>(new Set());

function toggleLog(id: string): void {
  const next = new Set(expandedLogs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedLogs.value = next;
}

const terminalDraftCount = computed(() => store.myDrafts.length);
const showLogPanel = ref(false);
const editingName = ref(false);
const nameDraft = ref(store.terminal.name);

function saveName() {
  store.renameTerminal(nameDraft.value);
  editingName.value = false;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 可恢复多端价格台账</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            同一油品只接受一个待生效版本；后到终端的调价单先留存为冲突草稿，前序版本生效后按新挂牌价重算差额再提交。操作日志与价格快照同事务落盘，写入中断自动恢复。
          </p>
        </div>
        <div class="terminal-card">
          <span class="terminal-dot" />
          <div>
            <p class="terminal-label">当前值班终端</p>
            <template v-if="!editingName">
              <strong class="terminal-name" @click="editingName = true; nameDraft = store.terminal.name">
                {{ store.terminal.name }}
              </strong>
            </template>
            <template v-else>
              <input v-model="nameDraft" class="terminal-input" @keyup.enter="saveName" />
            </template>
            <p class="terminal-id">ID：{{ store.terminal.id.slice(-8) }}</p>
          </div>
        </div>
      </header>

      <!-- 全局提示 -->
      <div class="toasts">
        <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="toast.tone">
          <span>{{ toast.text }}</span>
          <button type="button" class="toast-close" @click="store.dismissToast(toast.id)">×</button>
        </div>
      </div>

      <!-- 恢复 / 迁移提示 -->
      <section v-if="store.recovery.recovered > 0" class="banner warning">
        <strong>写入恢复：</strong>
        检测到 {{ store.recovery.recovered }} 笔未完成的调价写入，已依据预写日志把操作记录与价格快照补全。
        <ul>
          <li v-for="(item, index) in store.recovery.details" :key="index">{{ item }}</li>
        </ul>
      </section>
      <section v-if="store.migrated" class="banner success">
        <strong>旧台账迁移完成：</strong>
        旧版单站控机中的调价记录已全部迁入新台账，原有记录、状态与备注均保留（迁移单据带有「旧」标记）。
      </section>

      <!-- 待处理提示：跟随最新生效价与待生效队列 -->
      <section v-if="store.pendingOrders.length || store.draftOrders.length" class="pending-banner">
        <h3>待处理提示</h3>
        <div v-for="order in store.pendingOrders" :key="order.id" class="pending-line" :class="{ mine: order.terminalId === store.terminal.id }">
          <span class="badge pending">待生效</span>
          <span class="pending-fuel">{{ order.fuel }}</span>
          <span>
            当前生效价 <strong>{{ store.latestPrice(order.fuel)?.toFixed(2) }}</strong> 元，
            拟调至 <strong>{{ order.proposedPrice.toFixed(2) }}</strong> 元
            <em :class="diffClass(order.diff)">（差额 {{ signedDiff(order.diff) }}）</em>
          </span>
          <span class="pending-meta">
            {{ order.terminalId === store.terminal.id ? "本终端" : order.terminalName }} · {{ order.operator }} · 生效日 {{ order.effectiveDate }}
          </span>
          <span v-if="order.terminalId !== store.terminal.id" class="tag warn">其他终端持有，新调价将先存为冲突草稿</span>
        </div>
        <div v-for="order in store.draftOrders" :key="order.id" class="pending-line draft">
          <span class="badge draft">冲突草稿</span>
          <span class="pending-fuel">{{ order.fuel }}</span>
          <span>
            拟调至 <strong>{{ order.proposedPrice.toFixed(2) }}</strong> 元，
            前序版本生效后自动按新挂牌价重算差额（建单基准 {{ order.basePrice.toFixed(2) }}）
          </span>
          <span class="pending-meta">{{ order.terminalName }} · {{ order.createdAt.slice(0, 10) }} 排队</span>
        </div>
      </section>

      <!-- 汇总指标 -->
      <section class="metrics">
        <article v-for="metric in store.metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 调价表单 -->
        <form class="panel" @submit.prevent="submitForm">
          <h2>提交调价单</h2>
          <div v-if="blockingHint" class="form-warn">
            「{{ form.fuel }}」已有待生效版本（{{ blockingHint.terminalName }} 提交，{{ blockingHint.proposedPrice.toFixed(2) }} 元）。
            本次保存不会覆盖，将留存为冲突草稿，待该版本生效后重算差额。
          </div>
          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel" required @change="onFuelChange">
                <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              新挂牌价（元/升）
              <input v-model.number="form.proposedPrice" type="number" min="0" step="0.01" required />
            </label>
            <div class="diff-row" v-if="formDiff !== null">
              最新生效价 <strong>{{ store.latestPrice(form.fuel)?.toFixed(2) }}</strong> 元，
              差额
              <strong :class="diffClass(formDiff)">{{ signedDiff(formDiff) }}</strong>
            </div>
            <label>
              操作员
              <input v-model="form.operator" placeholder="值班员工姓名" required />
            </label>
            <label>
              生效日期
              <input v-model="form.effectiveDate" type="date" required />
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="调价原因 / 复核说明，随单据长期保留" />
            </label>
            <button type="submit" :disabled="store.busy">{{ store.busy ? "提交中…" : "保存调价单" }}</button>
            <p v-if="terminalDraftCount" class="draft-tip">本终端有 {{ terminalDraftCount }} 张冲突草稿排队中。</p>
          </div>
        </form>

        <!-- 挂牌板：列表与汇总的唯一价格来源 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>最新生效价挂牌板</h2>
            <button type="button" class="secondary" @click="showLogPanel = !showLogPanel">
              {{ showLogPanel ? "收起操作日志" : `查看操作日志（${store.ledger?.logs.length ?? 0}）` }}
            </button>
          </div>

          <div class="board-grid">
            <article v-for="row in store.boardList" :key="row.fuel" class="board-card">
              <div class="board-head">
                <p class="board-fuel">{{ row.fuel }}</p>
                <p class="board-price">
                  {{ row.price !== null ? row.price.toFixed(2) : "—" }}
                  <small>元/升</small>
                </p>
              </div>
              <p class="board-source" v-if="row.entry?.source">来源：{{ row.entry.source }} · {{ formatTime(row.entry.updatedAt) }}</p>

              <div v-if="row.pending" class="board-order pending-box">
                <div class="board-order-head">
                  <span class="badge pending">待生效</span>
                  <span>{{ row.pending.proposedPrice.toFixed(2) }} 元 / {{ row.pending.terminalName }}</span>
                </div>
                <p class="board-order-meta">
                  差额 <em :class="diffClass(row.pending.diff)">{{ signedDiff(row.pending.diff) }}</em>
                  · {{ row.pending.operator }} · {{ row.pending.effectiveDate }}
                </p>
                <p v-if="row.pending.notes" class="board-note">{{ row.pending.notes }}</p>
                <div class="actions">
                  <button type="button" :disabled="store.busy" @click="activate(row.pending)">确认生效并挂牌</button>
                  <button type="button" class="secondary" :disabled="store.busy" @click="rollback(row.pending)">回退</button>
                </div>
              </div>

              <div v-if="row.drafts.length" class="board-order draft-box">
                <p class="queue-title">冲突草稿队列（{{ row.drafts.length }}）：前序生效后队首自动转待生效并按新价重算</p>
                <div v-for="(draft, index) in row.drafts" :key="draft.id" class="queue-item">
                  <span class="queue-index">{{ index + 1 }}</span>
                  <div>
                    <strong>{{ draft.proposedPrice.toFixed(2) }}</strong> 元
                    <span class="pending-meta"> · {{ draft.terminalName }} · {{ draft.operator }} · 差额（按建单基准）<em :class="diffClass(draft.diff)">{{ signedDiff(draft.diff) }}</em></span>
                    <p v-if="draft.notes" class="board-note">{{ draft.notes }}</p>
                  </div>
                  <button v-if="draft.terminalId === store.terminal.id" type="button" class="danger small" @click="discard(draft)">放弃</button>
                </div>
              </div>

              <p v-if="!row.pending && !row.drafts.length" class="board-idle">暂无待处理调价单</p>
            </article>
          </div>
        </section>
      </section>

      <!-- 调价台账明细 -->
      <section class="ledger-panel">
        <div class="toolbar">
          <h2>调价单台账</h2>
          <div class="filters">
            <select v-model="fuelFilter">
              <option value="全部油品">全部油品</option>
              <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
            </select>
            <select v-model="statusFilter">
              <option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </div>
        </div>

        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr>
                <th>油品</th>
                <th>状态</th>
                <th>新挂牌价</th>
                <th>基准价</th>
                <th>差额</th>
                <th>操作员</th>
                <th>生效日期</th>
                <th>提交终端</th>
                <th>备注</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in filteredOrders" :key="order.id">
                <td>{{ order.fuel }}</td>
                <td>
                  <span class="badge" :class="order.status">{{ statusLabel(order.status) }}</span>
                  <span v-if="order.legacy" class="legacy-tag" :title="`旧系统状态：${order.legacy.legacyStatus}`">旧</span>
                </td>
                <td>{{ order.proposedPrice.toFixed(2) }}</td>
                <td>{{ order.basePrice.toFixed(2) }}</td>
                <td :class="diffClass(order.diff)">{{ signedDiff(order.diff) }}</td>
                <td>{{ order.operator }}</td>
                <td>{{ order.effectiveDate || "—" }}</td>
                <td>{{ order.terminalName }}</td>
                <td class="note-cell">{{ order.notes || "—" }}</td>
                <td class="time-cell">{{ formatTime(order.decidedAt ?? order.createdAt) }}</td>
                <td class="op-cell">
                  <button v-if="order.status === 'pending'" type="button" class="small" @click="activate(order)">生效</button>
                  <button
                    v-if="order.status === 'pending' || order.status === 'effective'"
                    type="button"
                    class="small secondary"
                    @click="rollback(order)"
                  >回退</button>
                  <button v-if="order.status === 'conflict_draft' && order.terminalId === store.terminal.id" type="button" class="small danger" @click="discard(order)">放弃</button>
                  <button type="button" class="small secondary" @click="copySummary(order)">复制</button>
                </td>
              </tr>
              <tr v-if="filteredOrders.length === 0">
                <td colspan="11" class="empty">暂无匹配调价单</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 操作日志 + 价格快照 -->
      <section v-if="showLogPanel" class="log-panel">
        <div class="toolbar">
          <h2>操作日志（含事务价格快照）</h2>
          <button type="button" class="secondary" @click="showLogPanel = false">收起</button>
        </div>
        <div class="log-list">
          <article v-for="log in store.ledger?.logs ?? []" :key="log.id" class="log-item">
            <div class="log-head" @click="toggleLog(log.id)">
              <span class="badge log-badge">{{ actionLabel(log) }}</span>
              <span class="log-detail">{{ log.detail }}</span>
              <span class="log-meta">{{ log.terminalName }} · {{ formatTime(log.at) }} · 事务 {{ log.txId.slice(-6) }}</span>
              <span class="log-toggle">{{ expandedLogs.has(log.id) ? "收起快照 ▲" : "查看快照 ▼" }}</span>
            </div>
            <div v-if="expandedLogs.has(log.id)" class="snapshot">
              <p>事务提交后挂牌板快照：</p>
              <div class="snapshot-grid">
                <span v-for="entry in log.snapshot" :key="entry.fuel">
                  {{ entry.fuel }}：<strong>{{ entry.price.toFixed(2) }}</strong> 元
                  <em v-if="entry.source">（{{ entry.source }}）</em>
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>
