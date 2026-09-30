import { applyIntent, createEmptyLedger, initLedger, migrateLegacy, uid } from "./engine";
import type { Intent, IntentResult, Ledger, TerminalRef, WalRecord } from "./types";

// ---------------------------------------------------------------------------
// 存储键
// ---------------------------------------------------------------------------

const LEDGER_KEY = "dfwlfront-9-ledger-v1";
const WAL_KEY = "dfwlfront-9-ledger-wal-v1";
const LEGACY_KEY = "dfwlfront-9-price";
const TERMINAL_KEY = "dfwlfront-9-terminal-v1";

// WAL 超过该毫秒数仍停留在 intents/applied 阶段，视为持有者已崩溃
const WAL_STALE_MS = 4000;
const COMMIT_RETRIES = 40;
const RETRY_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// 终端身份：每个值班终端（浏览器标签）固定一个 id，可修改值班名称
// ---------------------------------------------------------------------------

export function loadTerminal(): TerminalRef {
  const raw = localStorage.getItem(TERMINAL_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TerminalRef>;
      if (parsed.id && parsed.name) return { id: String(parsed.id), name: String(parsed.name) };
    } catch {
      // 身份文件损坏时重新签发
    }
  }
  const terminal: TerminalRef = {
    id: uid("term"),
    name: `值班终端-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
  };
  localStorage.setItem(TERMINAL_KEY, JSON.stringify(terminal));
  return terminal;
}

export function saveTerminalName(name: string): void {
  const current = loadTerminal();
  localStorage.setItem(TERMINAL_KEY, JSON.stringify({ ...current, name }));
}

// ---------------------------------------------------------------------------
// 故障注入：写入异常演练 / 自动化测试使用（生产路径不调用）
// ---------------------------------------------------------------------------

type FaultHook = (stage: "wal" | "ledger", attempt: number) => boolean;
let faultHook: FaultHook | null = null;

export function setFaultHook(hook: FaultHook | null): void {
  faultHook = hook;
}

function rawGet(key: string): string | null {
  return localStorage.getItem(key);
}

function rawSet(key: string, value: string, stage: "wal" | "ledger", attempt: number): void {
  if (faultHook?.(stage, attempt)) {
    throw new DOMException(`模拟写入异常（${stage} 阶段第 ${attempt + 1} 次写入失败）`, "QuotaExceededError");
  }
  localStorage.setItem(key, value);
}

function readLedger(): Ledger | null {
  const raw = rawGet(LEDGER_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Ledger;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.orders) || !Array.isArray(parsed.logs)) {
    throw new Error("台账文件格式校验失败");
  }
  return parsed;
}

function writeLedger(ledger: Ledger, attempt = 0): void {
  rawSet(LEDGER_KEY, JSON.stringify(ledger), "ledger", attempt);
}

function readWal(): WalRecord | null {
  const raw = rawGet(WAL_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WalRecord;
  } catch {
    // WAL 损坏无法解析：视为已失效的残留，交由调用方清理
    return null;
  }
}

function writeWal(record: WalRecord, attempt = 0): void {
  rawSet(WAL_KEY, JSON.stringify(record), "wal", attempt);
}

function clearWal(): void {
  localStorage.removeItem(WAL_KEY);
}

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  recovered: number;
  details: string[];
}

function snapshotEntries(ledger: Ledger) {
  return Object.values(ledger.board)
    .sort((a, b) => a.fuel.localeCompare(b.fuel, "zh-Hans-CN"))
    .map((entry) => ({
      fuel: entry.fuel,
      price: entry.price,
      effectiveOrderId: entry.effectiveOrderId,
      source: entry.source,
    }));
}

function appendRecoverLog(ledger: Ledger, wal: WalRecord, detail: string): Ledger {
  const next = structuredClone(ledger);
  next.logs = [
    {
      id: uid("log"),
      txId: wal.txId,
      action: "recover",
      terminalId: wal.terminal.id,
      terminalName: wal.terminal.name,
      at: new Date().toISOString(),
      detail,
      snapshot: snapshotEntries(next),
    },
    ...next.logs,
  ];
  return next;
}

/**
 * 检查 WAL：
 *  - intents：意图已落盘、主台账不确定是否更新 → 去重后补提交；
 *  - applied：结果已算出并落 WAL → 直接把缓存结果写回主台账。
 * 恢复完成后清除 WAL，保证「写入异常后继续完成」。
 *
 * @param ignoreStale 调用方确认 WAL 归自己所有（同一次提交的 catch 分支）时，
 *                    跳过失活等待立即接管。
 */
function recoverIfNeeded(report: RecoveryReport, ignoreStale = false): Ledger {
  let ledger = readLedger();
  const wal = readWal();
  if (!wal) {
    if (!ledger) throw new Error("台账与日志均缺失");
    return ledger;
  }

  const age = Date.now() - new Date(wal.at).getTime();
  const stale = ignoreStale || !Number.isFinite(age) || age > WAL_STALE_MS;
  // storage 事件会在 WAL 出现时立即触发本函数；只有确认对方失活才接管
  if (!stale) {
    if (!ledger) throw new Error("台账缺失且存在未决写入");
    return ledger;
  }

  const alreadyApplied =
    ledger?.logs.some((log) => log.txId === wal.txId) ?? false;

  if (alreadyApplied) {
    // 主台账已写入，只是没来得及清 WAL
    clearWal();
    report.recovered += 1;
    report.details.push(`清理事务 ${wal.txId.slice(-6)} 的完成态日志残留`);
    return ledger as Ledger;
  }

  if (!ledger) ledger = createEmptyLedger();

  let recovered: Ledger;
  if (wal.stage === "applied" && wal.result) {
    // 结果已完整缓存在 WAL，直接落盘，无需重新推演
    recovered = wal.result.ledger;
    recovered = appendRecoverLog(recovered, wal, "检测到上次写入在提交台账前中断，已依据预写日志补全价格快照与操作日志");
  } else {
    // intents 阶段：按原意图重新执行（纯函数、幂等去重由 txId 保证）
    const result: IntentResult = applyIntent(ledger, wal.intent);
    recovered = result.ledger;
    recovered = appendRecoverLog(recovered, wal, "检测到上次写入在台账提交前中断，已按预写日志中的调价意图恢复并完成提交");
  }

  recovered.seq += 1;
  writeLedger(recovered);
  clearWal();
  report.recovered += 1;
  report.details.push(`事务 ${wal.txId.slice(-6)}（${wal.intent.kind}）已恢复完成`);
  return recovered;
}

// ---------------------------------------------------------------------------
// 提交：WAL 两阶段 + 冲突等待 + 异常重试
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CommitBusyError extends Error {
  constructor() {
    super("另一台值班终端正在写入台账，请稍后自动重试");
    this.name = "CommitBusyError";
  }
}

/**
 * 多端互斥提交：
 * 1. 先恢复任何失活终端留下的半成品事务；
 * 2. 占用 WAL 槽（相当于短事务锁），被占用则退避重试；
 * 3. intents → 纯函数推演 → applied 缓存 → 主台账一次性落盘 → 清 WAL。
 * 任何一步抛错都会在下次调用 / 页面打开时依据 WAL 继续完成。
 */
export async function commit(intent: Intent, report?: RecoveryReport): Promise<Ledger> {
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    // 每轮先看看要不要接管崩溃现场
    let ledger = readLedger();
    const staleWal = readWal();
    if (staleWal) {
      const age = Date.now() - new Date(staleWal.at).getTime();
      if (Number.isFinite(age) && age > WAL_STALE_MS) {
        ledger = recoverIfNeeded(report ?? { recovered: 0, details: [] });
      } else {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
    if (!ledger) throw new Error("台账尚未初始化");

    const txId = uid("tx");
    const terminal: TerminalRef =
      "terminal" in intent ? intent.terminal : intent.kind === "submit"
        ? { id: intent.order.terminalId, name: intent.order.terminalName }
        : { id: "system", name: "系统" };

    const walRecord: WalRecord = {
      txId,
      terminal,
      at: new Date().toISOString(),
      stage: "intents",
      intent,
      baseSeq: ledger.seq,
    };

    try {
      writeWal(walRecord, attempt);
    } catch {
      // WAL 写不进去（如配额/瞬时异常）：本轮什么都没改，退避重试
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    try {
      const result = applyIntent(readLedger() ?? ledger, intent);
      if (result.logs.length === 0) {
        // 业务条件不成立（如单据状态已被其他端改变）：放弃该事务
        clearWal();
        return readLedger() ?? ledger;
      }

      // 把 txId 改写进本次产生的日志，确保与 WAL 一一对应、可幂等识别
      for (const log of result.logs) log.txId = txId;

      const appliedWal: WalRecord = { ...walRecord, stage: "applied", at: new Date().toISOString(), result };
      writeWal(appliedWal, attempt);
      writeLedger(result.ledger, attempt);
      clearWal();
      return result.ledger;
    } catch (error) {
      // 推演 / 落盘中途失败（含页面被杀、配额异常）：保留 WAL，等待恢复继续完成。
      // 同进程内立即退避后由恢复路径接管，尽量在本次操作中跑完。
      console.warn("[ledger] 提交中断，将依据预写日志恢复后继续：", error);
      await sleep(RETRY_DELAY_MS);
      try {
        const recovered = recoverIfNeeded(report ?? { recovered: 0, details: [] }, true);
        return recovered;
      } catch (recoverError) {
        console.warn("[ledger] 恢复未成功，稍后重试：", recoverError);
      }
    }
  }
  throw new CommitBusyError();
}

// ---------------------------------------------------------------------------
// 启动引导：恢复 → 迁移旧数据 → 初始化
// ---------------------------------------------------------------------------

export interface BootResult {
  ledger: Ledger;
  recovery: RecoveryReport;
  migrated: boolean;
}

export async function boot(terminal: TerminalRef): Promise<BootResult> {
  const recovery: RecoveryReport = { recovered: 0, details: [] };

  // 1. 台账存在：恢复可能存在的半成品事务（文件损坏时退回空台账重建，避免白屏）
  let existing: Ledger | null = null;
  try {
    existing = readLedger();
  } catch (error) {
    console.warn("[ledger] 台账文件无法解析，将尝试依据预写日志或旧数据重建：", error);
    recovery.recovered += 1;
    recovery.details.push("台账文件损坏，已依据预写日志 / 旧版数据重建");
  }

  if (existing) {
    const wal = readWal();
    if (wal && Date.now() - new Date(wal.at).getTime() > WAL_STALE_MS) {
      return { ledger: recoverIfNeeded(recovery), recovery, migrated: false };
    }
    return { ledger: existing, recovery, migrated: false };
  }

  // 台账缺失或损坏：WAL 存在则先恢复
  if (readWal()) {
    return { ledger: recoverIfNeeded(recovery), recovery, migrated: false };
  }

  // 2. 首次打开：旧数据优先迁移，原有记录、状态、备注全部保留
  const legacyRaw = rawGet(LEGACY_KEY);
  if (legacyRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacyRaw);
    } catch {
      parsed = null;
    }
    const empty = createEmptyLedger();
    const result = parsed ? migrateLegacy(empty, parsed, terminal) : initLedger(terminal);
    writeLedger(result.ledger);
    return { ledger: result.ledger, recovery, migrated: true };
  }

  // 3. 全新环境：写入默认挂牌价
  const initialized = initLedger(terminal);
  writeLedger(initialized.ledger);
  return { ledger: initialized.ledger, recovery, migrated: false };
}

export function snapshotRead(): Ledger | null {
  return readLedger();
}
