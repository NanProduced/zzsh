import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { adminRequest, friendlyError, hasPermission, type CatalogItem, type PriceLineRecord, type PriceVersionRecord, type RulesResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { StatusMessage } from "../components/ui-elements";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Skeleton } from "../components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { SupplySelect } from "../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { RulesOverview } from "./supply-rules/rules-overview";
import { draftCommand, RULES_RELEASE_OPERATION, useRulesWrite } from "./supply-rules/rules-write";

const inputClass = "h-9";
const textareaClass = "min-h-32";

const PRICE_TIERS = ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"] as const;
type PriceTier = typeof PRICE_TIERS[number];
type PriceLineDraft = { customerTier: PriceTier; itemId: string; pricingKind: "FIXED_UNIT" | "HAFF_RATIO"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string };
type TermOptionDraft = { code: string; name: string; dailyConsumption: string };

function requiresTierEditor(record: PriceVersionRecord): boolean {
  return record.haffRule?.schema !== undefined && !["haff-ratio-v1", "haff-ratio-v2"].includes(String(record.haffRule.schema));
}

type RulesOption = { value: string; label: string };

function RulesSelect({ label, value, onChange, options, placeholder = "请选择", disabled, ...aria }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: RulesOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <SupplySelect label={label} value={value} onValueChange={onChange} options={value === "" ? [{ value: "", label: options.length ? placeholder : "暂无可选项" }, ...options] : options} disabled={disabled || options.length === 0} id={aria.id} aria-labelledby={aria["aria-labelledby"]} aria-describedby={aria["aria-describedby"]} aria-invalid={aria["aria-invalid"]} />
  );
}

// ui/button 没有 loading：在途时显式禁用 + aria-busy + 在途文案
function BusyButton({ busy = false, busyText = "处理中…", disabled, children, ...props }: Omit<ComponentProps<typeof Button>, "children"> & { busy?: boolean; busyText?: string; children: ReactNode }) {
  return <Button {...props} disabled={Boolean(disabled) || busy} aria-busy={busy || undefined}>{busy ? busyText : children}</Button>;
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}

function modeLabel(mode: string): string {
  return mode === "SPREAD" ? "差价" : mode === "PERCENT" ? "百分比" : mode;
}

function statusLabel(status: string): string {
  return status === "SEALED" ? "已封存" : status === "DRAFT" ? "草稿" : status;
}

function kindLabel(kind: string): string {
  return kind === "HAFF_RATIO" ? "按哈夫币规则推算" : kind === "FIXED_UNIT" ? "固定单价" : kind;
}

function latestSealed<T extends { id: string; status: string; sealedAt: string | null }>(versions: T[]): string {
  const sealed = versions.find((version) => version.status === "SEALED");
  return sealed?.id ?? "";
}

