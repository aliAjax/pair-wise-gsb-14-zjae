<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { FUEL_OPTIONS, STATUS_META, usePriceStore } from "./store";
import type { Adjustment, LogEntry } from "./types";

const store = usePriceStore();

onMounted(() => store.startTerminalSync());

const today = new Date().toISOString().slice(0, 10);

const blankForm = () => ({
  fuel: "",
  price: null as number | null,
  operator: "",
  effectiveDate: today,
  notes: "",
});
const form = reactive(blankForm());
const formError = ref("");

const tab = ref<"board" | "records" | "snapshots" | "logs">("board");
const filter = ref<"全部油品" | string>("全部油品");

/** 冲突草稿改价用的临时输入（默认带出草稿原报价） */
const recalcPrices = reactive<Record<string, number>>({});

const filteredRecords = computed(() => {
  const rows = [...store.adjustments].sort((a, b) => b.seq - a.seq);
  if (filter.value === "全部油品") return rows;
  return rows.filter((record) => record.fuel === filter.value);
});

const maxChart = computed(() => Math.max(1, ...store.statusChart.map((row) => row.value)));

async function submit() {
  formError.value = "";
  if (!form.fuel) {
    formError.value = "请选择油品";
    return;
  }
  if (form.price === null || Number.isNaN(form.price) || form.price <= 0) {
    formError.value = "请输入大于 0 的挂牌价";
    return;
  }
  if (!form.effectiveDate) {
    formError.value = "请选择生效日期";
    return;
  }
  const result = await store.submitDraft({
    fuel: form.fuel,
    price: form.price,
    operator: form.operator,
    effectiveDate: form.effectiveDate,
    notes: form.notes,
  });
  if (result) Object.assign(form, blankForm());
}

function statusLabel(status: Adjustment["status"]): string {
  return STATUS_META[status].label;
}

