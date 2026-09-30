import { LedgerEngine, LedgerWriteError, latestEffectivePrice, pendingOf } from "../src/engine";
import { LEDGER_STORAGE_KEY, LEGACY_STORAGE_KEY, type PriceStorage, type TxnPayload } from "../src/types";

interface MemoryStore {
  [key: string]: string;
}

function makeStorage(seed?: Record<string, string>): PriceStorage & { dump: () => MemoryStore } {
  const mem: MemoryStore = seed ? { ...seed } : {};
  return {
    readLedgerRaw: () => mem[LEDGER_STORAGE_KEY] ?? null,
    writeLedgerRaw: (raw) => {
      mem[LEDGER_STORAGE_KEY] = raw;
    },
    readLegacyRaw: () => mem[LEGACY_STORAGE_KEY] ?? null,
    removeLegacy: () => {
      delete mem[LEGACY_STORAGE_KEY];
    },
    dump: () => mem,
  };
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function draft(id: string, fuel: string, price: number, terminal: string, notes = "备注"): TxnPayload {
  return {
    type: "submit",
    terminal,
    draft: {
      id,
      fuel,
      price,
      operator: terminal,
      effectiveDate: "2026-10-01",
      notes,
      createdAt: new Date().toISOString(),
    },
  };
}

// ---------- 场景1：两台终端同时提交同油品，后到留冲突稿；生效后自动重算递补 ----------
async function scenario1() {
  console.log("\n[场景1] 多端提交：一油一待生效 + 冲突排队 + 生效后重算递补");
  const storage = makeStorage();
  const engine = new LedgerEngine(storage, null);
  engine.init();

  await engine.runTxn(draft("a1", "95号汽油", 8.20, "终端-A", "A先到"));
  const r2 = await engine.runTxn(draft("a2", "95号汽油", 8.35, "终端-B", "B后到"));
  check("后到终端返回冲突标记", r2.conflicted === true);

  let ledger = JSON.parse(storage.readLedgerRaw()!);
  const a1 = ledger.adjustments.find((x: any) => x.id === "a1");
  const a2 = ledger.adjustments.find((x: any) => x.id === "a2");
  check("先到单据为待生效", a1.status === "pending");
  check("后到单据留为冲突草稿", a2.status === "conflicted", `实际 ${a2.status}`);
  check("冲突稿记录阻塞来源", a2.blockedBy === "a1");
  check("同油品只有一个待生效", ledger.adjustments.filter((x: any) => x.fuel === "95号汽油" && x.status === "pending").length === 1);
  check("冲突操作日志已写入", ledger.logs.some((l: any) => l.kind === "submit-conflict"));
  check("提交前无快照", latestEffectivePrice(ledger, "95号汽油") === null);

  // 第三台终端再提一张，继续排队
  await engine.runTxn(draft("a3", "95号汽油", 8.50, "终端-C", "C第三个"));
  ledger = JSON.parse(storage.readLedgerRaw()!);
  const a3 = ledger.adjustments.find((x: any) => x.id === "a3");
  check("第三张同样为冲突草稿", a3.status === "conflicted" && a3.blockedBy === "a1");

  // a1 生效：快照+日志写入；a2 自动按新价重算差额递补，a3 转挂 a2
  await engine.runTxn({ type: "effect", terminal: "终端-A", adjustmentId: "a1" });
  ledger = JSON.parse(storage.readLedgerRaw()!);
  check("生效价快照写入为 8.20", latestEffectivePrice(ledger, "95号汽油") === 8.2);
  const a2b = ledger.adjustments.find((x: any) => x.id === "a2");
  const a3b = ledger.adjustments.find((x: any) => x.id === "a3");
  check("a2 自动递补为待生效", a2b.status === "pending");
  check("a2 保留原报价 8.35", a2b.price === 8.35);
  check("a2 差额按新生效价重算为 +0.15", a2b.diff === 0.15, `实际 ${a2b.diff}`);
  check("a2 basePrice 更新为 8.20", a2b.basePrice === 8.2);
  check("a3 仍为冲突稿且转挂 a2", a3b.status === "conflicted" && a3b.blockedBy === "a2");
  check("重算递补日志已写入", ledger.logs.some((l: any) => l.kind === "recalc" && l.adjustmentId === "a2"));

  // a2 生效，a3 递补：差额按 8.35 重算
  await engine.runTxn({ type: "effect", terminal: "终端-B", adjustmentId: "a2" });
  ledger = JSON.parse(storage.readLedgerRaw()!);
  check("最新生效价变为 8.35", latestEffectivePrice(ledger, "95号汽油") === 8.35);
  const a3c = ledger.adjustments.find((x: any) => x.id === "a3");
  check("a3 递补待生效且差额 +0.15", a3c.status === "pending" && a3c.diff === 0.15, `diff=${a3c.diff}`);
}

// ---------- 场景2：多步生效在提交点前异常，恢复后事务头摘除且不重复入账 ----------
async function scenario2() {
  console.log("\n[场景2] 多步生效写入异常：op 已随屏障落盘、事务头未摘除 → 恢复收尾");
  const storage = makeStorage();
  let engine = new LedgerEngine(storage, null);
  engine.init();

  // 先造一个待生效 + 一张冲突稿，使生效事务含3个op（生效/递补/转挂）
  await engine.runTxn(draft("b1", "95号汽油", 7.30, "终端-A"));
  await engine.runTxn(draft("b2", "95号汽油", 7.45, "终端-B"));
  await engine.runTxn(draft("b3", "95号汽油", 7.55, "终端-C"));

  // 屏障4 = 3个op中的前2步落盘后异常（转挂步骤未执行）
  engine.setFault({ barrier: 4, stepDelayMs: 0 });
  let threw = false;
  try {
    await engine.runTxn({ type: "effect", terminal: "终端-A", adjustmentId: "b1" });
  } catch (e) {
    threw = e instanceof LedgerWriteError && e.resumable;
  }
  check("在屏障点抛出可恢复异常", threw);

  let ledger = JSON.parse(storage.readLedgerRaw()!);
  check("预写事务头已保留", ledger.pendingTxn !== null);
  check("事务记录已执行2步", ledger.pendingTxn.appliedOps === 2, `实际 ${ledger.pendingTxn.appliedOps}`);
  const b1mid = ledger.adjustments.find((x: any) => x.id === "b1");
  check("断点处状态自洽：b1 已生效、快照与生效日志已随前一屏障入账",
    b1mid.status === "effective" &&
    ledger.snapshots.some((s: any) => s.adjustmentId === "b1") &&
    ledger.logs.some((l: any) => l.kind === "effect"));
  check("第3步（转挂）尚未执行",
    ledger.adjustments.find((x: any) => x.id === "b3").blockedBy === "b1");

  engine.setFault(null);
  engine = new LedgerEngine(storage, null);
  const rec = await engine.recover();
  check("恢复返回成功", rec.resumed === true);
  ledger = JSON.parse(storage.readLedgerRaw()!);
  check("恢复后事务头摘除（不再是半份事务）", ledger.pendingTxn === null);
  check("第3步补齐：b3 转挂到递补后的 b2",
    ledger.adjustments.find((x: any) => x.id === "b3").blockedBy === "b2");
  check("恢复操作日志已记录", ledger.logs.some((l: any) => l.kind === "recover"));
  check("生效日志只写一次（重放幂等）",
    ledger.logs.filter((l: any) => l.kind === "effect" && l.adjustmentId === "b1").length === 1);
  check("重算递补日志只写一次",
    ledger.logs.filter((l: any) => l.kind === "recalc" && l.adjustmentId === "b2").length === 1);
  check("最终生效价 7.30", latestEffectivePrice(ledger, "95号汽油") === 7.3);
}

// ---------- 场景2b：事务头落盘后立即异常（屏障2），恢复后补完全部 ----------
async function scenario2b() {
  console.log("\n[场景2b] 提交在第2步中断：单据未入账 → 恢复后补入，无重复");
  const storage = makeStorage();
  let engine = new LedgerEngine(storage, { barrier: 2, stepDelayMs: 0 });
  engine.init();
  let threw = false;
  try {
    await engine.runTxn(draft("c1", "98号汽油", 9.10, "终端-A"));
  } catch (e) {
    threw = e instanceof LedgerWriteError;
  }
  check("提交在第2步抛出异常", threw);
  let ledger = JSON.parse(storage.readLedgerRaw()!);
  check("事务头在、调价单尚未写入",
    ledger.pendingTxn !== null && !ledger.adjustments.some((x: any) => x.id === "c1"));

  engine.setFault(null);
  engine = new LedgerEngine(storage, null);
  await engine.recover();
  ledger = JSON.parse(storage.readLedgerRaw()!);
  check("恢复后调价单入账为待生效",
    ledger.adjustments.some((x: any) => x.id === "c1" && x.status === "pending"));
  check("只入账一次", ledger.adjustments.filter((x: any) => x.id === "c1").length === 1);
  check("提交日志存在且仅一条",
    ledger.logs.filter((l: any) => l.adjustmentId === "c1" && l.kind === "submit").length === 1);
}

// ---------- 场景3：旧台账迁移（含半份损坏 JSON），原记录/状态/备注不丢 ----------
async function scenario3() {
  console.log("\n[场景3] 旧数据首次打开迁移（含半份损坏文件抢救）");
  const good = [
    { id: "old-1", fuel: "92号汽油", price: 7.62, operator: "站长", effectiveDate: "2026-06-30", status: "生效中", notes: "正常调价", createdAt: "2026-06-30T08:00:00.000Z" },
    { id: "old-2", fuel: "95号汽油", price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30", status: "待确认", notes: "等待复核", createdAt: "2026-06-29T08:00:00.000Z" },
    { id: "old-3", fuel: "95号汽油", price: 7.22, operator: "值班经理", effectiveDate: "2026-07-02", status: "待确认", notes: "第二张待确认", createdAt: "2026-07-01T08:00:00.000Z" },
    { id: "old-4", fuel: "95号汽油", price: 8.01, operator: "站长", effectiveDate: "2026-05-01", status: "已回退", notes: "试销回退", createdAt: "2026-05-01T08:00:00.000Z" },
  ];
  // 末尾拼一段写到一半的第五条
  const broken = JSON.stringify(good).replace(/\]$/, ',{"id":"old-5","fuel":"98号汽油","price":9.9,"operator":"值');
  const storage = makeStorage({ [LEGACY_STORAGE_KEY]: broken });
  const engine = new LedgerEngine(storage, null);
  const ledger = engine.init();

  check("迁移后共4条旧记录（半份第5条不产生脏数据）", ledger.adjustments.length === 4,
    `实际 ${ledger.adjustments.length}`);
  const old1 = ledger.adjustments.find((a: any) => a.id === "old-1")!;
  const old2 = ledger.adjustments.find((a: any) => a.id === "old-2")!;
  const old3 = ledger.adjustments.find((a: any) => a.id === "old-3")!;
  const old4 = ledger.adjustments.find((a: any) => a.id === "old-4")!;
  check("原备注保留", old1.notes === "正常调价" && old2.notes === "等待复核");
  check("原状态文案保留在 legacyStatus", old1.legacyStatus === "生效中" && old2.legacyStatus === "待确认");
  check("生效中映射为 effective", old1.status === "effective");
  check("待确认映射为 pending", old2.status === "pending");
  check("已回退映射为 rolledback", old4.status === "rolledback");
  check("同油品第二张待确认转为冲突草稿并挂起", old3.status === "conflicted" && old3.blockedBy === "old-2");
  check("迁移产生生效快照（92号汽油 7.62）", latestEffectivePrice(ledger, "92号汽油") === 7.62);
  check("迁移日志已写入", ledger.logs.some((l: any) => l.kind === "migrate"));
  check("损坏抢救日志已写入", ledger.logs.some((l: any) => l.kind === "salvage"));
  check("迁移标记已置位", ledger.migrated === true);

  // 再次 init 不重复迁移
  const again = new LedgerEngine(storage, null).init();
  check("二次打开不重复迁移", again.adjustments.length === 4 &&
    again.logs.filter((l: any) => l.kind === "migrate").length === 1);

  // old2 生效后 old3 自动重算递补，差额相对 7.18
  await engine.runTxn({ type: "effect", terminal: "终端-A", adjustmentId: "old-2" });
  const after = JSON.parse(storage.readLedgerRaw()!);
  const old3b = after.adjustments.find((a: any) => a.id === "old-3");
  check("迁移来的冲突稿同样参与递补（7.22 对 7.18 差 +0.04）",
    old3b.status === "pending" && old3b.diff === 0.04, `diff=${old3b.diff}`);
}

// ---------- 场景4：回退恢复价格快照，差额展示跟最新生效价 ----------
async function scenario4() {
  console.log("\n[场景4] 生效后回退：恢复快照 + 差额刷新");
  const storage = makeStorage();
  const engine = new LedgerEngine(storage, null);
  engine.init();
  await engine.runTxn(draft("d1", "92号汽油", 7.62, "终端-A", "底价"));
  await engine.runTxn({ type: "effect", terminal: "终端-A", adjustmentId: "d1" });
  await engine.runTxn(draft("d2", "92号汽油", 7.90, "终端-B", "涨价"));
  await engine.runTxn({ type: "effect", terminal: "终端-B", adjustmentId: "d2" });

  let ledger = JSON.parse(storage.readLedgerRaw()!);
  check("最新生效价 7.90", latestEffectivePrice(ledger, "92号汽油") === 7.9);

  await engine.runTxn({ type: "rollback", terminal: "终端-B", adjustmentId: "d2" });
  ledger = JSON.parse(storage.readLedgerRaw()!);
  const d2 = ledger.adjustments.find((a: any) => a.id === "d2");
  check("d2 状态为已回退", d2.status === "rolledback");
  check("挂牌价恢复 7.62", latestEffectivePrice(ledger, "92号汽油") === 7.62);
  check("恢复快照已入账", ledger.snapshots.some((s: any) => s.adjustmentId === "d2:rollback" && s.price === 7.62));

  // 非生效单不能回退
  let blocked = false;
  try {
    await engine.runTxn({ type: "rollback", terminal: "A", adjustmentId: "d2" });
  } catch {
    blocked = true;
  }
  check("已回退单不能再次回退", blocked);
}

// ---------- 场景5：锁内重读 + 删除待生效单后队列递补 ----------
async function scenario5() {
  console.log("\n[场景5] 删除占槽单：冲突稿自动重算递补");
  const storage = makeStorage();
  const engine = new LedgerEngine(storage, null);
  engine.init();
  await engine.runTxn(draft("e1", "95号汽油", 7.20, "终端-A"));
  await engine.runTxn(draft("e2", "95号汽油", 7.30, "终端-B"));
  await engine.runTxn(draft("e3", "95号汽油", 7.40, "终端-C"));

  await engine.runTxn({ type: "remove", terminal: "终端-A", adjustmentId: "e1" });
  const ledger = JSON.parse(storage.readLedgerRaw()!);
  const e2 = ledger.adjustments.find((a: any) => a.id === "e2");
  const e3 = ledger.adjustments.find((a: any) => a.id === "e3");
  check("删除占槽单后 e2 递补", e2.status === "pending");
  check("e3 转挂 e2", e3.status === "conflicted" && e3.blockedBy === "e2");
  check("待生效槽位唯一", pendingOf(ledger, "95号汽油")?.id === "e2");
}

export async function run() {
  await scenario1();
  await scenario2();
  await scenario2b();
  await scenario3();
  await scenario4();
  await scenario5();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}
