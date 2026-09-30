import {
  LEDGER_VERSION,
  type Adjustment,
  type FaultConfig,
  type Ledger,
  type LedgerOp,
  type LogEntry,
  type PendingTxn,
  type PriceSnapshot,
  type PriceStorage,
  type SubmitDraftData,
  type TxnPayload,
} from "./types";
import {
  makeLogId,
  makeTxnId,
  nextSeq,
  nowIso,
  parseLegacy,
  readLedger,
  withTerminalLock,
} from "./storage";

export class LedgerWriteError extends Error {
  constructor(
    message: string,
    readonly resumable: boolean,
  ) {
    super(message);
    this.name = "LedgerWriteError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatDelta(diff: number | null): string {
  if (diff === null) return "";
  if (diff > 0) return `上调 ${diff.toFixed(2)} 元`;
  if (diff < 0) return `下调 ${Math.abs(diff).toFixed(2)} 元`;
  return "持平";
}

/** 幂等操作：重放时靠内部守卫跳过已完成步骤；计划在事务开始时一次构建并随头落盘 */
type Op = LedgerOp;

function addLog(
  ledger: Ledger,
  entry: Omit<LogEntry, "id" | "seq" | "at"> & { at?: string },
): LogEntry {
  const log: LogEntry = {
    id: makeLogId(),
    seq: nextSeq(ledger),
    at: entry.at ?? nowIso(),
    terminal: entry.terminal,
    kind: entry.kind,
    fuel: entry.fuel,
    adjustmentId: entry.adjustmentId,
    message: entry.message,
  };
  ledger.logs.push(log);
  return log;
}

/** 某油品当前最新生效挂牌价（取最后一张快照） */
export function latestEffectivePrice(
  ledger: Pick<Ledger, "snapshots">,
  fuel: string,
): number | null {
  for (let i = ledger.snapshots.length - 1; i >= 0; i -= 1) {
    const snapshot = ledger.snapshots[i];
    if (snapshot.fuel === fuel) return snapshot.price;
  }
  return null;
}

/** 某油品当前占用“待生效”槽位的单据（同一油品只接受一个待生效版本） */
export function pendingOf(
  ledger: Pick<Ledger, "adjustments">,
  fuel: string,
): Adjustment | undefined {
  return ledger.adjustments.find((a) => a.fuel === fuel && a.status === "pending");
}

function conflictedQueue(ledger: Ledger, fuel: string): Adjustment[] {
  return ledger.adjustments
    .filter((a) => a.fuel === fuel && a.status === "conflicted")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
}

/** 差额始终按最新生效价重算（列表/汇总/待处理统一口径） */
function refreshDiff(ledger: Ledger, adjustment: Adjustment): void {
  const current = latestEffectivePrice(ledger, adjustment.fuel);
  adjustment.basePrice = current;
  adjustment.diff = current === null ? adjustment.price : round2(adjustment.price - current);
}

const SEED: Array<{
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  legacyStatus: string;
  notes: string;
}> = [
  { fuel: "92号汽油", price: 7.62, operator: "站长", effectiveDate: "2026-06-30", legacyStatus: "生效中", notes: "正常调价" },
  { fuel: "柴油", price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30", legacyStatus: "待确认", notes: "等待复核" },
];

export class LedgerEngine {
  constructor(
    private storage: PriceStorage,
    private fault: FaultConfig | null = null,
  ) {}

  setFault(fault: FaultConfig | null) {
    this.fault = fault;
  }

  /** 首次打开：读台账 → 迁移旧数据 / 播种 → 返回内存态 */
  init(): Ledger {
    let ledger = readLedger(this.storage);
    const legacyRaw = this.storage.readLegacyRaw();

    if (legacyRaw !== null && !ledger.migrated) {
      ledger = this.migrate(ledger, legacyRaw);
      this.commit(ledger);
    } else if (
      ledger.adjustments.length === 0 &&
      ledger.snapshots.length === 0 &&
      !ledger.migrated
    ) {
      this.seed(ledger);
      this.commit(ledger);
    }

    if (ledger.salvageRaw) {
      ledger.salvageRaw = null;
      this.commit(ledger);
    }
    return ledger;
  }

  /** 旧台账一次性迁移：记录、原始状态、备注原样保留，仅补全新台账所需字段 */
  private migrate(ledger: Ledger, raw: string): Ledger {
    const { records, salvaged } = parseLegacy(raw);
    const ordered = [...records].sort((a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
    );

    ordered.forEach((rawRecord, index) => {
      const fuel = typeof rawRecord.fuel === "string" ? rawRecord.fuel : "未知油品";
      const price = Number(rawRecord.price);
      const legacyStatus = typeof rawRecord.status === "string" ? rawRecord.status : "待确认";
      let status = mapLegacyStatus(legacyStatus);
      const base = latestEffectivePrice(ledger, fuel);
      const createdAt =
        typeof rawRecord.createdAt === "string" && !Number.isNaN(Date.parse(rawRecord.createdAt))
          ? rawRecord.createdAt
          : new Date(Date.now() - (ordered.length - index) * 86400000).toISOString();

      // 同一油品旧台账里若有多张待确认，只保留第一张占槽，其余转为冲突草稿，原状态文案照留
      let blockedBy: string | null = null;
      if (status === "pending" && pendingOf(ledger, fuel)) {
        status = "conflicted";
        blockedBy = pendingOf(ledger, fuel)!.id;
      }

      const adjustment: Adjustment = {
        id: typeof rawRecord.id === "string" && rawRecord.id ? rawRecord.id : `legacy-${Date.now().toString(36)}-${index}`,
        seq: nextSeq(ledger),
        fuel,
        price: Number.isFinite(price) ? price : 0,
        operator: typeof rawRecord.operator === "string" ? rawRecord.operator : "旧台账",
        effectiveDate: typeof rawRecord.effectiveDate === "string" ? rawRecord.effectiveDate : "",
        status,
        notes: typeof rawRecord.notes === "string" && rawRecord.notes ? rawRecord.notes : "（旧数据无备注）",
        terminal: "旧台账",
        createdAt,
        basePrice: base,
        diff: base === null ? (Number.isFinite(price) ? price : null) : round2(price - base),
        blockedBy,
        legacyStatus,
      };
      ledger.adjustments.push(adjustment);

      if (status === "effective") {
        ledger.snapshots.push({
          fuel,
          price: adjustment.price,
          effectiveDate: adjustment.effectiveDate,
          adjustmentId: adjustment.id,
          at: createdAt,
          terminal: "旧台账",
        });
      }
    });

    ledger.migrated = true;
    if (salvaged) {
      addLog(ledger, {
        terminal: "system",
        kind: "salvage",
        fuel: null,
        adjustmentId: null,
        message: `旧台账文件不完整（疑似上次写入中断），已抢救并迁移 ${records.length} 条记录，原状态与备注均保留`,
      });
    }
    addLog(ledger, {
      terminal: "system",
      kind: "migrate",
      fuel: null,
      adjustmentId: null,
      message: `旧台账已迁移至新多端台账：共 ${records.length} 条调价记录，原记录、状态与备注均原样保留（旧数据保留在原存储键中作为备份）`,
    });
    return ledger;
  }

  private seed(ledger: Ledger) {
    for (const item of SEED) {
      const base = latestEffectivePrice(ledger, item.fuel);
      const adjustment: Adjustment = {
        id: `seed-${item.fuel}`,
        seq: nextSeq(ledger),
        fuel: item.fuel,
        price: item.price,
        operator: item.operator,
        effectiveDate: item.effectiveDate,
        status: item.legacyStatus === "生效中" ? "effective" : "pending",
        notes: item.notes,
        terminal: "系统初始",
        createdAt: nowIso(),
        basePrice: base,
        diff: base === null ? item.price : round2(item.price - base),
        blockedBy: null,
        legacyStatus: item.legacyStatus,
      };
      ledger.adjustments.push(adjustment);
      if (adjustment.status === "effective") {
        ledger.snapshots.push({
          fuel: item.fuel,
          price: item.price,
          effectiveDate: item.effectiveDate,
          adjustmentId: adjustment.id,
          at: adjustment.createdAt,
          terminal: "系统初始",
        });
      }
    }
    ledger.migrated = true;
    addLog(ledger, {
      terminal: "system",
      kind: "seed",
      fuel: null,
      adjustmentId: null,
      message: "初始化示例台账：92号汽油已生效、柴油待确认",
    });
  }

  /**
   * 提交一笔事务：先落预写事务头，再逐条执行（操作日志与价格快照同屏写入），
   * 每个屏障点持久化，全部完成后摘除事务头。全程跨终端互斥，锁内重读最新台账判定冲突。
   */
  async runTxn(payload: TxnPayload): Promise<{ conflicted: boolean }> {
    return withTerminalLock(async () => {
      const ledger = readLedger(this.storage);
      if (ledger.pendingTxn) {
        throw new LedgerWriteError("台账存在未完成的写入，请先恢复后再操作", true);
      }
      const ops = this.buildOps(ledger, payload);
      const txn: PendingTxn = {
        id: makeTxnId(),
        payload,
        ops,
        appliedOps: 0,
        startedAt: nowIso(),
      };
      ledger.pendingTxn = txn;
      await this.persistStep(ledger, 1); // 屏障1：事务头（含完整操作计划）先落盘

      for (let i = 0; i < ops.length; i += 1) {
        if (this.fault) await sleep(this.fault.stepDelayMs);
        // 屏障语义：barrier = N 表示“执行第 N 步之前”存储异常（前 N-1 步已落盘）
        await this.persistStep(ledger, i + 2);
        this.applyOp(ledger, ops[i]);
        txn.appliedOps = i + 1;
        this.commit(ledger);
      }

      ledger.pendingTxn = null;
      this.commit(ledger); // 提交点：摘除事务头
      return {
        conflicted: ops.some((op) => op.kind === "submit-adjustment" && op.conflict),
      };
    });
  }

  /**
   * 从异常中断恢复：操作计划已随事务头落盘，直接从 appliedOps 断点重放，
   * 不依赖可能已被部分推进的磁盘态重建，保证恢复结果与一次成功提交完全一致。
   */
  async recover(): Promise<{ resumed: boolean; done: number; total: number; message: string }> {
    return withTerminalLock(async () => {
      const ledger = readLedger(this.storage);
      const txn = ledger.pendingTxn;
      if (!txn) return { resumed: false, done: 0, total: 0, message: "没有待恢复的写入" };

      const ops = txn.ops;
      const already = Math.min(txn.appliedOps, ops.length);
      const remaining = ops.slice(already);
      for (const op of remaining) {
        if (this.fault) await sleep(this.fault.stepDelayMs);
        this.applyOp(ledger, op);
        txn.appliedOps = Math.min(txn.appliedOps + 1, ops.length);
        this.commit(ledger);
      }
      ledger.pendingTxn = null;
      ledger.lastRecoveredAt = nowIso();
      addLog(ledger, {
        terminal: txn.payload.terminal,
        kind: "recover",
        fuel: null,
        adjustmentId: "adjustmentId" in txn.payload ? txn.payload.adjustmentId : null,
        message: `检测到写入中断，已从事务 ${txn.id} 断点（${already}/${ops.length}）继续，剩余 ${remaining.length} 步已补写完成`,
      });
      this.commit(ledger);
      return {
        resumed: true,
        done: ops.length,
        total: ops.length,
        message: `未完成写入已恢复：补做 ${remaining.length} 个步骤，调价单、操作日志与价格快照全部入账`,
      };
    });
  }

  /** 只读视角：当前磁盘台账是否存在中断事务 */
  hasPendingTxn(ledger: Ledger): boolean {
    return ledger.pendingTxn !== null;
  }

  private async persistStep(ledger: Ledger, barrier: number) {
    if (this.fault && this.fault.barrier === barrier) {
      throw new LedgerWriteError(
        `写入在第 ${barrier} 步发生存储异常（故障演练）。预写事务与操作日志已保留，点击“恢复写入”即可从断点继续完成`,
        true,
      );
    }
    this.commit(ledger);
  }

  private commit(ledger: Ledger) {
    this.storage.writeLedgerRaw(JSON.stringify(ledger));
  }

  private buildOps(ledger: Ledger, payload: TxnPayload): Op[] {
    switch (payload.type) {
      case "submit":
        return [this.buildSubmit(ledger, payload)];
      case "effect":
        return this.buildEffect(ledger, payload);
      case "rollback":
        return this.buildRollback(ledger, payload);
      case "recalc":
        return this.buildRecalc(ledger, payload);
      case "remove":
        return [{ kind: "delete-draft", id: payload.adjustmentId }];
    }
  }

  private buildSubmit(ledger: Ledger, payload: Extract<TxnPayload, { type: "submit" }>): Op {
    const data: SubmitDraftData = payload.draft;
    // 以磁盘最新状态判定（锁内重读，确保看到其它终端先到的单子）
    const blocker = pendingOf(ledger, data.fuel);
    const base = latestEffectivePrice(ledger, data.fuel);
    const adjustment: Adjustment = {
      id: data.id,
      seq: nextSeq(ledger),
      fuel: data.fuel,
      price: data.price,
      operator: data.operator,
      effectiveDate: data.effectiveDate,
      status: blocker ? "conflicted" : "pending",
      notes: data.notes,
      terminal: payload.terminal,
      createdAt: data.createdAt,
      basePrice: base,
      diff: base === null ? data.price : round2(data.price - base),
      blockedBy: blocker ? blocker.id : null,
      legacyStatus: null,
    };
    return {
      kind: "submit-adjustment",
      adjustment,
      conflict: Boolean(blocker),
      blockerId: blocker ? blocker.id : null,
    };
  }

  private buildEffect(ledger: Ledger, payload: Extract<TxnPayload, { type: "effect" }>): Op[] {
    const id = payload.adjustmentId;
    const target = ledger.adjustments.find((a) => a.id === id);
    if (!target || target.status !== "pending") {
      throw new LedgerWriteError("该单据不是待生效状态，无法生效", false);
    }
    const ops: Op[] = [{ kind: "effect-apply", id }];

    // 生效后：队首冲突草稿按新挂牌价重算差额并递补（保留草稿原报价），其余转挂
    const queue = conflictedQueue(ledger, target.fuel).filter((d) => d.blockedBy === id);
    const oldest = queue[0];
    if (oldest) {
      ops.push({ kind: "promote-draft", id: oldest.id });
      if (queue.length > 1) {
        ops.push({ kind: "transfer-blockers", fuel: target.fuel, fromId: id, toId: oldest.id });
      }
    }
    return ops;
  }

  private buildRollback(ledger: Ledger, payload: Extract<TxnPayload, { type: "rollback" }>): Op[] {
    const id = payload.adjustmentId;
    const target = ledger.adjustments.find((a) => a.id === id);
    if (!target || target.status !== "effective") {
      throw new LedgerWriteError("只有已生效单据可以回退", false);
    }
    // 恢复到该单据生效快照之前的同油品价格
    const ownIndex = ledger.snapshots.findIndex((s) => s.adjustmentId === id);
    let restorePrice: number | null = null;
    let restoreDate: string | null = null;
    if (ownIndex >= 0) {
      for (let i = ownIndex - 1; i >= 0; i -= 1) {
        const s = ledger.snapshots[i];
        if (s.fuel === target.fuel) {
          restorePrice = s.price;
          restoreDate = s.effectiveDate;
          break;
        }
      }
    }
    return [{ kind: "rollback-apply", id, restorePrice, restoreDate }];
  }

  private buildRecalc(ledger: Ledger, payload: Extract<TxnPayload, { type: "recalc" }>): Op[] {
    const draft = ledger.adjustments.find((a) => a.id === payload.adjustmentId);
    if (!draft || draft.status !== "conflicted") {
      throw new LedgerWriteError("只有冲突草稿可以重算提交", false);
    }
    if (pendingOf(ledger, draft.fuel)) {
      throw new LedgerWriteError("该油品仍有待生效版本占用，请等其生效后再提交", false);
    }
    // 默认保留草稿原报价、仅按最新挂牌价重算差额；也允许终端改价后提交
    const newPrice = payload.newPrice ?? draft.price;
    return [{ kind: "recalc-apply", id: draft.id, newPrice }];
  }

  private applyOp(ledger: Ledger, op: Op) {
    switch (op.kind) {
      case "submit-adjustment":
        this.applySubmit(ledger, op);
        break;
      case "effect-apply":
        this.applyEffect(ledger, op.id);
        break;
      case "promote-draft":
        this.applyPromote(ledger, op.id);
        break;
      case "transfer-blockers":
        this.applyTransfer(ledger, op);
        break;
      case "rollback-apply":
        this.applyRollback(ledger, op);
        break;
      case "recalc-apply":
        this.applyRecalc(ledger, op);
        break;
      case "delete-draft":
        this.applyDeleteDraft(ledger, op.id);
        break;
    }
  }

  private applySubmit(ledger: Ledger, op: Extract<Op, { kind: "submit-adjustment" }>) {
    const a = op.adjustment;
    const existing = ledger.adjustments.find((item) => item.id === a.id);
    if (existing) {
      // 重放守卫：已写入则幂等补齐，不重复记账
      Object.assign(existing, a);
      return;
    }
    ledger.adjustments.unshift(a);
    if (op.conflict) {
      const blocker = ledger.adjustments.find((b) => b.id === op.blockerId);
      addLog(ledger, {
        terminal: a.terminal,
        kind: "submit-conflict",
        fuel: a.fuel,
        adjustmentId: a.id,
        message: `${a.terminal} 提交 ${a.fuel} 调价单（报价 ${a.price} 元）时，已有待生效版本${blocker ? `（${blocker.price} 元）` : ""}占用该油品槽位，本单先留为冲突草稿；待前序版本生效后按新挂牌价重算差额再提交`,
      });
    } else {
      addLog(ledger, {
        terminal: a.terminal,
        kind: "submit",
        fuel: a.fuel,
        adjustmentId: a.id,
        message: `${a.terminal} 提交 ${a.fuel} 调价单：目标挂牌价 ${a.price} 元，列为待生效${a.basePrice === null ? "" : `，较当前生效价 ${a.basePrice} 元 ${formatDelta(a.diff)}`}`,
      });
    }
  }

  private applyEffect(ledger: Ledger, id: string) {
    const target = ledger.adjustments.find((a) => a.id === id);
    if (!target || target.status !== "pending") return; // 幂等守卫
    target.status = "effective";
    target.basePrice = latestEffectivePrice(ledger, target.fuel);
    target.diff = target.basePrice === null ? null : round2(target.price - target.basePrice);
    target.blockedBy = null;

    // 操作日志与价格快照在同一屏障一起写入
    const snapshot: PriceSnapshot = {
      fuel: target.fuel,
      price: target.price,
      effectiveDate: target.effectiveDate,
      adjustmentId: target.id,
      at: nowIso(),
      terminal: target.terminal,
    };
    ledger.snapshots.push(snapshot);
    addLog(ledger, {
      terminal: target.terminal,
      kind: "effect",
      fuel: target.fuel,
      adjustmentId: target.id,
      message: `${target.fuel} 新挂牌价 ${target.price} 元生效（${target.effectiveDate || "立即执行"}），价格快照已与操作日志一并入账`,
    });

    for (const other of ledger.adjustments) {
      if (other.fuel === target.fuel && other.id !== target.id) refreshDiff(ledger, other);
    }
  }

  private applyPromote(ledger: Ledger, id: string) {
    const draft = ledger.adjustments.find((a) => a.id === id);
    if (!draft || draft.status !== "conflicted") return; // 幂等守卫
    const base = latestEffectivePrice(ledger, draft.fuel);
    draft.basePrice = base;
    draft.diff = base === null ? draft.price : round2(draft.price - base);
    draft.status = "pending";
    draft.blockedBy = null;
    addLog(ledger, {
      terminal: draft.terminal,
      kind: "recalc",
      fuel: draft.fuel,
      adjustmentId: draft.id,
      message: `前序版本已生效，冲突草稿保留原报价 ${draft.price} 元，已按最新挂牌价${base === null ? "" : ` ${base} 元`}重新计算差额（${formatDelta(draft.diff)}）并自动递补为待生效`,
    });
  }

  private applyTransfer(ledger: Ledger, op: Extract<Op, { kind: "transfer-blockers" }>) {
    let moved = 0;
    for (const draft of ledger.adjustments) {
      if (draft.fuel === op.fuel && draft.status === "conflicted" && draft.blockedBy === op.fromId) {
        draft.blockedBy = op.toId;
        moved += 1;
      }
    }
    if (moved > 0) {
      addLog(ledger, {
        terminal: "system",
        kind: "promote",
        fuel: op.fuel,
        adjustmentId: op.toId,
        message: `另有 ${moved} 张冲突草稿继续排队，阻塞关系已转挂至新的待生效单据`,
      });
    }
  }

  private applyRollback(ledger: Ledger, op: Extract<Op, { kind: "rollback-apply" }>) {
    const target = ledger.adjustments.find((a) => a.id === op.id);
    if (!target || target.status !== "effective") return; // 幂等守卫
    target.status = "rolledback";
    target.blockedBy = null;
    if (op.restorePrice !== null) {
      ledger.snapshots.push({
        fuel: target.fuel,
        price: op.restorePrice,
        effectiveDate: op.restoreDate ?? "",
        adjustmentId: `${target.id}:rollback`,
        at: nowIso(),
        terminal: target.terminal,
      });
    }
    addLog(ledger, {
      terminal: target.terminal,
      kind: "rollback",
      fuel: target.fuel,
      adjustmentId: target.id,
      message:
        op.restorePrice === null
          ? `${target.fuel} 调价单 ${target.price} 元已回退，该油品暂无生效挂牌价`
          : `${target.fuel} 调价单已回退，挂牌价恢复为 ${op.restorePrice} 元，恢复快照已与日志一并入账`,
    });
    for (const other of ledger.adjustments) {
      if (other.fuel === target.fuel && other.id !== target.id) refreshDiff(ledger, other);
    }
  }

  private applyRecalc(ledger: Ledger, op: Extract<Op, { kind: "recalc-apply" }>) {
    const draft = ledger.adjustments.find((a) => a.id === op.id);
    if (!draft || draft.status !== "conflicted") return;
    if (pendingOf(ledger, draft.fuel)) return; // 槽位仍被占用则保持草稿
    draft.price = op.newPrice;
    const base = latestEffectivePrice(ledger, draft.fuel);
    draft.basePrice = base;
    draft.diff = base === null ? op.newPrice : round2(op.newPrice - base);
    draft.status = "pending";
    draft.blockedBy = null;
    addLog(ledger, {
      terminal: draft.terminal,
      kind: "recalc",
      fuel: draft.fuel,
      adjustmentId: draft.id,
      message: `冲突草稿按最新挂牌价${base === null ? "" : ` ${base} 元`}重算差额后提交：目标价 ${op.newPrice} 元（${formatDelta(draft.diff)}），列为待生效`,
    });
  }

  private applyDeleteDraft(ledger: Ledger, id: string) {
    const target = ledger.adjustments.find((a) => a.id === id);
    if (!target || (target.status !== "conflicted" && target.status !== "pending")) return;
    const wasPending = target.status === "pending";
    const fuel = target.fuel;
    ledger.adjustments = ledger.adjustments.filter((a) => a.id !== id);
    addLog(ledger, {
      terminal: target.terminal,
      kind: "remove-draft",
      fuel,
      adjustmentId: id,
      message: `${fuel} ${wasPending ? "待生效" : "冲突草稿"}单据（报价 ${target.price} 元）已删除`,
    });
    // 删掉占槽单据后，队首冲突草稿自动按最新生效价重算递补，其余转挂
    if (wasPending) {
      const oldest = conflictedQueue(ledger, fuel)[0];
      if (oldest) {
        this.applyPromote(ledger, oldest.id);
        const rest = conflictedQueue(ledger, fuel).filter((d) => d.blockedBy === id);
        if (rest.length > 0) {
          this.applyTransfer(ledger, { kind: "transfer-blockers", fuel, fromId: id, toId: oldest.id });
        }
      }
    }
  }
}

export function mapLegacyStatus(text: string): Adjustment["status"] {
  if (/回退|作废|失效|撤销/.test(text)) return "rolledback";
  if (/生效|有效|启用/.test(text)) return "effective";
  if (/待|确认|审核|复核/.test(text)) return "pending";
  return "pending";
}