function formatDiff(item: Adjustment): string {
  if (item.diff === null || item.status === "rolledback") return "—";
  if (item.diff > 0) return `+${item.diff.toFixed(2)}`;
  if (item.diff < 0) return item.diff.toFixed(2);
  return "0.00";
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortId(id: string): string {
  return id.length > 14 ? id.slice(-8) : id;
}

function summaryText(item: Adjustment): string {
  return [item.fuel, `${item.price}元`, statusLabel(item.status), item.operator, item.effectiveDate]
    .filter(Boolean)
    .join(" / ");
}

async function copySummary(item: Adjustment) {
  try {
    await navigator.clipboard?.writeText(summaryText(item));
  } catch {
    // 剪贴板不可用时忽略
  }
}

function blockerText(item: Adjustment): string {
  const blocker = store.blockerOf(item);
  if (!blocker) return "等待前序版本生效";
  return `被「${blocker.price} 元」待生效单占用，前序生效后自动按新挂牌价重算差额递补`;
}

function draftPrice(item: Adjustment): number {
  if (recalcPrices[item.id] === undefined) recalcPrices[item.id] = item.price;
  return recalcPrices[item.id];
}

const LOG_KIND_LABEL: Record<LogEntry["kind"], string> = {
  submit: "提交调价",
  "submit-conflict": "冲突留稿",
  effect: "价格生效",
  rollback: "回退",
  promote: "队列递补",
  recalc: "重算差额",
  "remove-draft": "删除草稿",
  migrate: "旧账迁移",
  seed: "初始化",
  recover: "故障恢复",
  salvage: "数据抢救",
};

const txnDescription = computed(() => {
  const txn = store.pendingTxn;
  if (!txn) return "";
  const p = txn.payload;
  switch (p.type) {
    case "submit":
      return `${p.terminal} 提交 ${p.draft.fuel} ${p.draft.price} 元调价单`;
    case "effect":
      return `单据 ${shortId(p.adjustmentId)} 生效写入`;
    case "rollback":
      return `单据 ${shortId(p.adjustmentId)} 回退写入`;
    case "recalc":
      return `单据 ${shortId(p.adjustmentId)} 重算提交`;
    case "remove":
      return `单据 ${shortId(p.adjustmentId)} 删除`;
  }
});

function armFault(barrier: number) {
  store.armFault(barrier, 700);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 多端可恢复调价台账</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            同一油品同时只接受一个待生效版本，后到终端的调价单留为冲突草稿；
            操作日志与价格快照随调价单一并入账，写入异常可从断点恢复继续完成。
            多开浏览器标签页即代表多台值班终端。
          </p>
        </div>
        <div class="terminal-box">
          <div class="terminal-id">
            <span class="dot" />
            当前终端：<strong>{{ store.terminal }}</strong>
          </div>
          <button type="button" class="secondary" @click="store.switchTerminal()">
            模拟换一台值班终端
          </button>
        </div>
      </header>

      <!-- 写入中断恢复横幅 -->
      <section v-if="store.pendingTxn" class="banner banner-warn">
        <div>
          <strong>检测到一笔写入中断的调价事务</strong>
          <p>{{ txnDescription }} · 已完成 {{ store.pendingTxn.appliedOps }} 步，预写日志完好，恢复后将从断点继续写齐调价单、操作日志与价格快照。</p>
        </div>
        <button type="button" :disabled="store.busy" @click="store.recover()">恢复写入并完成</button>
      </section>

      <section v-else-if="store.lastRecoveredAt" class="banner banner-ok">
        <div>
          <strong>上次中断的写入已恢复完成</strong>
          <p>恢复时间：{{ formatTime(store.lastRecoveredAt) }}，台账数据一致，无半份记录。</p>
        </div>
      </section>

      <!-- 全局提示 -->
      <section v-if="store.toast" :class="['banner', `banner-${store.toast.type === 'ok' ? 'ok' : store.toast.type === 'warn' ? 'warn' : 'err'}`]">
        <p>{{ store.toast.text }}</p>
      </section>

      <!-- 待处理提示 -->
      <section v-if="store.attentionCount > 0 && !store.pendingTxn" class="attention">
        <p class="attention-title">待处理（{{ store.attentionCount }}）</p>
        <div class="attention-list">
          <span v-for="item in store.pendingItems" :key="`p-${item.id}`" class="chip chip-amber">
            {{ item.fuel }} 待生效 {{ item.price }} 元 · {{ item.effectiveDate }}
          </span>
          <span v-for="item in store.conflictedItems" :key="`c-${item.id}`" class="chip chip-red">
            {{ item.fuel }} 冲突草稿 {{ item.price }} 元 · {{ item.terminal }} 等前序生效
          </span>
        </div>
      </section>

      <section class="metrics">
        <article v-for="metric in store.metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>
            {{ metric.value }}<small v-if="metric.unit">{{ metric.unit }}</small>
          </strong>
        </article>
      </section>
      <p class="metric-note">注：平均挂牌价仅按各油品最新一张已生效价格快照计算，待生效与草稿价不计入。</p>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>调整油品价格</h2>
          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel">
                <option value="">请选择</option>
                <option v-for="option in FUEL_OPTIONS" :key="option" :value="option">{{ option }}</option>
              </select>
            </label>
            <label>
              挂牌价（元/升）
              <input v-model.number="form.price" type="number" min="0" step="0.01" placeholder="如 7.85" />
            </label>
            <label>
              操作员
              <input v-model.number="form.operator" type="text" :placeholder="`默认 ${store.terminal}`" />
            </label>
            <label>
              生效日期
              <input v-model="form.effectiveDate" type="date" />
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <button type="submit" :disabled="store.busy || !!store.pendingTxn">
              {{ store.busy ? "写入中…" : "保存调价单" }}
            </button>
            <p class="form-hint">
              保存时若该油品已有待生效版本，本单将自动留为<span class="hl-red">冲突草稿</span>，不会覆盖先到版本。
            </p>
          </div>

          <div class="drill">
            <h3>写入异常演练</h3>
            <p class="drill-hint">
              开启后下一次写入按步骤落盘（每步 0.7 秒），可在中途刷新/关闭页面模拟“写到一半”，重开后会自动续完；
              也可直接在指定步骤抛出存储异常（一次性触发，不影响后续操作）。
            </p>
            <div class="drill-actions">
              <button type="button" class="secondary" @click="armFault(2)">异常：单据入账前</button>
              <button type="button" class="secondary" @click="armFault(3)">异常：生效后递补前</button>
              <button type="button" class="secondary" @click="armFault(4)">异常：队列转挂前</button>
              <button type="button" class="secondary" @click="store.clearFault()">取消演练</button>
            </div>
            <p v-if="store.fault" class="drill-state">
              演练已开启：下一次写入将在第 {{ store.fault.barrier }} 步之前抛出异常，请现在去提交或生效单据（生效带排队的单据可触发多步事务）。
            </p>
          </div>
        </form>

        <section class="list-panel">
          <div class="tabs">
            <button :class="{ active: tab === 'board' }" type="button" class="tab" @click="tab = 'board'">油品台账</button>
            <button :class="{ active: tab === 'records' }" type="button" class="tab" @click="tab = 'records'">调价明细</button>
            <button :class="{ active: tab === 'snapshots' }" type="button" class="tab" @click="tab = 'snapshots'">价格快照</button>
            <button :class="{ active: tab === 'logs' }" type="button" class="tab" @click="tab = 'logs'">
              操作日志<span v-if="store.logs.length" class="tab-count">{{ store.logs.length }}</span>
            </button>
          </div>

          <!-- 油品台账：跟最新生效价走 -->
          <div v-if="tab === 'board'" class="board">
            <article v-for="row in store.fuelBoard" :key="row.fuel" class="fuel-card">
              <div class="fuel-head">
                <p class="fuel-name">{{ row.fuel }}</p>
                <span v-if="row.attention" class="badge badge-red">{{ row.attention }} 待处理</span>
              </div>
              <div class="fuel-price">
                <span class="fuel-price-label">最新生效挂牌价</span>
                <strong>{{ row.effectivePrice === null ? "暂无" : row.effectivePrice.toFixed(2) }}</strong>
                <em v-if="row.effectivePrice !== null">元/升</em>
              </div>
              <div v-if="row.pending" class="queue-row">
                <span class="badge badge-amber">待生效</span>
                <span class="queue-text">{{ row.pending.price }} 元 · {{ row.pending.effectiveDate }} · {{ row.pending.terminal }}</span>
                <span class="queue-delta">{{ formatDiff(row.pending) }} 元</span>
              </div>
              <div v-for="draft in row.drafts" :key="draft.id" class="queue-row queue-conflict">
                <span class="badge badge-red">冲突草稿</span>
                <span class="queue-text">{{ draft.price }} 元 · {{ draft.terminal }} · {{ blockerText(draft) }}</span>
              </div>
              <div v-if="!row.pending && row.drafts.length === 0 && row.effectivePrice !== null" class="queue-empty">
                无在途调价
              </div>
            </article>
          </div>

          <!-- 调价明细 -->
          <template v-if="tab === 'records'">
            <div class="toolbar">
              <h2>调价明细</h2>
              <select v-model="filter">
                <option value="全部油品">全部油品</option>
                <option v-for="item in FUEL_OPTIONS" :key="item" :value="item">{{ item }}</option>
              </select>
            </div>
            <div class="record-grid">
              <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
              <article v-for="record in filteredRecords" :key="record.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ record.fuel }} / {{ record.price }} 元</p>
                  <span :class="['badge', `badge-${STATUS_META[record.status].tone}`]">{{ statusLabel(record.status) }}</span>
                </div>
                <div class="details">
                  <span>操作员：{{ record.operator }}</span>
                  <span>提交终端：{{ record.terminal }}</span>
                  <span>生效日期：{{ record.effectiveDate || "—" }}</span>
                  <span>提交时间：{{ formatTime(record.createdAt) }}</span>
                  <span>当前生效价：{{ record.basePrice === null ? "无" : `${record.basePrice} 元` }}</span>
                  <span>差额（对最新生效价）：{{ formatDiff(record) }} 元</span>
                </div>
                <p v-if="record.legacyStatus && record.legacyStatus !== statusLabel(record.status)" class="legacy-note">
                  旧台账原状态：{{ record.legacyStatus }}（迁移时原样保留）
                </p>
                <p class="note">{{ record.notes }}</p>
                <div class="actions">
                  <button v-if="record.status === 'pending'" type="button" :disabled="store.busy || !!store.pendingTxn" @click="store.effect(record.id)">
                    确认生效
                  </button>
                  <template v-if="record.status === 'conflicted'">
                    <input
                      :value="draftPrice(record)"
                      @input="recalcPrices[record.id] = Number(($event.target as HTMLInputElement).value)"
                      type="number"
                      step="0.01"
                      class="inline-input"
                      :disabled="!!store.blockerOf(record) || store.busy"
                    />
                    <button
                      type="button"
                      :disabled="!!store.blockerOf(record) || store.busy || !!store.pendingTxn"
                      :title="store.blockerOf(record) ? blockerText(record) : '按最新生效价重算差额后提交'"
                      @click="store.recalcSubmit(record.id, recalcPrices[record.id])"
                    >
                      重算差额并提交
                    </button>
                  </template>
                  <button v-if="record.status === 'effective'" type="button" class="secondary" :disabled="store.busy" @click="store.rollback(record.id)">
                    回退
                  </button>
                  <button
                    v-if="record.status === 'pending' || record.status === 'conflicted'"
                    type="button"
                    class="danger"
                    :disabled="store.busy || !!store.pendingTxn"
                    @click="store.removeDraft(record.id)"
                  >
                    删除
                  </button>
                  <button type="button" class="secondary" @click="copySummary(record)">复制摘要</button>
                </div>
              </article>
            </div>

            <div class="mini-chart">
              <div v-for="row in store.statusChart" :key="row.status" class="bar">
                <span>{{ row.label }}</span>
                <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
                <strong>{{ row.value }}</strong>
              </div>
            </div>
          </template>

          <!-- 价格快照 -->
          <template v-if="tab === 'snapshots'">
            <div class="toolbar"><h2>价格快照（与操作日志同事务写入）</h2></div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>时间</th><th>油品</th><th>挂牌价</th><th>生效日期</th><th>来源单据</th><th>终端</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(s, i) in [...store.snapshots].reverse()" :key="`${s.adjustmentId}-${i}`">
                  <td>{{ formatTime(s.at) }}</td>
                  <td>{{ s.fuel }}</td>
                  <td>{{ s.price.toFixed(2) }}</td>
                  <td>{{ s.effectiveDate || "—" }}</td>
                  <td>{{ shortId(s.adjustmentId) }}</td>
                  <td>{{ s.terminal }}</td>
                </tr>
                <tr v-if="store.snapshots.length === 0">
                  <td colspan="6" class="empty">尚无价格快照</td>
                </tr>
              </tbody>
            </table>
          </template>

          <!-- 操作日志 -->
          <template v-if="tab === 'logs'">
            <div class="toolbar"><h2>操作日志</h2></div>
            <ul class="log-list">
              <li v-for="log in store.logs" :key="log.id" class="log-item">
                <div class="log-head">
                  <span :class="['log-kind', `log-${log.kind}`]">{{ LOG_KIND_LABEL[log.kind] }}</span>
                  <span class="log-meta">{{ formatTime(log.at) }} · {{ log.terminal }}<template v-if="log.fuel"> · {{ log.fuel }}</template></span>
                </div>
                <p class="log-message">{{ log.message }}</p>
              </li>
              <li v-if="store.logs.length === 0" class="empty">暂无操作日志</li>
            </ul>
          </template>
        </section>
      </section>
    </div>
  </main>
</template>
