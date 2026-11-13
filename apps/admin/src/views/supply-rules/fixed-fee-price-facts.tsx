import type { PriceVersionRecord, RulesResponse } from "../../api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { boundText, fixedFeePercent, referenceUnitYuan, safeBoxLabel, standardItemRows, unitLabel, type RatioBound } from "./rules-model";

const names = { ordinary: "普通", custom: "自定义", fast: "极速" } as const;

export function FixedFeePriceFacts({ price, part }: { price: PriceVersionRecord; part: "base" | "modes" | "term" }) {
  const rule = price.haffRule;
  const modes = rule?.schema === "haff-ratio-v3"
    ? rule.fixedModes as Partial<Record<keyof typeof names, { enabled: boolean; min?: RatioBound; max?: RatioBound }>> | undefined
    : undefined;
  const groups = part === "base"
    ? [["保险箱基础比例（万/元）", "baseBySafeBox"], ["体力调整", "vitalityDeltaByLevel"], ["负重调整", "bearDeltaByLevel"]]
    : [["按租期选项调整比例", "dailyDeltaByTermOption"]];
  return <section className="section-panel space-y-3" aria-label="固定手续费计价">
    <h3 className="text-base font-semibold">{part === "modes" ? "固定手续费率与出租方式" : part === "base" ? "固定手续费基础计价" : "固定手续费租期比例"}</h3>
    <p className="text-sm text-muted-foreground">当前组合引用价目 <span className="break-all">{price.id}</span>。新上架账号的生效价目见「调价排期」。</p>
    {rule?.schema !== "haff-ratio-v3" ? <p role="status">当前哈夫币规则无法核对。</p> : part === "modes" ? <dl className="grid gap-3 sm:grid-cols-3">
      {Object.entries(names).map(([key, label]) => {
        const mode = key as keyof typeof names, entry = modes?.[mode], rate = price.fixedFeeRates?.[mode];
        return <div key={mode}>
          <dt className="font-medium">{label}</dt>
          <dd className="text-sm text-muted-foreground">{rate === undefined ? "费率待核对" : fixedFeePercent(rate)} · {entry ? entry.enabled ? "启用" : "停用" : "状态待核对"}</dd>
          {entry?.enabled && (entry.min || entry.max) ? <dd className="text-sm text-muted-foreground">
            {entry.min ? `下限 ${boundText(entry.min)}` : ""}{entry.max ? ` 上限 ${boundText(entry.max)}` : ""}
          </dd> : null}
        </div>;
      })}
    </dl> : <div className="grid gap-4 sm:grid-cols-3">
      {groups.map(([label, key]) => {
        const values = rule[key!];
        return <div key={key}>
          <h4 className="mb-1 text-sm font-medium">{label}</h4>
          <dl className="space-y-1 text-sm text-muted-foreground">
            {values && typeof values === "object" ? Object.entries(values).map(([name, value]) => <div className="flex flex-wrap gap-x-2" key={name}>
              <dt>{key === "baseBySafeBox" ? safeBoxLabel(name) : name}</dt><dd className="tabular-nums">{String(value)}</dd>
            </div>) : <dd>待核对</dd>}
          </dl>
        </div>;
      })}
    </div>}
  </section>;
}

export function FixedFeeItemPrices({ rules, priceId }: { rules: RulesResponse; priceId: string }) {
  const rows = standardItemRows(rules, priceId);
  return <section className="section-panel space-y-3" aria-label="固定手续费物资单价">
    <h3 className="text-base font-semibold">物资统一单价</h3>
    <p className="text-sm text-muted-foreground">租客与号主使用同一单价。普通手续费在结算时另计。</p>
    {rows.length ? <Table><TableHeader><TableRow><TableHead>物资</TableHead><TableHead>计费单位</TableHead><TableHead>单价</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(({ item, line }) => <TableRow key={item.id}>
        <TableCell>{item.name}</TableCell><TableCell>{line?.unitQuantity ?? "—"} {unitLabel(item.unit, item.code)}</TableCell>
        <TableCell className="tabular-nums">{line?.buyerUnitAmount == null ? "未配置" : referenceUnitYuan(line.buyerUnitAmount)}</TableCell>
      </TableRow>)}</TableBody>
    </Table> : <p className="text-sm text-muted-foreground">暂无按固定单价计费的物资。</p>}
  </section>;
}
