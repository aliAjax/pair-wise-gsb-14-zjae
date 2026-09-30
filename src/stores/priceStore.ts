import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { FUELS, round2, statusLabel, uid } from "../ledger/engine";
import {
  boot,
  commit,
  loadTerminal,
  saveTerminalName,
  setFaultHook,
  snapshotRead,
  type RecoveryReport,
} from "../ledger/storage";
import type { AdjustOrder, Ledger, OperationLog } from "../ledger/types";

export interface SubmitInput {
  fuel: string;
  proposedPrice: number;
  operator: string;
  effectiveDate: string;
  notes: string;
}

interface Toast {
  id: string;
  tone: "success" | "warning" | "danger" | "info";
  text: string;
}

export const usePriceStore = defineStore("price-ledger", () => {
  const ledger = ref<Ledger | null>(null);
  const terminal = ref(loadTerminal());
  const recovery = ref<RecoveryReport>({ recovered: 0, details: [] });
  const migrated = ref(false);
  const busy = ref(false);
  const toasts = ref<Toast[]>([]);

  // -------------------------------------------------------------------------
  // 提示条
  // -------------------------------------------------------------------------

  function pushToast(tone: Toast["tone"], text: string): void {
    const id = uid("toast");
    toasts.value.push({ id, tone, text });
    setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, 6000);
  }

  function dismissToast(id: string): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  // -------------------------------------------------------------------------
  // 读取 / 多端同步
  // -------------------------------------------------------------------------

  function pullFromStorage(): void {
    const fresh = snapshotRead();
    if (fresh && fresh.seq !== ledger.value?.seq) {
      ledger.value = fresh;
    } else if (fresh) {
      ledger.value = fresh;
    }
  }

  function onStorage(event: StorageEvent): void {
    if (event.key === null || event.key === "dfwlfront-9-ledger-v1" || event.key === "dfwlfront-9-ledger-wal-v1") {
      pullFromStorage();
    }
  }

  async function init(): Promise<void> {
    const result = await boot(terminal.value);
    ledger.value = result.ledger;
    recovery.value = result.recovery;
    migrated.value = result.migrated;

    window.addEventListener("storage", onStorage);
    // 兜底轮询：部分环境对 storage 事件有节流，按版本号比对拉取最新台账
    window.setInterval(pullFromStorage, 2000);

    if (result.recovery.recovered > 0) {
      pushToast("warning", `检测到上次有 ${result.recovery.recovered} 笔写入未完成，已按操作日志自动恢复并补全`);
    }
    if (result.migrated) {
      pushToast("success", "旧版价格记录已迁移进新台账，原有记录、状态与备注均已保留");
    }
  }

  // -------------------------------------------------------------------------
  // 业务动作
  // -------------------------------------------------------------------------

  async function submit(input: SubmitInput): Promise<"pending" | "conflict"> {
    busy.value = true;
    try {
      const result = await commit({
        kind: "submit",
        order: {
          fuel: input.fuel,
          proposedPrice: round2(input.proposedPrice),
          operator: input.operator,
          effectiveDate: input.effectiveDate,
          notes: input.notes,
          terminalId: terminal.value.id,
          terminalName: terminal.value.name,
        },
      });
      ledger.value = result;
      const conflict = result.orders.find(
        (o) => o.status === "conflict_draft" && o.terminalId === terminal.value.id
      );
      if (conflict) {
        pushToast(
          "warning",
          `「${input.fuel}」已有待生效版本，本调价单已留存为冲突草稿；前序版本生效后将按新挂牌价重算差额并自动排队转待生效`
        );
        return "conflict";
      }
      pushToast("success", `「${input.fuel}」调价单已提交，当前为唯一待生效版本`);
      return "pending";
    } catch (error) {
      pushToast("danger", error instanceof Error ? error.message : "调价单提交失败");
      throw error;
    } finally {
      busy.value = false;
    }
  }

  async function activate(orderId: string, note?: string): Promise<void> {
    busy.value = true;
    try {
      ledger.value = await commit({ kind: "activate", orderId, terminal: terminal.value, note });
      const order = ledger.value.orders.find((o) => o.id === orderId);
      const promoted = ledger.value.orders.filter(
        (o) => o.fuel === order?.fuel && o.status === "pending" && o.id !== orderId
      );
      pushToast(
        "success",
        `「${order?.fuel ?? ""}」新挂牌价已生效${promoted.length ? "，队首冲突草稿已重算差额并转为待生效" : ""}`
      );
    } catch (error) {
      pushToast("danger", error instanceof Error ? error.message : "生效操作失败");
    } finally {
      busy.value = false;
    }
  }

  async function rollback(orderId: string, reason: string): Promise<void> {
    busy.value = true;
    try {
      ledger.value = await commit({ kind: "rollback", orderId, terminal: terminal.value, reason });
      pushToast("info", "调价单已回退，挂牌价已恢复，排队草稿顺序不变");
    } catch (error) {
      pushToast("danger", error instanceof Error ? error.message : "回退失败");
    } finally {
      busy.value = false;
    }
  }

  async function discardDraft(orderId: string): Promise<void> {
    busy.value = true;
    try {
      ledger.value = await commit({ kind: "discard", orderId, terminal: terminal.value });
      pushToast("info", "冲突草稿已放弃");
    } catch (error) {
      pushToast("danger", error instanceof Error ? error.message : "删除草稿失败");
    } finally {
      busy.value = false;
    }
  }

  function renameTerminal(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveTerminalName(trimmed);
    terminal.value = { ...terminal.value, name: trimmed };
  }

  // -------------------------------------------------------------------------
  // 派生视图：列表、汇总、待处理提示全部跟随最新生效价（挂牌板）
  // -------------------------------------------------------------------------

  const boardList = computed(() =>
    FUELS.map((fuel) => ({
      fuel,
      price: ledger.value?.board[fuel]?.price ?? null,
      entry: ledger.value?.board[fuel] ?? null,
      pending: ledger.value?.orders.find((o) => o.fuel === fuel && o.status === "pending") ?? null,
      drafts: (ledger.value?.orders ?? []).filter((o) => o.fuel === fuel && o.status === "conflict_draft"),
    }))
  );

  const pendingOrders = computed(() =>
    (ledger.value?.orders ?? []).filter((o) => o.status === "pending")
  );

  const draftOrders = computed(() =>
    (ledger.value?.orders ?? []).filter((o) => o.status === "conflict_draft")
  );

  const otherTerminalPending = computed(() =>
    pendingOrders.value.filter((o) => o.terminalId !== terminal.value.id)
  );

  const myDrafts = computed(() =>
    (ledger.value?.orders ?? []).filter(
      (o) => o.status === "conflict_draft" && o.terminalId === terminal.value.id
    )
  );

  const metrics = computed(() => {
    const priced = boardList.value.filter((row) => row.price !== null);
    const avg =
      priced.length > 0
        ? round2(priced.reduce((sum, row) => sum + (row.price ?? 0), 0) / priced.length)
        : 0;
    return [
      { label: "在档油品", value: priced.length },
      { label: "待生效调价单", value: pendingOrders.value.length },
      { label: "冲突草稿", value: draftOrders.value.length },
      { label: "最新平均挂牌价", value: avg.toFixed(2) },
    ];
  });

  function latestPrice(fuel: string): number | null {
    return ledger.value?.board[fuel]?.price ?? null;
  }

  function orderOf(id: string): AdjustOrder | undefined {
    return ledger.value?.orders.find((o) => o.id === id);
  }

  return {
    // state
    ledger,
    terminal,
    recovery,
    migrated,
    busy,
    toasts,
    // actions
    init,
    submit,
    activate,
    rollback,
    discardDraft,
    renameTerminal,
    pushToast,
    dismissToast,
    // views
    boardList,
    pendingOrders,
    draftOrders,
    otherTerminalPending,
    myDrafts,
    metrics,
    latestPrice,
    orderOf,
  };
});

export type { OperationLog };
export { statusLabel };
export { setFaultHook };
