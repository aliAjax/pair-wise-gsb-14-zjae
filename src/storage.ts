import {
  LEDGER_STORAGE_KEY,
  LEDGER_VERSION,
  LEGACY_STORAGE_KEY,
  TERMINAL_SESSION_KEY,
  type Ledger,
  type LegacyRecord,
  type PriceStorage,
} from "./types";

/** localStorage 实现的存储适配层 */
export const browserStorage: PriceStorage = {
  readLedgerRaw() {
    return localStorage.getItem(LEDGER_STORAGE_KEY);
  },
  writeLedgerRaw(raw) {
    localStorage.setItem(LEDGER_STORAGE_KEY, raw);
  },
  readLegacyRaw() {
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  },
  removeLegacy() {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  },
};

/** 生成（或复用）当前值班终端标识，跨刷新稳定 */
export function currentTerminalId(): string {
  let id = sessionStorage.getItem(TERMINAL_SESSION_KEY);
  if (!id) {
    id = `终端-${Math.floor(100 + Math.random() * 900)}`;
    sessionStorage.setItem(TERMINAL_SESSION_KEY, id);
  }
  return id;
}

/** 切换为另一台值班终端（多端联调演示用） */
export function resetTerminalId(): string {
  sessionStorage.removeItem(TERMINAL_SESSION_KEY);
  return currentTerminalId();
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyLedger(): Ledger {
  return {
    version: LEDGER_VERSION,
    seq: 0,
    adjustments: [],
    snapshots: [],
    logs: [],
    migrated: false,
    salvageRaw: null,
    pendingTxn: null,
    lastRecoveredAt: null,
  };
}

export function nextSeq(ledger: Ledger): number {
  ledger.seq += 1;
  return ledger.seq;
}

export function makeLogId(): string {
  return genId("log");
}

export function makeTxnId(): string {
  return genId("txn");
}

export function makeAdjustmentId(): string {
  return genId("adj");
}

/**
 * 解析旧台账：直接 JSON.parse 失败时，按数组元素边界做截断抢救，
 * 尽量捞回“写到一半”留下的半份调价记录（最后一个不完整对象丢弃）。
 */
export function parseLegacy(raw: string): {
  records: LegacyRecord[];
  salvaged: boolean;
} {
  try {
    const parsed = JSON.parse(raw);
    return { records: Array.isArray(parsed) ? (parsed as LegacyRecord[]) : [], salvaged: false };
  } catch {
    // 半份 JSON：从后向前回退到最后一个完整对象边界
    const records: LegacyRecord[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            const obj = JSON.parse(raw.slice(start, i + 1));
            if (obj && typeof obj === "object") records.push(obj as LegacyRecord);
          } catch {
            // 单个对象损坏，跳过
          }
          start = -1;
        }
      }
    }
    return { records, salvaged: true };
  }
}

/** 读取并解析当前台账；台账 JSON 自身损坏时，同样按对象边界抢救关键集合 */
export function readLedger(storage: PriceStorage): Ledger {
  const raw = storage.readLedgerRaw();
  if (!raw) return emptyLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    return {
      ...emptyLedger(),
      ...parsed,
      adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    };
  } catch {
    return salvageLedger(raw);
  }
}

function salvageLedger(raw: string): Ledger {
  const ledger = emptyLedger();
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // 忽略无法解析的片段
        }
        start = -1;
      }
    }
  }
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.fuel === "string" && typeof o.price === "number") {
      if (o.adjustmentId) ledger.snapshots.push(obj as Ledger["snapshots"][number]);
    }
    if (typeof o.kind === "string" && typeof o.message === "string") {
      ledger.logs.push(obj as Ledger["logs"][number]);
    }
    if (typeof o.fuel === "string" && typeof o.status === "string" && o.basePrice !== undefined) {
      ledger.adjustments.push(obj as Ledger["adjustments"][number]);
    }
  }
  ledger.salvageRaw = raw;
  ledger.logs.push({
    id: makeLogId(),
    seq: 0,
    at: nowIso(),
    terminal: "system",
    kind: "recover",
    fuel: null,
    adjustmentId: null,
    message: `检测到损坏台账，已抢救调价单 ${ledger.adjustments.length} 条、快照 ${ledger.snapshots.length} 条、日志 ${ledger.logs.length} 条`,
  });
  return ledger;
}

/**
 * 跨标签页（多值班终端）互斥。拿不到锁的终端排队等待，保证提交串行化。
 * 不支持 Web Locks API 的环境退化为立即执行。
 */
export function withTerminalLock<T>(task: () => T | Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    return new Promise<T>((resolve, reject) => {
      try {
        Promise.resolve(task()).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }
  return navigator.locks.request("dfwlfront-9-ledger-write", async () =>
    task(),
  ) as Promise<T>;
}

/** 监听其它终端（标签页）写入的台账变更，返回取消监听函数 */
export function onLedgerStorage(handler: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === LEDGER_STORAGE_KEY || event.key === null) handler();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

export { nowIso, genId, emptyLedger };
