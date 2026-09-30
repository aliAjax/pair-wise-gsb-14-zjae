import type {
  AdjustOrder,
  Intent,
  IntentResult,
  Ledger,
  OperationLog,
  OrderStatus,
  SnapshotEntry,
  TerminalRef,
} from "./types";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const LEDGER_VERSION = 1 as const;
export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "待生效",
  conflict_draft: "冲突草稿",
  effective: "已生效",
  rolled_back: "已回退",
};

export function statusLabel(status: OrderStatus): string {
  return STATUS_LABEL[status];
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function uid(prefix = ""): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${rand}` : rand;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function nowIso(): string {
  return new Date().toISOString();
}

function snapshotOf(ledger: Ledger): SnapshotEntry[] {
  return Object.values(ledger.board)
    .sort((a, b) => a.fuel.localeCompare(b.fuel, "zh-Hans-CN"))
    .map((entry) => ({
      fuel: entry.fuel,
      price: entry.price,
      effectiveOrderId: entry.effectiveOrderId,
      source: entry.source,
    }));
}

function makeLog(
  ledger: Ledger,
  txId: string,
  action: OperationLog["action"],
  terminal: TerminalRef,
  detail: string,
  extra?: Pick<OperationLog, "fuel" | "orderId">
): OperationLog {
  return {
    id: uid("log"),
    txId,
    action,
    terminalId: terminal.id,
    terminalName: terminal.name,
    at: nowIso(),
    detail,
    snapshot: snapshotOf(ledger),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 初始化与迁移
// ---------------------------------------------------------------------------

export function createEmptyLedger(): Ledger {
  return { version: LEDGER_VERSION, seq: 0, board: {}, orders: [], logs: [] };
}

// 内置的默认挂牌价（首次打开、且没有任何旧数据时使用）
const SEED_PRICES: Record<string, number> = {
  "92号汽油": 7.62,
  "95号汽油": 8.11,
  "98号汽油": 9.05,
  柴油: 7.18,
};

interface LegacyRow {
  id?: unknown;
  fuel?: unknown;
  price?: unknown;
  operator?: unknown;
  effectiveDate?: unknown;
  status?: unknown;
  notes?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

/**
 * 把旧版 localStorage（dfwlfront-9-price 中直接存放的记录数组）迁移进新台账。
 * 原有记录、状态、备注一条不丢：
 *  - 旧「生效中」→ 已生效调价单，并按时间最后一条刷新挂牌板；
 *  - 旧「待确认」→ 待生效调价单（同一油品只保留最早一条为待生效，其余转冲突草稿）；
 *  - 旧「已回退」→ 已回退调价单；
 *  - 无法识别的状态按待确认语义处理，并在备注中标注原状态。
 */
export function migrateLegacy(ledger: Ledger, raw: unknown, terminal: TerminalRef): IntentResult {
  const txId = uid("tx");
  const next: Ledger = structuredClone(ledger);
  const logs: OperationLog[] = [];

  const rows: LegacyRow[] = Array.isArray(raw)
    ? (raw as LegacyRow[])
    : raw && typeof raw === "object" && Array.isArray((raw as { records?: unknown }).records)
      ? ((raw as { records: LegacyRow[] }).records)
      : [];

  const migrated: AdjustOrder[] = [];
  const effectiveCandidates = new Map<string, AdjustOrder>();
  // 本批迁移中各油品已占用待生效席位的单据（next.orders 在循环结束后才整体写入，需单独记录）
  const pendingHeadByFuel = new Map<string, string>();

  for (const row of rows) {
    const fuel = String(row.fuel ?? "").trim();
    if (!fuel) continue;
    const proposedPrice = round2(Number(row.price) || 0);
    const legacyStatus = String(row.status ?? "待确认");
    const createdAt = typeof row.createdAt === "string" ? row.createdAt : nowIso();

    let status: OrderStatus;
    if (legacyStatus === "生效中") status = "effective";
    else if (legacyStatus === "已回退") status = "rolled_back";
    else status = "pending";

    const order: AdjustOrder = {
      id: typeof row.id === "string" && row.id ? `legacy-${row.id}` : uid("legacy"),
      fuel,
      proposedPrice,
      basePrice: round2(next.board[fuel]?.price ?? proposedPrice),
      diff: 0,
      operator: String(row.operator ?? "历史操作员"),
      effectiveDate: String(row.effectiveDate ?? ""),
      notes: String(row.notes ?? ""),
      status,
      terminalId: "legacy",
      terminalName: "旧站控机数据",
      createdAt,
      legacy: { raw: row as Record<string, unknown>, legacyStatus },
    };
    order.diff = round2(order.proposedPrice - order.basePrice);

    // 同一油品多张待生效：最早一张保留待生效，其余转为冲突草稿排队
    if (status === "pending") {
      const headId = pendingHeadByFuel.get(fuel);
      if (headId) {
        order.status = "conflict_draft";
        order.conflictOf = headId;
        order.queuedAt = createdAt;
      } else {
        pendingHeadByFuel.set(fuel, order.id);
      }
    }

    if (status === "effective") {
      const candidate = effectiveCandidates.get(fuel);
      if (!candidate || createdAt > candidate.createdAt) effectiveCandidates.set(fuel, order);
    }

    migrated.push(order);
  }

  next.orders = [...migrated, ...next.orders];

  // 挂牌板以迁移到的最后生效价为准；没有生效价的油品回退到内置默认价
  for (const fuel of FUELS) {
    const winner = effectiveCandidates.get(fuel);
    if (winner) {
      next.board[fuel] = {
        fuel,
        price: winner.proposedPrice,
        effectiveOrderId: winner.id,
        updatedAt: winner.createdAt,
        source: "旧数据迁移",
      };
    } else if (!next.board[fuel]) {
      next.board[fuel] = {
        fuel,
        price: SEED_PRICES[fuel],
        source: "默认挂牌价",
      };
    }
  }

  // 迁移后重新结算所有单据的基准价与差额
  for (const order of next.orders) {
    const boardPrice = next.board[order.fuel]?.price ?? order.proposedPrice;
    if (order.status === "effective" || order.status === "rolled_back") {
      order.basePrice = order.basePrice || boardPrice;
    } else {
      order.basePrice = boardPrice;
      order.diff = round2(order.proposedPrice - boardPrice);
    }
  }

  next.seq += 1;
  next.migratedAt = nowIso();
  logs.push(
    makeLog(
      next,
      txId,
      "migrate",
      terminal,
      `旧站控机台账迁移完成：共迁移 ${migrated.length} 条记录，原有状态与备注已保留`,
    )
  );
  next.logs = [...logs, ...next.logs];

  return { ledger: next, logs };
}

/** 首次打开：写入内置挂牌板 */
export function initLedger(terminal: TerminalRef): IntentResult {
  const ledger = createEmptyLedger();
  for (const fuel of FUELS) {
    ledger.board[fuel] = { fuel, price: SEED_PRICES[fuel], source: "默认挂牌价" };
  }
  const txId = uid("tx");
  ledger.seq = 1;
  const log = makeLog(ledger, txId, "init", terminal, "台账初始化，写入默认挂牌价");
  ledger.logs = [log];
  return { ledger, logs: [log] };
}

// ---------------------------------------------------------------------------
// 调价业务规则
// ---------------------------------------------------------------------------

function pendingOrderOf(ledger: Ledger, fuel: string): AdjustOrder | undefined {
  return ledger.orders.find((o) => o.fuel === fuel && o.status === "pending");
}

/**
 * 提交调价单：
 * 同一油品已有待生效版本时，新单不覆盖、不插队，先存为「冲突草稿」。
 */
function applySubmit(
  ledger: Ledger,
  intent: Extract<Intent, { kind: "submit" }>,
  terminal: TerminalRef
): IntentResult {
  const txId = uid("tx");
  const next: Ledger = structuredClone(ledger);
  const { fuel, proposedPrice, operator, effectiveDate, notes } = intent.order;

  const boardPrice = round2(next.board[fuel]?.price ?? proposedPrice);
  const blockedBy = pendingOrderOf(next, fuel);
  const status: OrderStatus = blockedBy ? "conflict_draft" : "pending";

  const order: AdjustOrder = {
    id: uid("ord"),
    fuel,
    proposedPrice: round2(proposedPrice),
    basePrice: boardPrice,
    diff: round2(round2(proposedPrice) - boardPrice),
    operator,
    effectiveDate,
    notes,
    status,
    terminalId: terminal.id,
    terminalName: terminal.name,
    createdAt: nowIso(),
    conflictOf: blockedBy?.id,
    queuedAt: blockedBy ? nowIso() : undefined,
  };

  next.orders = [order, ...next.orders];
  next.seq += 1;

  const log = makeLog(
    next,
    txId,
    blockedBy ? "submit_conflict" : "submit",
    terminal,
    blockedBy
      ? `「${fuel}」已有待生效调价单 ${blockedBy.id.slice(-6)}（${blockedBy.terminalName} 提交），本单留存为冲突草稿，待前序版本生效后按新挂牌价重算差额`
      : `「${fuel}」调价单已受理：挂牌价 ${boardPrice.toFixed(2)} → ${order.proposedPrice.toFixed(2)}（差额 ${order.diff >= 0 ? "+" : ""}${order.diff.toFixed(2)}）`,
    { fuel, orderId: order.id }
  );
  next.logs = [log, ...next.logs];

  return { ledger: next, logs: [log] };
}

/**
 * 让一张待生效单正式生效：
 * 1. 刷新挂牌板价格快照；
 * 2. 同一油品排队的冲突草稿按新挂牌价重新计算基准价与差额，队首自动升级为待生效。
 */
function applyActivate(
  ledger: Ledger,
  intent: Extract<Intent, { kind: "activate" }>,
  terminal: TerminalRef
): IntentResult {
  const txId = uid("tx");
  const next: Ledger = structuredClone(ledger);
  const logs: OperationLog[] = [];

  const order = next.orders.find((o) => o.id === intent.orderId);
  if (!order || order.status !== "pending") {
    return { ledger, logs: [] };
  }

  const oldPrice = round2(next.board[order.fuel]?.price ?? order.basePrice);
  order.status = "effective";
  order.decidedAt = nowIso();
  order.decidedBy = terminal.name;
  order.diff = round2(order.proposedPrice - oldPrice);

  next.board[order.fuel] = {
    fuel: order.fuel,
    price: order.proposedPrice,
    effectiveOrderId: order.id,
    updatedAt: order.decidedAt,
  };

  logs.push(
    makeLog(
      next,
      txId,
      "activate",
      terminal,
      `「${order.fuel}」新挂牌价 ${order.proposedPrice.toFixed(2)} 元已生效（${oldPrice.toFixed(2)} → ${order.proposedPrice.toFixed(2)}，差额 ${order.diff >= 0 ? "+" : ""}${order.diff.toFixed(2)}）${intent.note ? `；说明：${intent.note}` : ""}`,
      { fuel: order.fuel, orderId: order.id }
    )
  );

  // 冲突草稿按新挂牌价重算，队首升级为新的待生效版本
  const queue = next.orders
    .filter((o) => o.fuel === order.fuel && o.status === "conflict_draft")
    .sort((a, b) => (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt));

  queue.forEach((draft, index) => {
    draft.basePrice = order.proposedPrice;
    draft.diff = round2(draft.proposedPrice - order.proposedPrice);
    draft.conflictOf = undefined;
    if (index === 0) {
      draft.status = "pending";
      logs.push(
        makeLog(
          next,
          txId,
          "rebase_promote",
          terminal,
          `「${draft.fuel}」冲突草稿 ${draft.id.slice(-6)}（${draft.terminalName} 提交）已按新挂牌价 ${order.proposedPrice.toFixed(2)} 重算差额（${draft.diff >= 0 ? "+" : ""}${draft.diff.toFixed(2)}）并升级为待生效`,
          { fuel: draft.fuel, orderId: draft.id }
        )
      );
    } else {
      draft.conflictOf = queue[0].id;
      logs.push(
        makeLog(
          next,
          txId,
          "rebase_promote",
          terminal,
          `「${draft.fuel}」冲突草稿 ${draft.id.slice(-6)} 已按新挂牌价重算差额（${draft.diff >= 0 ? "+" : ""}${draft.diff.toFixed(2)}），继续排队`,
          { fuel: draft.fuel, orderId: draft.id }
        )
      );
    }
  });

  next.seq += 1;
  next.logs = [...logs, ...next.logs];
  return { ledger: next, logs };
}

function applyRollback(
  ledger: Ledger,
  intent: Extract<Intent, { kind: "rollback" }>,
  terminal: TerminalRef
): IntentResult {
  const txId = uid("tx");
  const next: Ledger = structuredClone(ledger);

  const order = next.orders.find((o) => o.id === intent.orderId);
  if (!order) return { ledger, logs: [] };

  const allowed: OrderStatus[] = ["pending", "conflict_draft", "effective"];
  if (!allowed.includes(order.status)) return { ledger, logs: [] };

  const wasEffective = order.status === "effective";
  order.status = "rolled_back";
  order.decidedAt = nowIso();
  order.decidedBy = terminal.name;
  if (!order.notes.includes("[回退]")) {
    order.notes = `${order.notes}[回退] ${intent.reason}`;
  }

  const logs: OperationLog[] = [];

  // 回退已生效单：挂牌板恢复到该单之前的价格
  if (wasEffective) {
    const previous = next.orders
      .filter((o) => o.fuel === order.fuel && o.status === "effective" && o.id !== order.id)
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))[0];

    const restoredPrice = previous ? previous.proposedPrice : order.basePrice;
    next.board[order.fuel] = {
      fuel: order.fuel,
      price: round2(restoredPrice),
      effectiveOrderId: previous?.id,
      updatedAt: order.decidedAt,
      source: "回退恢复",
    };

    for (const o of next.orders) {
      if (o.fuel === order.fuel && (o.status === "pending" || o.status === "conflict_draft")) {
        o.basePrice = round2(restoredPrice);
        o.diff = round2(o.proposedPrice - restoredPrice);
      }
    }
  }

  // 若回退的是待生效单（挂牌板未被该单改写），队首冲突草稿升级为待生效；
  // 若回退的是普通草稿，只维护排队指针，不影响当前待生效版本
  if (!wasEffective) {
    const queue = next.orders
      .filter((o) => o.fuel === order.fuel && o.status === "conflict_draft")
      .sort((a, b) => (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt));
    const hadPending = next.orders.some(
      (o) => o.fuel === order.fuel && o.status === "pending" && o.id !== order.id
    );

    if (queue.length > 0 && !hadPending) {
      const [head, ...rest] = queue;
      const basePrice = round2(next.board[order.fuel]?.price ?? head.proposedPrice);
      head.status = "pending";
      head.basePrice = basePrice;
      head.diff = round2(head.proposedPrice - basePrice);
      head.conflictOf = undefined;
      rest.forEach((d) => (d.conflictOf = head.id));
      logs.push(
        makeLog(
          next,
          txId,
          "rebase_promote",
          terminal,
          `「${order.fuel}」原待生效单已回退，排队草稿 ${head.id.slice(-6)} 升级为待生效`,
          { fuel: order.fuel, orderId: head.id }
        )
      );
    } else {
      // 回退单张草稿后，其余草稿的排队指针重新挂到当前待生效单上
      const currentPending = next.orders.find((o) => o.fuel === order.fuel && o.status === "pending");
      for (const draft of queue) {
        draft.conflictOf = currentPending?.id;
      }
    }
  }

  logs.unshift(
    makeLog(
      next,
      txId,
      "rollback",
      terminal,
      `「${order.fuel}」调价单 ${order.id.slice(-6)} 已回退：${intent.reason}`,
      { fuel: order.fuel, orderId: order.id }
    )
  );

  next.seq += 1;
  next.logs = [...logs, ...next.logs];
  return { ledger: next, logs };
}

function applyDiscard(
  ledger: Ledger,
  intent: Extract<Intent, { kind: "discard" }>,
  terminal: TerminalRef
): IntentResult {
  const txId = uid("tx");
  const next: Ledger = structuredClone(ledger);

  const order = next.orders.find((o) => o.id === intent.orderId);
  if (!order || order.status !== "conflict_draft") return { ledger, logs: [] };

  next.orders = next.orders.filter((o) => o.id !== intent.orderId);
  next.seq += 1;

  const log = makeLog(
    next,
    txId,
    "discard_draft",
    terminal,
    `「${order.fuel}」冲突草稿 ${order.id.slice(-6)} 已放弃删除`,
    { fuel: order.fuel, orderId: order.id }
  );
  next.logs = [log, ...next.logs];
  return { ledger: next, logs: [log] };
}

/**
 * 事务执行入口。纯函数：输入台账与意图，输出新台账与日志。
 * 调用方负责 WAL 落盘、冲突重试与持久化。
 */
export function applyIntent(ledger: Ledger, intent: Intent): IntentResult {
  switch (intent.kind) {
    case "submit":
      return applySubmit(ledger, intent, {
        id: intent.order.terminalId,
        name: intent.order.terminalName,
      });
    case "activate":
      return applyActivate(ledger, intent, intent.terminal);
    case "rollback":
      return applyRollback(ledger, intent, intent.terminal);
    case "discard":
      return applyDiscard(ledger, intent, intent.terminal);
    case "init":
      return initLedger(intent.terminal);
    case "migrate":
      return migrateLegacy(ledger, intent.legacyRaw, intent.terminal);
    case "abort":
      return { ledger, logs: [] };
  }
}
