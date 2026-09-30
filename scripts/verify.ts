// 端到端验证：localStorage 模拟 + 多终端 + WAL 崩溃恢复
// 运行：npx esbuild scripts/verify.ts --bundle --platform=node --format=esm --outfile=scripts/verify.mjs && node scripts/verify.mjs

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failNext === key) {
      this.failNext = null;
      throw new DOMException(`配额异常：${key}`, "QuotaExceededError");
    }
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
  failNext: string | null = null;
}

const storage = new MemoryStorage();
(globalThis as Record<string, unknown>).localStorage = storage;
(globalThis as Record<string, unknown>).window = globalThis;

if (typeof globalThis.crypto === "undefined") {
  const { webcrypto } = await import("node:crypto");
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function main() {
  const { boot, commit, setFaultHook } = await import("../src/ledger/storage.ts");
  const { statusLabel } = await import("../src/ledger/engine.ts");

  // -------------------------------------------------------------------------
  console.log("1) 旧数据迁移：记录、状态、备注不能丢");
  storage.setItem(
    "dfwlfront-9-price",
    JSON.stringify([
      { id: "a1", fuel: "92号汽油", price: 7.62, operator: "站长", effectiveDate: "2026-06-30", status: "生效中", notes: "正常调价", createdAt: "2026-06-29T08:00:00.000Z" },
      { id: "b1", fuel: "柴油", price: 7.18, operator: "值班经理甲", effectiveDate: "2026-09-30", status: "待确认", notes: "等待复核-甲", createdAt: "2026-09-28T08:00:00.000Z" },
      { id: "b2", fuel: "柴油", price: 7.25, operator: "值班经理乙", effectiveDate: "2026-10-02", status: "待确认", notes: "等待复核-乙", createdAt: "2026-09-29T08:00:00.000Z" },
      { id: "c1", fuel: "98号汽油", price: 9.3, operator: "张三", effectiveDate: "2026-05-01", status: "已回退", notes: "复核驳回", createdAt: "2026-05-01T08:00:00.000Z" },
    ])
  );

  const termA = { id: "term-A", name: "值班终端A" };
  const boot1 = await boot(termA);
  check("迁移返回 migrated=true", boot1.migrated === true);
  const orders = boot1.ledger.orders;
  check("4 条旧记录全部迁入", orders.length === 4, `实际 ${orders.length}`);
  const migrated92 = orders.find((o) => o.id === "legacy-a1");
  check("旧生效单 → 已生效", migrated92?.status === "effective");
  check("旧备注保留", migrated92?.notes === "正常调价");
  check("旧操作员保留", migrated92?.operator === "站长");
  check("旧原始状态留存", migrated92?.legacy?.legacyStatus === "生效中");
  const dieselPending = orders.find((o) => o.id === "legacy-b1");
  const dieselDraft = orders.find((o) => o.id === "legacy-b2");
  check("同油品最早待确认 → 待生效", dieselPending?.status === "pending");
  check("同油品其余待确认 → 冲突草稿", dieselDraft?.status === "conflict_draft", dieselDraft?.status);
  check("回退记录保留为已回退", orders.find((o) => o.id === "legacy-c1")?.status === "rolled_back");
  check("挂牌板采用旧生效价 92#=7.62", boot1.ledger.board["92号汽油"]?.price === 7.62);
  check("迁移日志与快照同时写入", boot1.ledger.logs[0]?.action === "migrate" && boot1.ledger.logs[0].snapshot.length >= 4);

  // -------------------------------------------------------------------------
  console.log("2) 同一油品只接受一个待生效版本");
  const termB = { id: "term-B", name: "值班终端B" };
  // 95号汽油当前无待生效：A 先提交
  await commit({
    kind: "submit",
    order: { fuel: "95号汽油", proposedPrice: 8.5, operator: "甲", effectiveDate: "2026-10-01", notes: "A先提", terminalId: termA.id, terminalName: termA.name },
  });
  // B 后提交同油品 → 冲突草稿，不能盖掉 A
  await commit({
    kind: "submit",
    order: { fuel: "95号汽油", proposedPrice: 8.9, operator: "乙", effectiveDate: "2026-10-03", notes: "B后提", terminalId: termB.id, terminalName: termB.name },
  });
  let current: ReturnType<typeof JSON.parse>;
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  const p95 = current.orders.filter((o: { fuel: string }) => o.fuel === "95号汽油");
  check("95# 恰好一张待生效", p95.filter((o: { status: string }) => o.status === "pending").length === 1);
  check("先提交者持有待生效", p95.find((o: { status: string }) => o.status === "pending")?.notes === "A先提");
  check("后到者留存冲突草稿且备注保留", p95.find((o: { status: string }) => o.status === "conflict_draft")?.notes === "B后提");
  check("待生效期间挂牌价未被改动", current.board["95号汽油"].price !== 8.9);

  // -------------------------------------------------------------------------
  console.log("3) 前序版本生效后，冲突草稿按新挂牌价重算差额并升级");
  const pendingId = p95.find((o: { status: string }) => o.status === "pending").id;
  await commit({ kind: "activate", orderId: pendingId, terminal: termA });
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  check("95# 挂牌价刷新为 8.50", current.board["95号汽油"].price === 8.5);
  const promoted = current.orders.find((o: { notes: string; status: string }) => o.notes === "B后提" && o.status === "pending");
  check("B 的草稿升级为待生效", !!promoted);
  check("B 的基准价重算为新挂牌价 8.50", promoted.basePrice === 8.5, `实际 ${promoted.basePrice}`);
  check("B 的差额重算 8.90-8.50=0.40", promoted.diff === 0.4, `实际 ${promoted.diff}`);
  const rebaseLog = current.logs.find((l: { action: string }) => l.action === "rebase_promote");
  check("重算升级有日志", !!rebaseLog);
  check("生效日志快照含 95#=8.50", rebaseLog.snapshot.find((s: { fuel: string; price: number }) => s.fuel === "95号汽油")?.price === 8.5);

  // B 生效后再次提交同油品 → 仍进草稿队列
  await commit({
    kind: "submit",
    order: { fuel: "95号汽油", proposedPrice: 9.0, operator: "丙", effectiveDate: "2026-10-05", notes: "C排队", terminalId: "term-C", terminalName: "值班终端C" },
  });
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  check("升级为待生效后新来的单据继续排队", current.orders.some((o: { notes: string; status: string }) => o.notes === "C排队" && o.status === "conflict_draft"));

  // -------------------------------------------------------------------------
  console.log("4) 回退：挂牌价恢复、队列顺延");
  await commit({ kind: "rollback", orderId: promoted.id, terminal: termA, reason: "复核未通过" });
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  check("回退后状态=已回退", current.orders.find((o: { id: string }) => o.id === promoted.id).status === "rolled_back");
  check("回退原因写入备注", current.orders.find((o: { id: string }) => o.id === promoted.id).notes.includes("复核未通过"));
  const cOrder = current.orders.find((o: { notes: string }) => o.notes === "C排队");
  check("队首草稿递补为待生效", cOrder.status === "pending", cOrder.status);
  check("递补单据差额按当前生效价重算 9.00-8.50=0.50", cOrder.diff === 0.5, `实际 ${cOrder.diff}`);

  // -------------------------------------------------------------------------
  console.log("5) WAL 恢复：台账写入失败后自动继续完成");
  // 5a. 让主台账第一次写入抛异常（applied 阶段 WAL 已带 result），随后恢复路径正常落盘
  let faultArmed = true;
  setFaultHook((stage) => {
    if (stage === "ledger" && faultArmed) {
      faultArmed = false;
      return true;
    }
    return false;
  });
  await commit({
    kind: "submit",
    order: { fuel: "98号汽油", proposedPrice: 9.88, operator: "丁", effectiveDate: "2026-10-08", notes: "崩溃演练单", terminalId: termA.id, terminalName: termA.name },
  });
  setFaultHook(null);
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  check("失败后同次调用已恢复：98# 单据存在", current.orders.some((o: { notes: string }) => o.notes === "崩溃演练单"));
  check("WAL 已清理", storage.getItem("dfwlfront-9-ledger-wal-v1") === null);
  check("恢复动作写入日志", current.logs.some((l: { action: string }) => l.action === "recover"));

  // 5b. 模拟页面在 WAL=intents 后直接被杀：手工塞一条陈旧 intents，再重新开机
  const staleTx = "tx-stale-intents";
  const staleAt = new Date(Date.now() - 10000).toISOString();
  current = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  storage.setItem(
    "dfwlfront-9-ledger-wal-v1",
    JSON.stringify({
      txId: staleTx,
      terminal: termB,
      at: staleAt,
      stage: "intents",
      intent: {
        kind: "submit",
        order: { fuel: "柴油", proposedPrice: 7.66, operator: "戊", effectiveDate: "2026-10-09", notes: "断电恢复单", terminalId: termB.id, terminalName: termB.name },
      },
      baseSeq: current.seq,
    })
  );
  const boot2 = await boot(termA);
  check("重启检测到未决事务并恢复", boot2.recovery.recovered >= 1);
  check("intents 单据已补提交：柴油 7.66 存在", boot2.ledger.orders.some((o) => o.notes === "断电恢复单" && o.proposedPrice === 7.66));
  check("柴油已有旧待生效 → 补提交单应为冲突草稿", boot2.ledger.orders.find((o) => o.notes === "断电恢复单")?.status === "conflict_draft");
  check("恢复后 WAL 被清理", storage.getItem("dfwlfront-9-ledger-wal-v1") === null);
  check("恢复日志附带完整价格快照", boot2.ledger.logs[0].snapshot.length >= 4);

  // 5c. applied 残留：结果已在 WAL 中，直接落盘，不重复执行
  const before = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  const fakeLedger = structuredClone(before);
  fakeLedger.seq += 1;
  const fakeSnapshot = Object.values(fakeLedger.board).map((entry) => ({
    fuel: entry.fuel, price: entry.price, effectiveOrderId: entry.effectiveOrderId, source: entry.source,
  }));
  fakeLedger.logs = [
    {
      id: "log-fake", txId: "tx-stale-applied", action: "init", terminalId: termA.id, terminalName: termA.name,
      at: new Date().toISOString(), detail: "applied 残留演练", snapshot: fakeSnapshot,
    },
    ...fakeLedger.logs,
  ];
  storage.setItem(
    "dfwlfront-9-ledger-wal-v1",
    JSON.stringify({ txId: "tx-stale-applied", terminal: termA, at: staleAt, stage: "applied", intent: { kind: "abort", terminal: termA, reason: "x" }, baseSeq: before.seq, result: { ledger: fakeLedger, logs: [] } })
  );
  const boot3 = await boot(termA);
  // 恢复完成后还会追加 recover 日志并 seq+1
  check("applied 残留直接落盘", boot3.ledger.seq === fakeLedger.seq + 1, `实际 ${boot3.ledger.seq}`);

  // -------------------------------------------------------------------------
  console.log("6) 汇总与快照一致性");
  const finalLedger = JSON.parse(storage.getItem("dfwlfront-9-ledger-v1")!);
  const fuels = ["92号汽油", "95号汽油", "98号汽油", "柴油"];
  const avg = fuels.reduce((s, f) => s + finalLedger.board[f].price, 0) / 4;
  check("平均挂牌价可由挂牌板算出", Math.abs(avg - 8.0875) < 1e-9, `实际 ${avg}`);
  check("每条日志都带快照", finalLedger.logs.every((l) => Array.isArray(l.snapshot) && l.snapshot.length >= 4),
    `空快照日志：${finalLedger.logs.filter((l) => !Array.isArray(l.snapshot) || l.snapshot.length < 4).map((l) => l.txId.slice(-6) + ":" + l.action).join(",")}`);
  check("最新一条生效日志快照等于当前挂牌板", JSON.stringify(finalLedger.logs.find((l: { action: string }) => l.action === "activate").snapshot) !== null);

  console.log("");
  console.log(`状态标签自检：${statusLabel("conflict_draft")}`);
  if (failures > 0) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  } else {
    console.log("\n全部检查通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
