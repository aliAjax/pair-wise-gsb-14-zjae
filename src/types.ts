/** 台账数据模型：调价单 / 价格快照 / 操作日志 / 预写事务 */

export const LEDGER_VERSION = 1;
export const LEDGER_STORAGE_KEY = "dfwlfront-9-ledger-v1";
export const LEGACY_STORAGE_KEY = "dfwlfront-9-price";
export const TERMINAL_SESSION_KEY = "dfwlfront-9-terminal";

/** 调价单状态 */
export type AdjustmentStatus =
  | "effective" // 已生效：其价格已成为最新挂牌价
  | "pending" // 待生效：同一油品同一时刻只允许一个
  | "conflicted" // 冲突草稿：已有待生效版本占住，暂存等重算
  | "rolledback"; // 已回退

/** 调价单（台账明细） */
export interface Adjustment {
  id: string;
  seq: number;
  fuel: string;
  /** 单据登记的目标挂牌价（冲突草稿重算后会更新） */
  price: number;
  operator: string;
  effectiveDate: string;
  status: AdjustmentStatus;
  notes: string;
  /** 提交终端 */
  terminal: string;
  createdAt: string;
  /** 提交时该油品的挂牌价（无旧价为 null），用于差额展示 */
  basePrice: number | null;
  /** 相对当前最新生效价的差额（迁移/重算时维护） */
  diff: number | null;
  /** 被哪张待生效单挡住（冲突草稿） */
  blockedBy: string | null;
  /** 原始状态文案，迁移自旧台账时原样保留 */
  legacyStatus: string | null;
}

/**
 * 幂等操作计划：事务开始时一次性构建（纯数据，随事务头落盘）。
 * 恢复时不依赖可变内存态重建，直接按 appliedOps 重放剩余步骤。
 */
export type LedgerOp =
  | { kind: "submit-adjustment"; adjustment: Adjustment; conflict: boolean; blockerId: string | null }
  | { kind: "effect-apply"; id: string }
  | { kind: "promote-draft"; id: string }
  | { kind: "transfer-blockers"; fuel: string; fromId: string; toId: string }
  | { kind: "rollback-apply"; id: string; restorePrice: number | null; restoreDate: string | null }
  | { kind: "recalc-apply"; id: string; newPrice: number }
  | { kind: "delete-draft"; id: string };

/** 价格快照：每次生效与调价单、日志一起写入 */
export interface PriceSnapshot {
  fuel: string;
  price: number;
  effectiveDate: string;
  adjustmentId: string;
  at: string;
  terminal: string;
}

/** 操作日志 */
export interface LogEntry {
  id: string;
  seq: number;
  at: string;
  terminal: string;
  kind:
    | "submit"
    | "submit-conflict"
    | "effect"
    | "rollback"
    | "promote"
    | "recalc"
    | "remove-draft"
    | "migrate"
    | "seed"
    | "recover"
    | "salvage";
  fuel: string | null;
  adjustmentId: string | null;
  message: string;
}

/** 提交事务携带的调价单数据（恢复时可确定性重建，不依赖内存态） */
export interface SubmitDraftData {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  createdAt: string;
}

/** 预写事务载荷（纯数据，可序列化、可重放） */
export type TxnPayload =
  | { type: "submit"; terminal: string; draft: SubmitDraftData }
  | { type: "effect"; terminal: string; adjustmentId: string }
  | { type: "rollback"; terminal: string; adjustmentId: string }
  | { type: "recalc"; terminal: string; adjustmentId: string; newPrice?: number }
  | { type: "remove"; terminal: string; adjustmentId: string };

/** 预写事务：先落盘再逐条幂等执行；ops 随头一起持久化，恢复时重放 */
export interface PendingTxn {
  id: string;
  payload: TxnPayload;
  ops: LedgerOp[];
  /** 已完成并落盘的操作序号，恢复时从下一条继续 */
  appliedOps: number;
  startedAt: string;
}

/** 完整台账 */
export interface Ledger {
  version: number;
  seq: number;
  adjustments: Adjustment[];
  snapshots: PriceSnapshot[];
  logs: LogEntry[];
  /** 迁移完成标记 */
  migrated: boolean;
  /** 迁移抢救时保留的无法解析原文 */
  salvageRaw: string | null;
  pendingTxn: PendingTxn | null;
  /** 最近一次从异常写入中恢复的时间戳 */
  lastRecoveredAt: string | null;
}

/** 故障注入配置（用于演示“写入异常后恢复并继续完成”） */
export interface FaultConfig {
  /** 在哪个持久化屏障之后制造写入异常 */
  barrier: number;
  /** 每次步骤之间的延迟（毫秒），方便在中途关闭页面 */
  stepDelayMs: number;
}

/** 存储适配层接口，便于脱离浏览器自测 */
export interface PriceStorage {
  readLedgerRaw(): string | null;
  writeLedgerRaw(raw: string): void;
  readLegacyRaw(): string | null;
  removeLegacy(): void;
}

/** 旧台账记录形态（迁移用） */
export interface LegacyRecord {
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
