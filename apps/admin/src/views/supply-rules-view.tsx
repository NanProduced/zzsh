import { versionTime } from "./supply-rules/publish-flow";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";

import { adminRequest, friendlyError, hasPermission, type RulesResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { StatusMessage } from "../components/ui-elements";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Skeleton } from "../components/ui/skeleton";
import { Input } from "../components/ui/input";
import { SupplySelect } from "../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { RulesOverview, SettlementRules } from "./supply-rules/rules-overview";
import { draftCommand, RULES_RELEASE_OPERATION, useRulesWrite } from "./supply-rules/rules-write";
import { SkinDepositPolicyEditor } from "./supply-rules/skin-deposit-policy-editor";
import { RentalModeEditor } from "./supply-rules/rental-mode-editor";
import { FullPayoutTermsPanel } from "./supply-rules/full-payout-terms-panel";
import { BasePricingEditor, DepositCapEditor, PriceItemsEditor, type EnsureDraft } from "./supply-rules/step0-editors";
import { activePriceDraft, pendingSealedPrice, docStage, DocStatusRow, PublishBar } from "./supply-rules/publish-flow";
import { sourcePriceVersion } from "./supply-rules/price-draft";
import { LegalDocumentsPanel } from "./legal-documents-panel";
import { RulesMarkdownField } from "./supply-rules/rules-markdown-field";

const inputClass = "h-9";

type TermOptionDraft = { code: string; name: string; dailyConsumption: string };

