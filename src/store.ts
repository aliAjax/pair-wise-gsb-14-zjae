import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { LedgerEngine, LedgerWriteError, latestEffectivePrice, pendingOf } from "./engine";
import {
  browserStorage,
  currentTerminalId,
  makeAdjustmentId,
  nowIso,
  onLedgerStorage,
  readLedger,
  resetTerminalId,
} from "./storage";
import type { Adjustment, FaultConfig, Ledger, SubmitDraftData } from "./types";

export const STATUS_META: Record<
  Adjustment["status"],
  { label: string; tone: "green" | "amber" | "red" | "gray" }
> = {
  effective: { label: "生效中", tone: "green" },
  pending: { label: "待生效", tone: "amber" },
  conflicted: { label: "冲突草稿", tone: "red" },
  rolledback: { label: "已回退", tone: "gray" },
};

export const FUEL_OPTIONS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;

let engine: LedgerEngine | null = null;

function getEngine(): LedgerEngine {
  if (!engine) engine = new LedgerEngine(browserStorage, null);
  return engine;
}

export interface DraftForm {
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
}

export const usePriceStore = defineStore("price-ledger", () => {
  const ledger = ref<Ledger>(getEngine().init());
  const terminal = ref(currentTerminalId());
  const busy = ref(false);
  const lastError = ref<string | null>(null);
  const toast = ref<{ type: "ok" | "warn" | "err"; text: string } | null>(null);
  const fault = ref<FaultConfig | null>(null);

  function reloadFromDisk() {
    ledger.value = readLedger(browserStorage);
  }

  let stopWatch: (() => void) | null = null;
  function startTerminalSync() {
    if (stopWatch) return;
    stopWatch = onLedgerStorage(() => {
      reloadFromDisk();
      // 其它终端写入中断时，本终端发现后也可代为把事务补完（多端互助恢复）
      if (ledger.value.pendingTxn && !busy.value && !fault.value) void recover();
    });
    // 本终端首次打开：把上次（或别的终端）留下的半份写入自动续完
    if (ledger.value.pendingTxn && !fault.value) {
      window.setTimeout(() => void recover(), 600);
    }
  }

  function showToast(type: "ok" | "warn" | "err", text: string) {
    toast.value = { type, text };
    window.setTimeout(() => {
      if (toast.value?.text === text) toast.value = null;
    }, 5000);
  }

  async function guard<T>(action: () => Promise<T>): Promise<T | null> {
    busy.value = true;
    lastError.value = null;
    try {
      const result = await action();
      reloadFromDisk();
      return result;
    } catch (error) {
      const message =
        error instanceof LedgerWriteError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      lastError.value = message;
      reloadFromDisk();
      if (error instanceof LedgerWriteError && error.resumable) {
        // 故障演练为一次性：触发后立即撤防，恢复与后续写入不再被拦截
        if (fault.value) clearFault();
        showToast("warn", message);
      } else {
        showToast("err", message);
      }
      return null;
    } finally {
      busy.value = false;
    }
  }

  /** 提交调价单：同油品已有待生效时自动留为冲突草稿 */
  async function submitDraft(form: DraftForm): Promise<"pending" | "conflicted" | null> {
    const draft: SubmitDraftData = {
      id: makeAdjustmentId(),
      fuel: form.fuel,
      price: roundPrice(form.price),
      operator: form.operator.trim() || terminal.value,
      effectiveDate: form.effectiveDate,
      notes: form.notes.trim() || "暂无备注",
      createdAt: nowIso(),
    };
    const result = await guard(() =>
      getEngine().runTxn({ type: "submit", terminal: terminal.value, draft }),
    );
    if (!result) return null;
    if (result.conflicted) {
      showToast(
        "warn",
        `${draft.fuel} 已有待生效版本占槽，本单已留为冲突草稿，将在前序生效后按新挂牌价重算差额递补`,
      );
      return "conflicted";
    }
    showToast("ok", `${draft.fuel} 调价单已提交，状态：待生效`);
    return "pending";
  }

  /** 生效：写入价格快照 + 日志，并自动重算递补队首冲突草稿 */
  async function effect(id: string) {
    const result = await guard(() => getEngine().runTxn({ type: "effect", terminal: terminal.value, adjustmentId: id }));
    if (result) showToast("ok", "挂牌价已生效，价格快照与操作日志一并写入");
    return result;
  }

  async function rollback(id: string) {
    const result = await guard(() =>
      getEngine().runTxn({ type: "rollback", terminal: terminal.value, adjustmentId: id }),
    );
    if (result) showToast("ok", "单据已回退，恢复价格快照已入账");
    return result;
  }

  /** 冲突草稿重算差额后提交（可改价；不改价则保留原报价，仅按最新生效价重算差额） */
  async function recalcSubmit(id: string, newPrice?: number) {
    const result = await guard(() =>
      getEngine().runTxn({
        type: "recalc",
        terminal: terminal.value,
        adjustmentId: id,
        ...(newPrice === undefined ? {} : { newPrice: roundPrice(newPrice) }),
      }),
    );
    if (result) showToast("ok", "已按最新挂牌价重算差额并提交为待生效");
    return result;
  }

  async function removeDraft(id: string) {
    const result = await guard(() =>
      getEngine().runTxn({ type: "remove", terminal: terminal.value, adjustmentId: id }),
    );
    if (result) showToast("ok", "草稿已删除");
    return result;
  }

  /** 异常中断后恢复：从断点继续把剩余日志/快照写完 */
  async function recover() {
    const result = await guard(() => getEngine().recover());
    if (result?.resumed) showToast("ok", result.message);
    return result;
  }

  /** 故障演练：在下一次事务的指定屏障步制造写入异常 */
  function armFault(barrier: number, stepDelayMs = 600) {
    const config: FaultConfig = { barrier, stepDelayMs };
    fault.value = config;
    getEngine().setFault(config);
  }

  function clearFault() {
    fault.value = null;
    getEngine().setFault(null);
  }

  function switchTerminal() {
    terminal.value = resetTerminalId();
    showToast("ok", `已切换为 ${terminal.value}（多标签页即多值班终端）`);
  }

  // ---------- 派生视图：列表 / 汇总 / 待处理提示全部跟最新生效价走 ----------

  const adjustments = computed(() => ledger.value.adjustments);
  const logs = computed(() => [...ledger.value.logs].sort((a, b) => b.seq - a.seq));
  const snapshots = computed(() => ledger.value.snapshots);

  /** 油品台账视图：每个油品的最新生效价、待生效单、冲突草稿队列 */
  const fuelBoard = computed(() => {
    return FUEL_OPTIONS.map((fuel) => {
      const items = ledger.value.adjustments
        .filter((a) => a.fuel === fuel)
        .sort((a, b) => a.seq - b.seq);
      const effectivePrice = latestEffectivePrice(ledger.value, fuel);
      const pending = pendingOf(ledger.value, fuel);
      const drafts = items
        .filter((a) => a.status === "conflicted")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
      return {
        fuel,
        effectivePrice,
        pending,
        drafts,
        hasAny: items.length > 0,
        /** 待处理提示：待生效 + 冲突草稿数 */
        attention: (pending ? 1 : 0) + drafts.length,
      };
    });
  });

  const pendingItems = computed(() =>
    ledger.value.adjustments.filter((a) => a.status === "pending"),
  );

  const conflictedItems = computed(() =>
    ledger.value.adjustments
      .filter((a) => a.status === "conflicted")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq),
  );

  const attentionCount = computed(
    () => pendingItems.value.length + conflictedItems.value.length,
  );

  /** 汇总指标：油品数按有台账的油品计；平均挂牌价只按最新生效价 */
  const metrics = computed(() => {
    const prices = fuelBoard.value
      .map((row) => row.effectivePrice)
      .filter((value): value is number => value !== null);
    const avg = prices.length
      ? Math.round((prices.reduce((sum, value) => sum + value, 0) / prices.length) * 1000) / 1000
      : 0;
    const fuelsWithRecords = new Set(ledger.value.adjustments.map((a) => a.fuel)).size;
    return [
      { label: "在账油品", value: fuelsWithRecords },
      { label: "待生效", value: pendingItems.value.length },
      { label: "冲突草稿", value: conflictedItems.value.length },
      { label: "平均挂牌价", value: avg.toFixed(3), unit: "元/升" },
    ];
  });

  /** 状态分布图（按单据数） */
  const statusChart = computed(() =>
    (Object.keys(STATUS_META) as Array<Adjustment["status"]>).map((status) => ({
      status,
      label: STATUS_META[status].label,
      value: ledger.value.adjustments.filter((a) => a.status === status).length,
    })),
  );

  const pendingTxn = computed(() => ledger.value.pendingTxn);
  const lastRecoveredAt = computed(() => ledger.value.lastRecoveredAt);

  function effectivePriceOf(fuel: string): number | null {
    return latestEffectivePrice(ledger.value, fuel);
  }

  function blockerOf(item: Adjustment): Adjustment | undefined {
    if (!item.blockedBy) return undefined;
    return ledger.value.adjustments.find((a) => a.id === item.blockedBy);
  }

  return {
    // state
    ledger,
    terminal,
    busy,
    lastError,
    toast,
    fault,
    // views
    adjustments,
    logs,
    snapshots,
    fuelBoard,
    pendingItems,
    conflictedItems,
    attentionCount,
    metrics,
    statusChart,
    pendingTxn,
    lastRecoveredAt,
    // actions
    startTerminalSync,
    submitDraft,
    effect,
    rollback,
    recalcSubmit,
    removeDraft,
    recover,
    armFault,
    clearFault,
    switchTerminal,
    effectivePriceOf,
    blockerOf,
    reloadFromDisk,
  };
});

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}