export function SupplyRulesView({
  snapshot,
  onDirtyChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
}) {
  const canEdit = hasPermission(snapshot, "supply.rules.edit");
  const canPreview = hasPermission(snapshot, "supply.quote.internal.read");
  const isBoss = snapshot.security.isBoss;
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const [priceId, setPriceId] = useState("");
  const [termId, setTermId] = useState("");
  const [agreementId, setAgreementId] = useState("");
  const [priceMode, setPriceMode] = useState<"SPREAD" | "PERCENT">("SPREAD");
  const [commissionRate, setCommissionRate] = useState("");
  const [haffRuleText, setHaffRuleText] = useState("");
  const [priceTier, setPriceTier] = useState<PriceTier>("STANDARD");
  const [lines, setLines] = useState<Record<string, PriceLineDraft>>({});
  const [termOptions, setTermOptions] = useState<TermOptionDraft[]>([]);
  const [agreementTitle, setAgreementTitle] = useState("");
  const [agreementBody, setAgreementBody] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [overviewDirty, setOverviewDirty] = useState(false);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [haffRawOpen, setHaffRawOpen] = useState(false);
  const gamesSeq = useRef(0), rulesSeq = useRef(0);
  const readScope = useRef({ adminId: snapshot.adminUserId, sessionId: snapshot.session?.id, gameId });
  readScope.current = { adminId: snapshot.adminUserId, sessionId: snapshot.session?.id, gameId };
  const sameReadScope = (scope: typeof readScope.current, sequence: number) => sequence === rulesSeq.current && scope.adminId === readScope.current.adminId && scope.sessionId === readScope.current.sessionId && scope.gameId === readScope.current.gameId;
  // 防双击：同一时刻只允许一个写操作在途
  const busyRef = useRef(false), guardSeq = useRef(0);
  useEffect(() => { ++guardSeq.current; busyRef.current = false; }, [snapshot.adminUserId, snapshot.session?.id, gameId]);
  const guard = async (action: () => Promise<void>) => {
    if (busyRef.current || command.locked) return;
    const sequence = ++guardSeq.current;
    busyRef.current = true;
    try { await action(); } finally { if (sequence === guardSeq.current) busyRef.current = false; }
  };

  useEffect(() => {
    onDirtyChange(dirty || overviewDirty);
  }, [dirty, overviewDirty, onDirtyChange]);

  const loadGames = useCallback(async () => {
    const sequence = ++gamesSeq.current;
    if (!canEdit) return;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    if (sequence !== gamesSeq.current) return;
    setGames(result.games);
    setGamesLoaded(true);
    setGameId((current) => current && result.games.some(game => game.id === current) ? current : ((snapshot.security.isBoss ? result.games.find(game => game.enabled && game.code === "delta") : undefined) ?? result.games.find(game => game.enabled) ?? result.games[0])?.id ?? "");
  }, [canEdit, snapshot.adminUserId, snapshot.session?.id, snapshot.security.isBoss]);

  const applyPrice = useCallback((record: PriceVersionRecord, allLines: PriceLineRecord[], items: CatalogItem[]) => {
    setPriceId(record.id);
    setPriceMode(record.mode);
    setCommissionRate(record.commissionRate ?? "");
    setHaffRuleText(record.haffRule ? JSON.stringify(record.haffRule, null, 2) : "");
    if (requiresTierEditor(record)) {
      setLines({});
      return;
    }
    const next: Record<string, PriceLineDraft> = {};
    for (const customerTier of PRICE_TIERS) for (const item of items) {
      next[item.id + ":" + customerTier] = { customerTier, itemId:item.id, pricingKind:item.unit === "HAFF_BASE" ? "HAFF_RATIO" : "FIXED_UNIT", unitQuantity:"1", buyerUnitAmount:"", ownerUnitAmount:"" };
    }
    for (const line of allLines.filter(line => line.priceVersionId === record.id)) {
      const customerTier = line.customerTier ?? "STANDARD";
      next[line.itemId + ":" + customerTier] = { customerTier, itemId:line.itemId, pricingKind:line.pricingKind, unitQuantity:line.unitQuantity ?? "", buyerUnitAmount:line.buyerUnitAmount ?? "", ownerUnitAmount:line.ownerUnitAmount ?? "" };
    }
    setPriceTier("STANDARD");
    setLines(next);
  }, []);

  const applyTerm = useCallback((recordId: string, options: RulesResponse["termOptions"]) => {
    setTermId(recordId);
    setTermOptions(options.filter((option) => option.versionId === recordId).map((option) => ({ code: option.code, name: option.name, dailyConsumption: option.dailyConsumption })));
  }, []);

  const loadRules = useCallback(async (targetGameId: string) => {
    const sequence = ++rulesSeq.current;
    const scope = { ...readScope.current, gameId: targetGameId };
    if (!targetGameId) {
      setRules(null);
      return;
    }
    const result = await adminRequest<RulesResponse>(`/supply/games/${targetGameId}/rules`);
    if (!sameReadScope(scope, sequence)) return;
    if (result.game.id !== targetGameId) throw new Error("规则响应不属于当前游戏");
    setRules(result);
    const nextPrice = latestSealed(result.priceVersions) || result.priceVersions[0]?.id || "";
    if (nextPrice) {
      const record = result.priceVersions.find((version) => version.id === nextPrice);
      if (record) applyPrice(record, result.priceLines, result.items);
    }
    const nextTerm = latestSealed(result.termVersions) || result.termVersions[0]?.id || "";
    applyTerm(nextTerm, result.termOptions);
    const nextAgreement = latestSealed(result.agreementVersions) || result.agreementVersions[0]?.id || "";
    setAgreementId(nextAgreement);
    const agreement = result.agreementVersions.find((version) => version.id === nextAgreement);
    setAgreementTitle(agreement?.title ?? "");
    setAgreementBody(agreement?.body ?? "");
    setDirty(false);
  }, [applyPrice, applyTerm]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setRules(null); setGames([]); setGamesLoaded(false); setGameId(""); setDirty(false); setOverviewDirty(false);
    loadGames().catch((failure) => { if (active) setError(friendlyError(failure)); });
    return () => { active = false; ++gamesSeq.current; ++rulesSeq.current; };
  }, [refreshNonce, loadGames]);

  useEffect(() => {
    if (!gameId) {
      ++rulesSeq.current;
      setRules(null);
      return;
    }
    let active = true;
    setLoading(true);
    loadRules(gameId)
      .catch((failure) => { if (active) setError(friendlyError(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; ++rulesSeq.current; };
  }, [gameId, loadRules, refreshNonce]);

  const reload = async (): Promise<RulesResponse | undefined> => {
    if (!gameId) return undefined;
    const scope = { ...readScope.current }, sequence = ++rulesSeq.current;
    const result = await adminRequest<RulesResponse>(`/supply/games/${encodeURIComponent(scope.gameId)}/rules`);
    if (!sameReadScope(scope, sequence) || result.game.id !== scope.gameId) return undefined;
    setRules(result);
    setDirty(false);
    return result;
  };
  const command = useRulesWrite(snapshot.adminUserId, gameId, reload, snapshot.session?.id ?? "");

  const selectedPrice = rules?.priceVersions.find((version) => version.id === priceId);
  const priceReadOnly = Boolean(selectedPrice && requiresTierEditor(selectedPrice));
  const selectedTerm = rules?.termVersions.find((version) => version.id === termId);
  const selectedAgreement = rules?.agreementVersions.find((version) => version.id === agreementId);
  const items = rules?.items ?? [];

  const selectPrice = (id: string, source?: RulesResponse) => {
    const data = source ?? rules;
    if (!data) return;
    const record = data.priceVersions.find((version) => version.id === id);
    if (!record) return;
    applyPrice(record, data.priceLines, data.items);
    setDirty(false);
  };

  const createPrice = async () => {
    setError(undefined);
    try {
      const result = await command.write(draftCommand(gameId, "price", "create", { gameId, mode: priceMode }));
      if (!result) return;
      selectPrice(result.receipt.id!, result.fresh);
      setSuccess("价格草稿已创建；草稿可继续修改，封存后才可生效。");
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  const savePrice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPrice || priceReadOnly) return;
    let haffRule: unknown = undefined;
    if (haffRuleText.trim()) {
      try {
        haffRule = JSON.parse(haffRuleText);
      } catch {
        setError("Haff 规则不是合法 JSON，未保存。");
        return;
      }
    }
    const requestedSchema = (haffRule as { schema?: string } | undefined)?.schema;
    const tiered = requestedSchema === "haff-ratio-v2" || (rules?.priceLines ?? []).some(line => line.priceVersionId === selectedPrice.id && line.customerTier !== undefined && line.customerTier !== "STANDARD");
    if (selectedPrice.haffRule?.schema === "haff-ratio-v2" && requestedSchema !== "haff-ratio-v2") {
      setError("此草稿已有会员档位，不能改成旧规则保存并丢失价目。"); return;
    }
    const builtLines = Object.values(lines)
      .filter(line => tiered || line.customerTier === "STANDARD")
      .filter((line) => line.buyerUnitAmount !== "" || line.pricingKind === "HAFF_RATIO")
      .map((line) =>
        line.pricingKind === "HAFF_RATIO"
          ? { itemId: line.itemId, pricingKind: "HAFF_RATIO", ...(tiered ? { customerTier:line.customerTier } : {}) }
          : {
              itemId: line.itemId,
              ...(tiered ? { customerTier:line.customerTier } : {}),
              pricingKind: "FIXED_UNIT",
              unitQuantity: line.unitQuantity,
              buyerUnitAmount: line.buyerUnitAmount,
              ...(priceMode === "SPREAD" && line.ownerUnitAmount !== "" ? { ownerUnitAmount: line.ownerUnitAmount } : {}),
            },
      );
    if (tiered && builtLines.some(line => PRICE_TIERS.some(tier => !builtLines.some(other => other.itemId === line.itemId && other.customerTier === tier)))) {
      setError("每个计费物品须补齐普通、VIP、SVIP和折扣用户四档价目，缺价不能保存。"); return;
    }
    if (builtLines.length === 0) {
      setError("至少配置一条计价行；固定物资需要买方单价。");
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, "price", "update", {
        expectedRevision: selectedPrice.revision,
        mode: priceMode,
        ...(priceMode === "PERCENT" ? { commissionRate } : {}),
        ...(haffRule === undefined ? {} : { haffRule }),
        roundingPolicy: selectedPrice.roundingPolicy,
        lines: builtLines,
      }, selectedPrice.id));
      if (!result) return;
      setSuccess("价格草稿已保存。");
      setDirty(false);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const saveTerm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTerm) return;
    if (termOptions.some((option) => !/^[a-z][a-z0-9_:-]{1,63}$/.test(option.code) || !/^[1-9]\d*$/.test(option.dailyConsumption) || !option.name.trim())) {
      setError("租期选项需要合法 code、名称与正整数日消耗哈夫币。");
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, "term", "update", {
        expectedRevision: selectedTerm.revision,
        options: termOptions.map((option) => ({ code: option.code, name: option.name, dailyConsumption: option.dailyConsumption, durationRounding: "CEIL_DAY" })),
      }, selectedTerm.id));
      if (!result) return;
      setSuccess("租期草稿已保存；日消耗只用于推算预计租期，不表示每天必须消费。");
      setDirty(false);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const saveAgreement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAgreement) return;
    if (!agreementTitle.trim() || !agreementBody.trim()) {
      setError("协议标题与正文不能为空。");
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, "agreement", "update", { expectedRevision: selectedAgreement.revision, title: agreementTitle, body: agreementBody }, selectedAgreement.id));
      if (!result) return;
      setSuccess("协议草稿已保存。");
      setDirty(false);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const createTerm = async () => {
    try {
      const result = await command.write(draftCommand(gameId, "term", "create", { gameId }));
      if (!result) return;
      applyTerm(result.receipt.id!, result.fresh.termOptions);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  const createAgreement = async () => {
    try {
      const result = await command.write(draftCommand(gameId, "agreement", "create", { gameId, title: "出租协议草稿", body: "在此填写协议正文。" }));
      if (!result) return;
      const record = result.fresh.agreementVersions.find((version) => version.id === result.receipt.id);
      setAgreementId(result.receipt.id!);
      setAgreementTitle(record?.title ?? "");
      setAgreementBody(record?.body ?? "");
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  const seal = async (kind: "price" | "term" | "agreement", id: string, revision: string) => {
    if (kind === "price" && priceReadOnly) return;
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, kind, "seal", { expectedRevision: revision }, id));
      if (!result) return;
      setSuccess("已封存，尚未生效：内容不可再改，封存后由 Boss 选择并确认生效。如需修改，请新建草稿。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  if (!canEdit) {
    return <section className="section-panel"><StatusMessage themeAware error="当前账号没有规则草稿编辑权限；生效仅限 Boss。" /></section>;
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <h2 className="text-2xl leading-9 font-semibold">规则与价目</h2>
            <p className="mt-1 text-sm text-muted-foreground">查看当前计价、租期与协议，预览调整后的差异。封存与生效分开，缺配置不会按零报价。</p>
          </div>
          <div className="w-full sm:w-72">
            <Field label="游戏" composite>
              <RulesSelect label="游戏" value={gameId} onChange={setGameId} disabled={command.state.kind === "busy" || command.state.kind === "recovering" || dirty || overviewDirty} placeholder="暂无可维护游戏" options={games.map((game) => ({ value: game.id, label: `${game.name}（${game.code}）` }))} />
            </Field>
          </div>
        </div>
        <StatusMessage themeAware error={error} success={success} className="mt-3" />
        {command.locked ? (
          <Alert variant="warning" role="status" className="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{command.state.kind === "blocked" ? "规则写入已暂停" : command.pending?.receipt ? "已收到原写入回执，回读尚未完成" : command.state.kind === "busy" ? "规则请求正在提交" : "原规则写入结果尚未核清"}</AlertTitle>
            <AlertDescription>
              <p>{command.state.kind === "blocked" ? command.state.message : command.pending?.receipt ? command.state.message ?? "已收到原写入回执，规则回读尚未完成；不能再次提交。" : command.state.kind === "busy" ? "正在提交规则请求，原 key 与版本已保留。" : command.state.message ?? "原规则写入结果尚未核清，已保留原 key 与输入，暂停新的写入。"}</p>
              {command.pending && command.pending.gameId !== gameId ? <p>原请求属于游戏 {command.pending.gameId}，请切回该游戏核对。</p> : null}
            </AlertDescription>
            <AlertAction><Button type="button" variant="outline" size="sm" disabled={!command.pending || command.pending.gameId !== gameId || ["busy", "recovering"].includes(command.state.kind)} onClick={() => void command.recover()}>核对原写入回执</Button></AlertAction>
          </Alert>
        ) : null}
        {command.state.kind === "conflict" ? (
          <Alert variant="danger" className="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>版本已变化（409）</AlertTitle>
            <AlertDescription><p>输入已保留。请核对当前版本后再操作。</p></AlertDescription>
          </Alert>
        ) : command.state.kind === "error" ? (
          <Alert variant="danger" className="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>请求被明确拒绝</AlertTitle>
            <AlertDescription><p>{command.state.message}</p></AlertDescription>
          </Alert>
        ) : null}
        {command.state.kind === "not_sent" ? <p role="status" className="mt-3 text-sm text-muted-foreground">{command.state.message}</p> : null}
        {command.state.kind === "done" && command.state.operation !== RULES_RELEASE_OPERATION ? <p role="status" className="mt-3 text-sm text-muted-foreground">原草稿写入已收到回执并完成回读。</p> : null}
      </section>

      {gamesLoaded && games.length === 0 ? (
        <section className="section-panel"><EmptyHint>还没有可维护的游戏。请先在「目录维护」中创建游戏，再回到这里配置规则。</EmptyHint></section>
      ) : null}
      {!rules && loading ? (
        <section className="section-panel space-y-3" aria-busy="true">
          <p className="sr-only">正在读取规则…</p>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-9 w-full max-w-sm" />
          <div className="flex flex-wrap gap-x-8 gap-y-3 pt-1"><Skeleton className="h-10 w-32" /><Skeleton className="h-10 w-44" /><Skeleton className="h-10 w-36" /></div>
        </section>
      ) : null}

      {rules && rules.game.id === gameId ? (
        <div className="space-y-6">
          <RulesOverview key={`${snapshot.adminUserId}:${rules.game.id}`} rules={rules} command={command} isBoss={isBoss} canPreview={canPreview} canEdit={canEdit} onDirtyChange={setOverviewDirty} />
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="hidden" aria-hidden="true">
          <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start px-0 py-2 text-left whitespace-normal" />}><span className="grid min-w-0 gap-1 sm:flex sm:items-center sm:gap-2"><span className="shrink-0 text-base font-semibold">高级：按版本维护草稿</span><span className="text-sm font-normal text-muted-foreground">出租协议正文、首版建立与原始规则</span></span></CollapsibleTrigger>
          <CollapsibleContent keepMounted><div className="mt-4 space-y-6">
          <p className="text-xs text-muted-foreground">日常调价请用上方「编辑规则」。这里逐个版本维护草稿；封存后内容只读，才能被 Boss 选中生效。</p>
          <section className="section-panel">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">价格版本</h3>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-44"><RulesSelect label="新草稿计价方式" value={priceMode} onChange={(value) => setPriceMode(value as "SPREAD" | "PERCENT")} options={[{ value: "SPREAD", label: "差价（SPREAD）" }, { value: "PERCENT", label: "百分比（PERCENT）" }]} /></div>
                <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createPrice)}>新建价格草稿</BusyButton>
              </div>
            </div>
            {rules.priceVersions.length === 0 ? (
              <div className="mt-3"><EmptyHint>还没有价格版本。选择计价方式后点击「新建价格草稿」开始。</EmptyHint></div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <div className="w-full sm:w-80"><RulesSelect label="价格版本" value={priceId} onChange={(value) => selectPrice(value)} options={rules.priceVersions.map((version) => ({ value: version.id, label: `${modeLabel(version.mode)} · ${statusLabel(version.status)} · 修订 ${version.revision}` }))} /></div>
                {selectedPrice?.status === "DRAFT" && !priceReadOnly ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="封存后由 Boss 选择并确认生效" busyText="封存中…" onClick={() => void guard(() => seal("price", selectedPrice.id, selectedPrice.revision))}>封存版本</BusyButton> : null}
              </div>
            )}
            {selectedPrice && priceReadOnly ? (
              <div className="mt-4 space-y-3">
                <p role="status" className="text-xs text-muted-foreground">此规则版本尚不支持编辑，仅可查看。</p>
                <pre className="overflow-auto text-xs">{JSON.stringify(selectedPrice.haffRule, null, 2)}</pre>
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader><TableRow><TableHead>物品</TableHead><TableHead>档位</TableHead><TableHead>计价方式</TableHead><TableHead>单位数量</TableHead><TableHead>租客单价</TableHead><TableHead>号主单价</TableHead></TableRow></TableHeader>
                    <TableBody>{rules.priceLines.filter((line) => line.priceVersionId === selectedPrice.id).map((line) => (
                      <TableRow key={`${line.itemId}:${line.customerTier ?? "STANDARD"}`}>
                        <TableCell>{items.find((item) => item.id === line.itemId)?.name ?? line.itemId}</TableCell>
                        <TableCell>{line.customerTier ?? "STANDARD"}</TableCell><TableCell>{kindLabel(line.pricingKind)}</TableCell>
                        <TableCell>{line.unitQuantity ?? "未配置"}</TableCell><TableCell>{line.buyerUnitAmount ?? "未配置"}</TableCell><TableCell>{line.ownerUnitAmount ?? "未配置"}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </div>
              </div>
            ) : null}
            {selectedPrice && !priceReadOnly ? (
              <form onSubmit={(event) => { event.preventDefault(); void guard(() => savePrice(event)); }} className="mt-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Field label="封存状态" composite><div className="h-9 flex items-center text-xs">{selectedPrice.status === "SEALED" ? "已封存（只读）" : "草稿（可修改）"}</div></Field>
                  {priceMode === "PERCENT" ? (
                    <Field label="平台抽成比例（0–1）">
                      <Input value={commissionRate} disabled={selectedPrice.status === "SEALED" || command.locked} onChange={(event) => { setCommissionRate(event.target.value); setDirty(true); }} className={inputClass} placeholder="0.2" />
                    </Field>
                  ) : null}
                  <Field label="价目档位" composite><RulesSelect label="价目档位" value={priceTier} onChange={(value) => setPriceTier(value as PriceTier)} options={PRICE_TIERS.map((tier) => ({ value: tier, label: tier }))} /></Field>
                </div>
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader><TableRow><TableHead>物品</TableHead><TableHead>计价方式</TableHead><TableHead>单位数量</TableHead><TableHead>租客单价</TableHead><TableHead>号主单价</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {items.map((item) => {
                        const key = item.id + ":" + priceTier;
                        const line = lines[key];
                        if (!line) return null;
                        const sealed = selectedPrice.status === "SEALED";
                        return (
                          <TableRow key={item.id}>
                            <TableCell><span className="font-medium">{item.name}</span> <span className="text-[11px] text-muted-foreground">{item.code}</span></TableCell>
                            <TableCell>{kindLabel(line.pricingKind)}</TableCell>
                            <TableCell className="min-w-28">{line.pricingKind === "HAFF_RATIO" ? "—" : <Input aria-label={`${item.name} 单位数量`} value={line.unitQuantity} disabled={sealed || command.locked} onChange={(event) => { setLines({ ...lines, [key]: { ...line, unitQuantity: event.target.value } }); setDirty(true); }} className={inputClass} />}</TableCell>
                            <TableCell className="min-w-28">{line.pricingKind === "HAFF_RATIO" ? "—" : <Input aria-label={`${item.name} 租客单价`} value={line.buyerUnitAmount} disabled={sealed || command.locked} onChange={(event) => { setLines({ ...lines, [key]: { ...line, buyerUnitAmount: event.target.value } }); setDirty(true); }} className={inputClass} placeholder="2.5" />}</TableCell>
                            <TableCell className="min-w-28">{line.pricingKind === "HAFF_RATIO" || priceMode === "PERCENT" ? "—" : <Input aria-label={`${item.name} 号主单价`} value={line.ownerUnitAmount} disabled={sealed || command.locked} onChange={(event) => { setLines({ ...lines, [key]: { ...line, ownerUnitAmount: event.target.value } }); setDirty(true); }} className={inputClass} placeholder="2" />}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <Collapsible open={haffRawOpen} onOpenChange={setHaffRawOpen} className="rounded-md border border-border px-3 py-2">
                  <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-auto justify-start px-0 py-2 text-left whitespace-normal" />}>高级：哈夫币规则（JSON，保留原 schema）</CollapsibleTrigger>
                  <CollapsibleContent keepMounted><div className="mt-2">
                    <Field label="哈夫币规则 JSON（比例单位按该版本合同）">
                      <Textarea value={haffRuleText} disabled={selectedPrice.status === "SEALED" || command.locked} onChange={(event) => { setHaffRuleText(event.target.value); setDirty(true); }} className={textareaClass} />
                    </Field>
                  </div></CollapsibleContent>
                </Collapsible>
                {selectedPrice.status === "DRAFT" ? <BusyButton type="submit" busy={loading} disabled={command.locked} busyText="保存中…">保存价格草稿</BusyButton> : null}
              </form>
            ) : null}
          </section>

          <section className="section-panel">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">租期版本</h3>
              <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createTerm)}>新建租期草稿</BusyButton>
            </div>
            {rules.termVersions.length === 0 ? (
              <div className="mt-3"><EmptyHint>还没有租期版本。点击「新建租期草稿」，再添加租期档位。</EmptyHint></div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <div className="w-full sm:w-80"><RulesSelect label="租期版本" value={termId} onChange={(value) => applyTerm(value, rules.termOptions)} options={rules.termVersions.map((version) => ({ value: version.id, label: `${statusLabel(version.status)} · 修订 ${version.revision}` }))} /></div>
                {selectedTerm?.status === "DRAFT" ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="封存后由 Boss 选择并确认生效" busyText="封存中…" onClick={() => void guard(() => seal("term", selectedTerm.id, selectedTerm.revision))}>封存版本</BusyButton> : null}
              </div>
            )}
            {selectedTerm ? (
              <form onSubmit={(event) => { event.preventDefault(); void guard(() => saveTerm(event)); }} className="mt-4 space-y-3">
                <div className="rounded-md border border-border">
                  <Table>
                    <TableHeader><TableRow><TableHead>选项编码</TableHead><TableHead>名称</TableHead><TableHead>日消耗（基础哈夫币）</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
                    <TableBody>
                      {termOptions.length === 0 ? (
                        <TableRow><TableCell colSpan={4} className="text-xs text-muted-foreground">还没有租期档位。{selectedTerm.status === "DRAFT" ? "点击「添加档位」后保存草稿。" : ""}</TableCell></TableRow>
                      ) : termOptions.map((option, index) => (
                        <TableRow key={index}>
                          <TableCell><Input aria-label="选项编码" value={option.code} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, code: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                          <TableCell><Input aria-label="名称" value={option.name} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                          <TableCell><Input aria-label="日消耗" value={option.dailyConsumption} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, dailyConsumption: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                          <TableCell className="w-20">{selectedTerm.status === "DRAFT" ? <Button type="button" size="sm" variant="ghost" onClick={() => { setTermOptions(termOptions.filter((_, itemIndex) => itemIndex !== index)); setDirty(true); }}>删除</Button> : null}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {selectedTerm.status === "DRAFT" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" onClick={() => { setTermOptions([...termOptions, { code: `daily-${termOptions.length + 1}`, name: "新档位", dailyConsumption: "10000000" }]); setDirty(true); }}>添加档位</Button>
                    <BusyButton type="submit" busy={loading} disabled={command.locked} busyText="保存中…">保存租期草稿</BusyButton>
                  </div>
                ) : null}
              </form>
            ) : null}
          </section>

          <section className="section-panel">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">协议版本</h3>
              <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createAgreement)}>新建协议草稿</BusyButton>
            </div>
            {rules.agreementVersions.length === 0 ? (
              <div className="mt-3"><EmptyHint>还没有出租协议版本。点击「新建协议草稿」后填写标题与正文。</EmptyHint></div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <div className="w-full sm:w-96"><RulesSelect label="协议版本" value={agreementId} onChange={(value) => { const record = rules.agreementVersions.find((version) => version.id === value); setAgreementId(value); setAgreementTitle(record?.title ?? ""); setAgreementBody(record?.body ?? ""); setDirty(false); }} options={rules.agreementVersions.map((version) => ({ value: version.id, label: `${version.title} · ${statusLabel(version.status)} · 修订 ${version.revision}` }))} /></div>
                {selectedAgreement?.status === "DRAFT" ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="封存后由 Boss 选择并确认生效" busyText="封存中…" onClick={() => void guard(() => seal("agreement", selectedAgreement.id, selectedAgreement.revision))}>封存版本</BusyButton> : null}
              </div>
            )}
            {selectedAgreement ? (
              <form onSubmit={(event) => { event.preventDefault(); void guard(() => saveAgreement(event)); }} className="mt-4 space-y-3">
                <Field label="标题"><Input value={agreementTitle} disabled={selectedAgreement.status === "SEALED" || command.locked} onChange={(event) => { setAgreementTitle(event.target.value); setDirty(true); }} className={inputClass} /></Field>
                <Field label="正文（纯文本）"><Textarea value={agreementBody} disabled={selectedAgreement.status === "SEALED" || command.locked} onChange={(event) => { setAgreementBody(event.target.value); setDirty(true); }} className={textareaClass} /></Field>
                {selectedAgreement.status === "DRAFT" ? <BusyButton type="submit" busy={loading} disabled={command.locked} busyText="保存中…">保存协议草稿</BusyButton> : null}
              </form>
            ) : null}
          </section>

          </div></CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
    </div>
  );
}
