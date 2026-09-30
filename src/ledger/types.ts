// 调价单状态：同一油品在任一时刻只允许有一张「待生效」单
export type OrderStatus = "pending" | "conflict_draft" | "effective" | "rolled_back";

// 价格快照中的单个油品牌价
export interface SnapshotEntry {
  fuel: string;
  price: number;
  effectiveOrderId?: string;
  source?: string;
}

// 最新生效价挂牌板（列表、汇总、待处理提示统一以此为准）
export interface BoardEntry {
  fuel: string;
  price: number;
  effectiveOrderId?: string;
  updatedAt?: string;
  source?: string;
}

// 调价单在生效/回退时留下的价格轨迹条目
export interface HistoryItem {
  orderId: string;
  status: OrderStatus;
  price: number;
  diff: number;
  at: string;
  operator: string;
  terminalId: string;
  terminalName: string;
  notes?: string;
}

// 调价单（台账明细，追加为主，不做原地覆盖关键状态以外的改写）
export interface AdjustOrder {
  id: string;
  fuel: string;
  proposedPrice: number;
  // 建单时的挂牌价，冲突草稿在前面的待生效版本生效后按新挂牌价重算
  basePrice: number;
  // 差额 = 新挂牌价 - 建单时基准价；冲突草稿重算时会刷新
  diff: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  status: OrderStatus;
  terminalId: string;
  terminalName: string;
  createdAt: string;
  // 冲突草稿排队时记录：与哪张待生效单冲突 / 队列序号
  conflictOf?: string;
  queuedAt?: string;
  // 生效 / 回退时间
  decidedAt?: string;
  decidedBy?: string;
  // 迁移自旧版数据时保留的原始字段
  legacy?: {
    raw: Record<string, unknown>;
    legacyStatus: string;
  };
}

// 操作日志：与价格快照在同一事务内一并落盘
export interface OperationLog {
  id: string;
  txId: string;
  action:
    | "init"
    | "migrate"
    | "submit"
    | "submit_conflict"
    | "activate"
    | "rebase_promote"
    | "rollback"
    | "discard_draft"
    | "recover"
    | "recover_abort";
  fuel?: string;
  orderId?: string;
  terminalId: string;
  terminalName: string;
  at: string;
  detail: string;
  // 事务提交时刻的完整挂牌板快照
  snapshot: SnapshotEntry[];
}

export interface Ledger {
  version: 1;
  // 乐观锁版本号，每次事务 +1，用于多端写入时后到者重读
  seq: number;
  board: Record<string, BoardEntry>;
  orders: AdjustOrder[];
  logs: OperationLog[];
  migratedAt?: string;
}

// 操作意图：先整体落 WAL（预写日志），再一次性提交主台账
export type Intent =
  | {
      kind: "submit";
      order: Omit<AdjustOrder, "id" | "status" | "createdAt" | "basePrice" | "diff">;
    }
  | { kind: "activate"; orderId: string; terminal: TerminalRef; note?: string }
  | { kind: "rollback"; orderId: string; terminal: TerminalRef; reason: string }
  | { kind: "discard"; orderId: string; terminal: TerminalRef }
  | { kind: "init"; terminal: TerminalRef }
  | {
      kind: "migrate";
      terminal: TerminalRef;
      legacyRaw: unknown;
      backupKey: string;
    }
  | {
      kind: "abort";
      terminal: TerminalRef;
      reason: string;
    };

export interface TerminalRef {
  id: string;
  name: string;
}

export interface IntentResult {
  ledger: Ledger;
  // 本次事务产生的日志（activate / rollback 可能包含重算升级日志）
  logs: OperationLog[];
}

// WAL 记录：阶段 intents = 意图已落盘但主台账未更新；applied = 主台账已更新、待清 WAL
export interface WalRecord {
  txId: string;
  terminal: TerminalRef;
  at: string;
  stage: "intents" | "applied";
  intent: Intent;
  baseSeq: number;
  // applied 阶段缓存的新台账，便于崩溃后无需重复重放
  result?: IntentResult;
}
