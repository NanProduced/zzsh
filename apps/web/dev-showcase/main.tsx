import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PortalHome } from "../src/components/portal-home";
import { ThemeProvider } from "../src/components/theme-provider";
import type { AccountCardData } from "../src/components/delta/account-card";
import type { SupplyState } from "../src/components/delta/delta-section";
import "../src/app/globals.css";
const accounts: AccountCardData[] = [
 { id: "repair-fixture-alpha", title: "样例账号 A", resourceLines: [{ itemId: "haff", name: "哈夫币", quantityLabel: "100 M", unitLabel: "哈夫币" }], resourceTotalLabel: "¥320.00", depositLabel: "¥100.00", termLabel: "5 天", conditionLines: [{ key: "vit_level", label: "体力等级", value: "6 级" }], skinNames: [] },
 { id: "repair-fixture-beta", title: "样例账号 B", resourceLines: [{ itemId: "haff", name: "哈夫币", quantityLabel: "80 M", unitLabel: "哈夫币" }], resourceTotalLabel: "¥260.00", depositLabel: "¥100.00", termLabel: "4 天", conditionLines: [{ key: "bear_level", label: "负重等级", value: "6 级" }], skinNames: [], imageUrl: "/intentionally-missing-public-image.png" },
 { id: "repair-fixture-gamma", title: "样例账号 C · 长标题与大额格式检查", resourceLines: [{ itemId: "haff", name: "哈夫币", quantityLabel: "150 M", unitLabel: "哈夫币" }], resourceTotalLabel: "¥1,280.50", depositLabel: "¥300.00", termLabel: "5 天", conditionLines: [{ key: "grading_code", label: "段位", value: "gold" }], skinNames: ["样例皮肤"] },
];
function Showcase() {
 const [counter,setCounter]=useState(12580);
 useEffect(()=>{const timer=setInterval(()=>setCounter(v=>v+7),2500);return ()=>clearInterval(timer);},[]);
 const [mode, setMode] = useState("ready");
 const state: SupplyState = mode === "empty" || mode === "long" ? "ready" : mode as SupplyState;
 const shownAccounts = mode === "empty" ? [] : mode === "long" ? accounts.map((account, index) => index === 0 ? {
   ...account,
   title: "长内容样例：资源说明、装备配置与交付条件均应完整显示，不靠省略关键信息来压缩卡片。".repeat(3),
   resourceTotalLabel: "¥99,999,999.99", depositLabel: "¥88,888,888.88",
   termLabel: "以确认的每日消耗档位及交付条件为准",
 } : account) : accounts;
 return <ThemeProvider><div style={{ padding: "12px 24px", background: "#fff3cb", color: "#33240b", fontSize: 13 }}>
   <strong>独立开发展示 · 所有账号和费用均为样例，不可交易。</strong>
   <label style={{ marginLeft: 20 }}>展示状态 <select aria-label="展示状态" value={mode} onChange={(event) => setMode(event.target.value)}>
    <option value="ready">资源样例</option><option value="long">长内容</option><option value="loading">加载中</option><option value="empty">空结果</option><option value="error">加载失败</option><option value="unavailable">未取得数据</option>
   </select></label>
 </div><PortalHome accounts={shownAccounts} supplyState={state} stats={mode==='unavailable'?undefined:{visits:counter,transactions:counter*12,listings:3086}} deals={mode==='unavailable'?[]:[{id:'activity-fixture-1',game:'三角洲行动',title:'演示成交 A · 资源账号 · 100 M / 3×3安全箱',priceLabel:'¥320.00'},{id:'activity-fixture-2',game:'三角洲行动',title:'演示成交 B · 资源账号 · 80 M / 2×3安全箱',priceLabel:'¥260.00'},{id:'activity-fixture-3',game:'三角洲行动',title:'演示成交 C · 长描述显示检查：资源规格与交付条件以实际确认为准',priceLabel:'¥1,280.50'}]} /></ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<Showcase />);