/** 规则页分区：同一页签内切换，全部保持挂载，切换不丢未保存输入。 */
export const RULES_SECTIONS = ["overview", "deposit", "settlement", "agreement", "pricing", "items", "skin"] as const;
export type RulesSection = typeof RULES_SECTIONS[number];
export const RULES_SECTION_LABEL: Record<RulesSection, string> = { overview: "规则总览", deposit: "押金规则", settlement: "结算与退赔", agreement: "出租协议", pricing: "租赁定价", items: "物资价目", skin: "皮肤推荐押金" };
export function rulesSection(value: string | undefined): RulesSection {
  return (RULES_SECTIONS as readonly string[]).includes(value ?? "") ? value as RulesSection : "overview";
}
const PRICING_TABS = [["base", "基础计价"], ["mode", "租赁模式"], ["term", "租期与每日消耗"]] as const;
/** 三角洲行动专属分区；其他游戏显示未适配。 */
export const DELTA_GAME_CODE = "delta";

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
  section: sectionQuery,
  draft: draftQuery,
  onOpenPath,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
  section?: string;
  /** 显式指定要编辑的价格草稿（深链接）；不会自动切换。 */
  draft?: string;
  onOpenPath?: (path: string) => void;
}) {
  const requestedSection = rulesSection(sectionQuery);
  // 分区切换：有未保存的价格草稿输入时先确认，避免切走后误以为已保存
  const [section, setSection] = useState<RulesSection>(requestedSection);
  const [leaveAsk, setLeaveAsk] = useState<RulesSection | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const canEdit = hasPermission(snapshot, "supply.rules.edit");
  const canPreview = hasPermission(snapshot, "supply.quote.internal.read");
  const canLegal = snapshot.security.isBoss || ["content.platform.read", "content.platform.edit", "content.platform.publish"].some(p => hasPermission(snapshot, p));
  const isBoss = snapshot.security.isBoss;
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [rules, setRules] = useState<RulesResponse | null>(null);
  void draftQuery;
  const [pricingTab, setPricingTab] = useState<typeof PRICING_TABS[number][0]>("base");
  const [termId, setTermId] = useState("");
  const [agreementId, setAgreementId] = useState("");
  const [termOptions, setTermOptions] = useState<TermOptionDraft[]>([]);
  const [agreementTitle, setAgreementTitle] = useState("");
  const [agreementBody, setAgreementBody] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [activateAsk, setActivateAsk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sealAsk, setSealAsk] = useState<{ kind: "term" | "agreement"; id: string; revision: string; label: string } | null>(null);
  const [switchAsk, setSwitchAsk] = useState<{ kind: "term" | "agreement"; id: string } | null>(null);
  const [depositDirty, setDepositDirty] = useState(false);
  const [modeDirty, setModeDirty] = useState(false);
  const [capDirty, setCapDirty] = useState(false);
  const [baseDirty, setBaseDirty] = useState(false);
  const [dailyDirty, setDailyDirty] = useState(false);
  const [itemsDirty, setItemsDirty] = useState(false);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const priceDirty = depositDirty || modeDirty || capDirty || baseDirty || dailyDirty || itemsDirty;
  const anyDirty = dirty || priceDirty;
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
    if (requestedSection === section) { setLeaveAsk(null); return; }
    if (priceDirty) { setLeaveAsk(requestedSection); return; }
    setSection(requestedSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSection]);
  const stayInSection = () => { setLeaveAsk(null); onOpenPath?.(`/supply/rules?section=${section}`); };
  const leaveSection = () => {
    if (!leaveAsk) return;
    setDepositDirty(false); setModeDirty(false); setCapDirty(false); setBaseDirty(false); setDailyDirty(false); setItemsDirty(false);
    setResetNonce(n => n + 1); setSection(leaveAsk); setLeaveAsk(null);
  };

  useEffect(() => {
    onDirtyChange(anyDirty);
  }, [anyDirty, onDirtyChange]);

  const loadGames = useCallback(async () => {
    const sequence = ++gamesSeq.current;
    if (!canEdit) return;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    if (sequence !== gamesSeq.current) return;
    setGames(result.games);
    setGamesLoaded(true);
    // 规则与价目当前只适配三角洲行动：按 game.code 解析，不提供游戏选择器。
    setGameId(result.games.find(game => game.code === DELTA_GAME_CODE)?.id ?? "");
  }, [canEdit, snapshot.adminUserId, snapshot.session?.id, snapshot.security.isBoss]);

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
    const nextTerm = latestSealed(result.termVersions) || result.termVersions[0]?.id || "";
    applyTerm(nextTerm, result.termOptions);
    const nextAgreement = latestSealed(result.agreementVersions) || result.agreementVersions[0]?.id || "";
    setAgreementId(nextAgreement);
    const agreement = result.agreementVersions.find((version) => version.id === nextAgreement);
    setAgreementTitle(agreement?.title ?? "");
    setAgreementBody(agreement?.body ?? "");
    setDirty(false);
  }, [applyTerm]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setRules(null); setGames([]); setGamesLoaded(false); setGameId(""); setDirty(false);
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

  const selectedTerm = rules?.termVersions.find((version) => version.id === termId);
  const selectedAgreement = rules?.agreementVersions.find((version) => version.id === agreementId);
  const items = rules?.items ?? [];

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
      setSuccess("已保存草稿。");
      setDirty(false);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const [agreementReceipt, setAgreementReceipt] = useState<{ at: string; text: string } | null>(null);
  const activateAgreement = async (id: string) => {
    const release = rules?.release;
    if (!release) return;
    setError(undefined);
    try {
      const r = await command.write({ operation: RULES_RELEASE_OPERATION, resourceId: gameId, gameId, path: "/supply/releases", method: "POST", body: { gameId, priceVersionId: release.priceVersionId, termVersionId: release.termVersionId, agreementVersionId: id, expectedGeneration: release.generation } });
      if (!r) return;
      setAgreementReceipt({ at: r.fresh.release?.activatedAt ?? new Date().toISOString(), text: "已生效。新订单使用这份协议，已有订单不变。" });
    } catch (failure) { setError(friendlyError(failure)); }
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
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, kind, "seal", { expectedRevision: revision }, id));
      if (!result) return;
      setSuccess(isBoss ? "已提交。核对后点“确认生效”。" : "已提交，等 Boss 确认生效。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };


  if (!canEdit) {
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有规则草稿编辑权限；生效仅限 Boss。" /></section>;
  }

  const deltaSection = ["pricing", "items", "skin", "deposit"].includes(section);
  const show = (name: RulesSection) => (section === name ? undefined : true);
  const editorKey = `${snapshot.adminUserId}:${snapshot.session?.id}:${rules?.game.id}:${resetNonce}`;
  // 只有一份进行中的价格草稿：自动取它；没有时显示线上值，第一次保存时自动新建。
  const draftId = rules ? activePriceDraft(rules)?.id ?? pendingSealedPrice(rules)?.id ?? "" : "";
  const ensureDraft: EnsureDraft = async () => {
    if (!rules) return null;
    const existing = activePriceDraft(rules);
    if (existing) return { rules, draft: existing };
    const source = sourcePriceVersion(rules);
    const result = await command.write(draftCommand(rules.game.id, "price", "create", { gameId: rules.game.id, mode: source?.mode ?? "SPREAD" }));
    const draft = result?.fresh.priceVersions.find(v => v.id === result.receipt.id);
    return result && draft ? { rules: result.fresh, draft } : null;
  };
  const editorProps = rules ? { rules, command, draftId, canEdit, ensureDraft } : null;
  const commitSwitch = () => {
    if (!switchAsk || !rules) return;
    if (switchAsk.kind === "term") applyTerm(switchAsk.id, rules.termOptions);
    else {
      const record = rules.agreementVersions.find((version) => version.id === switchAsk.id);
      setAgreementId(switchAsk.id);
      setAgreementTitle(record?.title ?? "");
      setAgreementBody(record?.body ?? "");
    }
    setDirty(false);
    setSwitchAsk(null);
  };

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="min-w-0 max-w-3xl">
          <h2 className="flex flex-wrap items-center gap-2 text-2xl leading-9 font-semibold">{RULES_SECTION_LABEL[section]}{rules ? <span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">{rules.game.name}</span> : null}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{section === "overview" ? "线上正在用的规则和历史。" : section === "settlement" ? "全额包赔谁承担、提前结束怎么补差。" : section === "agreement" ? "租客下单时阅读的出租协议。" : deltaSection ? "改完保存为草稿，提交后由 Boss 确认生效。" : ""}</p>
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
          <Alert variant="warning" role="alert" className="mt-3">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>版本已变化（409）</AlertTitle>
            <AlertDescription><p>输入已保留。请核对当前版本后再操作。</p></AlertDescription>
          </Alert>
        ) : command.state.kind === "error" ? (
          <Alert variant="destructive" className="mt-3">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>请求被明确拒绝</AlertTitle>
            <AlertDescription><p>{command.state.message}</p></AlertDescription>
          </Alert>
        ) : null}
        {command.state.kind === "not_sent" ? <p role="status" className="mt-3 text-sm text-muted-foreground">{command.state.message}</p> : null}
        {command.state.kind === "done" && command.state.operation !== RULES_RELEASE_OPERATION ? <p role="status" className="mt-3 text-sm text-muted-foreground">已保存到草稿。</p> : null}
      </section>

      {gamesLoaded && !gameId ? (
        <section className="section-panel"><EmptyHint>未适配：规则与价目目前只适配三角洲行动（delta）。其他游戏的规则暂未接入，请先在「目录维护」中确认游戏。</EmptyHint></section>
      ) : null}
      {!rules && loading ? (
        <section className="section-panel space-y-3" aria-busy="true">
          <p className="sr-only">正在读取规则…</p>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-9 w-full max-w-sm" />
        </section>
      ) : null}

      {rules && editorProps && rules.game.id === gameId ? (
        <div className="space-y-6">
          {deltaSection ? <PublishBar rules={rules} command={command} dirty={priceDirty} canEdit={canEdit} isBoss={isBoss} onOpenSection={(name) => onOpenPath?.(`/supply/rules?section=${name}`)} /> : null}
          <div hidden={show("overview")}><RulesOverview key={`${snapshot.adminUserId}:${rules.game.id}`} rules={rules} command={command} isBoss={isBoss} canPreview={canPreview} canEdit={canEdit} onOpenSkin={() => onOpenPath?.("/supply/rules?section=skin")} onOpenSettlement={() => onOpenPath?.("/supply/rules?section=settlement")} /></div>
          <div hidden={show("deposit")}><DepositCapEditor key={`cap:${editorKey}`} {...editorProps} onDirtyChange={setCapDirty} /></div>
          <div hidden={show("settlement")} className="space-y-6"><section className="section-panel" aria-label="结算与退赔"><p className="mb-3 text-xs text-muted-foreground">谁承担、怎么补差按已生效规则执行，费率不能在这里改。条款正文在下方维护。</p><SettlementRules /></section><FullPayoutTermsPanel gameId={gameId} versions={rules.fullPayoutTermsVersions ?? []} canEdit={canEdit} isBoss={isBoss} live={(() => { const fp = rules.priceVersions.find(v => v.id === rules.release?.priceVersionId)?.fundingPolicy; return fp ? { ref: fp.fullPayoutPolicyRef, version: fp.fullPayoutPolicyVersion } : null; })()} onReload={reload} /></div>
          <div hidden={show("pricing")} className="space-y-4">
            <div role="tablist" aria-label="租赁定价" className="flex flex-wrap gap-2">{PRICING_TABS.map(([value, label]) => <Button key={value} type="button" role="tab" aria-selected={pricingTab === value} variant={pricingTab === value ? "secondary" : "ghost"} onClick={() => setPricingTab(value)}>{label}</Button>)}</div>
            <div hidden={pricingTab !== "base" || undefined}><BasePricingEditor key={`base:${editorKey}`} {...editorProps} part="base" onDirtyChange={setBaseDirty} /></div>
            <div hidden={pricingTab !== "mode" || undefined}><RentalModeEditor key={`mode:${editorKey}`} rules={rules} command={command} canEdit={canEdit} draftId={draftId} ensureDraft={ensureDraft} onDirtyChange={setModeDirty} /></div>
            <div hidden={pricingTab !== "term" || undefined} className="space-y-6"><BasePricingEditor key={`daily:${editorKey}`} {...editorProps} part="term" onDirtyChange={setDailyDirty} />
        <section className="section-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">租期版本</h3>
            <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createTerm)}>新建租期草稿</BusyButton>
          </div>
          {rules.termVersions.length === 0 ? (
            <div className="mt-3"><EmptyHint>还没有租期版本。点击「新建租期草稿」，再添加租期档位。</EmptyHint></div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <div className="w-full sm:w-80"><RulesSelect label="租期版本" value={termId} onChange={(value) => { if (dirty && value !== termId) { setSwitchAsk({ kind: "term", id: value }); return; } applyTerm(value, rules.termOptions); }} options={rules.termVersions.map((version) => ({ value: version.id, label: `${version.id === rules.release?.termVersionId ? "当前生效" : statusLabel(version.status)}${versionTime(version) ? " · " + versionTime(version) : ""}` }))} /></div>
              {selectedTerm?.status === "DRAFT" ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="提交后锁定，Boss 确认生效后替换线上" busyText="提交中…" onClick={() => setSealAsk({ kind: "term", id: selectedTerm.id, revision: selectedTerm.revision, label: `租期 · 第 ${selectedTerm.revision} 次修改 · #${selectedTerm.id.slice(-6)}` })}>封存版本</BusyButton> : null}
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
            </div>
          </div>
          <div hidden={show("items")}><PriceItemsEditor key={`items:${editorKey}`} {...editorProps} onDirtyChange={setItemsDirty} /></div>
          <div hidden={show("skin")}><SkinDepositPolicyEditor key={`${editorKey}`} rules={rules} command={command} draftId={draftId} ensureDraft={ensureDraft} onDirtyChange={setDepositDirty} /></div>
          <div hidden={show("agreement")} className="space-y-6">
        <section className="section-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">协议版本</h3>
            <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createAgreement)}>新建协议草稿</BusyButton>
          </div>
          {rules.agreementVersions.length === 0 ? (
            <div className="mt-3"><EmptyHint>还没有出租协议版本。点击「新建协议草稿」后填写标题与正文。</EmptyHint></div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <div className="w-full min-w-0 sm:w-96"><RulesSelect label="协议版本" value={agreementId} onChange={(value) => { if (dirty && value !== agreementId) { setSwitchAsk({ kind: "agreement", id: value }); return; } const record = rules.agreementVersions.find((version) => version.id === value); setAgreementId(value); setAgreementTitle(record?.title ?? ""); setAgreementBody(record?.body ?? ""); setDirty(false); }} options={rules.agreementVersions.map((version) => ({ value: version.id, label: `${version.title} · ${version.id === rules.release?.agreementVersionId ? "线上" : version.status === "DRAFT" ? "草稿" : "已提交"}${versionTime(version) ? " · " + versionTime(version) : ""}` }))} /></div>
              {selectedAgreement?.status === "DRAFT" ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="提交后锁定，Boss 确认生效后替换线上" busyText="提交中…" onClick={() => setSealAsk({ kind: "agreement", id: selectedAgreement.id, revision: selectedAgreement.revision, label: selectedAgreement.title })}>提交发布</BusyButton> : null}
            </div>
          )}
          {selectedAgreement ? (() => { const live = selectedAgreement.id === rules.release?.agreementVersionId; const st = docStage(selectedAgreement, { dirty, live, after: rules.release?.activatedAt }); return <div className="mt-3"><DocStatusRow stage={st} at={live ? rules.release?.activatedAt : null} receipt={agreementReceipt} note={st === "unsaved" ? "有输入还没保存" : st === "draft" ? "草稿，线上还没变" : st === "sealed" ? (isBoss ? "已提交，等你确认生效" : "已提交，等 Boss 确认生效") : st === "live" ? "租客下单时看到的就是这份" : "旧版本，只读"}>{st === "sealed" && isBoss ? <BusyButton type="button" size="sm" busy={loading} disabled={command.locked || !rules.release} onClick={() => setActivateAsk(selectedAgreement.id)}>确认生效</BusyButton> : null}</DocStatusRow></div>; })() : null}
          {selectedAgreement ? (
            <form onSubmit={(event) => { event.preventDefault(); void guard(() => saveAgreement(event)); }} className="mt-4 space-y-3">
              <Field label="标题"><Input value={agreementTitle} disabled={selectedAgreement.status === "SEALED" || command.locked} onChange={(event) => { setAgreementTitle(event.target.value); setDirty(true); }} className={inputClass} /></Field>
              <RulesMarkdownField label="协议正文" hint={selectedAgreement.status === "SEALED" ? "已提交，只读；要修改请新建协议草稿" : "支持 Markdown（标题、列表、加粗）；租客下单时阅读的就是这份正文"} value={agreementBody} disabled={selectedAgreement.status === "SEALED" || command.locked} onChange={(value) => { setAgreementBody(value); setDirty(true); }} />
              {selectedAgreement.status === "DRAFT" ? <BusyButton type="submit" busy={loading} disabled={command.locked} busyText="保存中…">保存协议草稿</BusyButton> : null}
            </form>
          ) : null}
        </section>

            {canLegal && section === "agreement" ? <section className="section-panel space-y-3" aria-label="法律文书"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">法律文书（参考）</h3>{onOpenPath ? <Button type="button" variant="ghost" size="sm" onClick={() => onOpenPath("/content?tab=legal")}>在内容管理中打开</Button> : null}</div><LegalDocumentsPanel snapshot={snapshot} /></section> : null}
          </div>
        </div>
      ) : null}
      <Dialog open={activateAsk !== null} onOpenChange={(open) => { if (!open) setActivateAsk(null); }}><DialogContent closeLabel="取消"><DialogHeader><DialogTitle>让这份协议生效？</DialogTitle><DialogDescription>确认后新订单立即使用这份协议；价格和租期不变。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setActivateAsk(null)}>取消</Button><Button type="button" onClick={() => { const id = activateAsk; setActivateAsk(null); if (id) void guard(() => activateAgreement(id)); }}>确认生效</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={sealAsk !== null} onOpenChange={(open) => { if (!open) setSealAsk(null); }}><DialogContent closeLabel="取消"><DialogHeader><DialogTitle>提交这个版本？</DialogTitle><DialogDescription>{sealAsk ? `${sealAsk.label}。提交后锁定，Boss 确认生效后才替换线上。` : ""}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setSealAsk(null)}>取消</Button><Button type="button" onClick={() => { const ask = sealAsk; setSealAsk(null); if (ask) void guard(() => seal(ask.kind, ask.id, ask.revision)); }}>确认提交</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={leaveAsk !== null} onOpenChange={(open) => { if (!open) stayInSection(); }}><DialogContent closeLabel="继续编辑"><DialogHeader><DialogTitle>价格草稿还有未保存的输入</DialogTitle><DialogDescription>切换到「{leaveAsk ? RULES_SECTION_LABEL[leaveAsk] : ""}」会丢掉这些输入；已保存到草稿的内容不受影响。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={stayInSection}>继续编辑</Button><Button type="button" onClick={leaveSection}>放弃并切换</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={switchAsk !== null} onOpenChange={(open) => { if (!open) setSwitchAsk(null); }}><DialogContent closeLabel="继续编辑"><DialogHeader><DialogTitle>放弃未保存的内容并切换版本？</DialogTitle><DialogDescription>当前标题、正文或租期档位还没保存。切换后这些输入会丢掉。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setSwitchAsk(null)}>继续编辑</Button><Button type="button" onClick={commitSwitch}>放弃并切换</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
