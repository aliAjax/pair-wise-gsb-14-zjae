// SSR 冒烟：用最小存储垫片把整个 App（含 Pinia store + 引擎 + 迁移）渲染一遍，
// 抓模板/响应式运行时错误，不依赖真实浏览器。
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";

// ---- 浏览器 API 垫片 ----
class MemoryStorage {
  m = new Map();
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const local = new MemoryStorage();
const session = new MemoryStorage();
// 预置一份旧台账，验证 SSR 路径上迁移也能跑
local.setItem(
  "dfwlfront-9-price",
  JSON.stringify([
    { id: "x1", fuel: "92号汽油", price: 7.55, operator: "站长", effectiveDate: "2026-06-30", status: "生效中", notes: "旧备注A", createdAt: "2026-06-30T01:00:00.000Z" },
    { id: "x2", fuel: "柴油", price: 7.0, operator: "值班经理", effectiveDate: "2026-06-30", status: "待确认", notes: "旧备注B", createdAt: "2026-06-29T01:00:00.000Z" },
  ]),
);
globalThis.localStorage = local;
globalThis.sessionStorage = session;
globalThis.navigator = { locks: undefined };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.crypto ??= { randomUUID: () => `uuid-${Math.random()}` };

const { createServer } = await import("vite");
const vite = await createServer({
  server: { middlewareMode: true },
  logLevel: "error",
  appType: "custom",
});
try {
  const App = (await vite.ssrLoadModule("/src/App.vue")).default;
  const app = createSSRApp({ render: () => h(App) });
  app.use(createPinia());
  const html = await renderToString(app);
  const ledgerAfter = JSON.parse(local.getItem("dfwlfront-9-ledger-v1"));
  const checks = [
    ["渲染出标题", html.includes("油品价格维护")],
    ["渲染油价台账", html.includes("92号汽油")],
    ["旧记录已迁移（2条）", ledgerAfter.adjustments.length === 2],
    ["旧备注原样保留", ledgerAfter.adjustments.some((a) => a.notes === "旧备注A")],
    ["旧状态文案保留", ledgerAfter.adjustments.some((a) => a.legacyStatus === "待确认")],
    ["迁移日志已写入", ledgerAfter.logs.some((l) => l.kind === "migrate")],
    ["最新生效价展示 7.55", html.includes("7.55")],
    ["待处理提示存在", html.includes("待处理")],
    ["恢复/演练区域存在", html.includes("写入异常演练")],
    ["操作日志标签存在", html.includes("操作日志")],
  ];
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "✅" : "❌"} ${name}`);
    if (!ok) fail += 1;
  }
  console.log(`SSR 渲染 ${checks.length - fail}/${checks.length} 项通过，HTML ${html.length} 字符`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await vite.close();
}
