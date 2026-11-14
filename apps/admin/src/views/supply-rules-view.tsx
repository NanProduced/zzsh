import { useCallback, useEffect, useRef, useState } from "react";

import { adminRequest, friendlyError, hasPermission, type RulesResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { StatusMessage } from "../components/ui-elements";
import { Skeleton } from "../components/ui/skeleton";
import { AgreementSection } from "./supply-rules/agreement-section";
import { DepositSection } from "./supply-rules/deposit-section";
import { CreateFixedDraftDialog, FixedFeeDraftPanel } from "./supply-rules/fixed-fee-draft-panel";
import { sourcePriceVersion } from "./supply-rules/price-draft";
import { PricingSection } from "./supply-rules/pricing-section";
import { activePriceDraft, pendingSealedPrice, PublishBar } from "./supply-rules/publish-flow";
import { RulesDialogs } from "./supply-rules/rules-dialogs";
import { DELTA_GAME_CODE, latestSealed, rulesSection, type PricingTab, type RulesSection, type TermOptionDraft } from "./supply-rules/rules-nav";
import { RulesOverview, ConfirmDialog } from "./supply-rules/rules-overview";
import { RulesPageHeader } from "./supply-rules/rules-page-header";
import { draftCommand, useRulesWrite } from "./supply-rules/rules-write";
import { EmptyHint } from "./supply-rules/rules-widgets";
import { SettlementSection } from "./supply-rules/settlement-section";
import { SkinDepositPolicyEditor } from "./supply-rules/skin-deposit-policy-editor";
import { PriceItemsEditor, type EnsureDraft } from "./supply-rules/step0-editors";

export {
  DELTA_GAME_CODE,
  RULES_SECTION_LABEL,
  RULES_SECTIONS,
  rulesSection,
} from "./supply-rules/rules-nav";
export type { RulesSection } from "./supply-rules/rules-nav";

export function SupplyRulesView({
  snapshot,
  onDirtyChange,
  refreshNonce = 0,
  section: sectionQuery,
  onOpenPath,
  agreementVersion,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
  section?: string;
  onOpenPath?: (path: string) => void;
  agreementVersion?: string;
}) {
  const requestedSection = rulesSection(sectionQuery);
  // 分区切换：有未保存的价格草稿输入时先确认，避免切走后误以为已保存
  const [section, setSection] = useState<RulesSection>(requestedSection);
  const [leaveAsk, setLeaveAsk] = useState<RulesSection | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const canEdit = hasPermission(snapshot, "supply.rules.edit");
  const canPreview = canEdit && hasPermission(snapshot, "supply.quote.internal.read");
  const isBoss = snapshot.security.isBoss;
  const canSchedule = isBoss && canEdit && hasPermission(snapshot, "supply.rules.activate");
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const currentPrice = rules?.priceVersions.find(version => version.id === rules.release?.priceVersionId);
  const pricingVersion = rules?.newListingPrice === undefined ? currentPrice : rules.priceVersions.find(v => v.id === rules.newListingPrice?.priceVersionId);
  const fixedFee = Boolean(pricingVersion?.fixedFeeRates);
  const priceEditable = canEdit && !fixedFee && rules?.newListingPrice !== null && (!rules?.release || Boolean(pricingVersion));
  const [editingFixedDraft, setEditingFixedDraft] = useState(false);
  const [createFixedOpen, setCreateFixedOpen] = useState(false);
  const [initialRates, setInitialRates] = useState({ ordinary: "", custom: "", fast: "" });
  const [pricingTab, setPricingTab] = useState<PricingTab>("base");
  const [termId, setTermId] = useState("");
  const [agreementId, setAgreementId] = useState("");

  const [termOptions, setTermOptions] = useState<TermOptionDraft[]>([]);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [fundingVersion, setFundingVersion] = useState("");
  const [payoutTermsId, setPayoutTermsId] = useState("");
  const [scheduleAsk, setScheduleAsk] = useState<{ priceVersionId?: string; agreementVersionId?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sealAsk, setSealAsk] = useState<{ kind: "term"; id: string; revision: string; label: string } | null>(null);
  const [switchAsk, setSwitchAsk] = useState<{ kind: "term"; id: string } | null>(null);
  const [depositDirty, setDepositDirty] = useState(false);
  const [modeDirty, setModeDirty] = useState(false);
  const [capDirty, setCapDirty] = useState(false);
  const [baseDirty, setBaseDirty] = useState(false);
  const [dailyDirty, setDailyDirty] = useState(false);
  const [itemsDirty, setItemsDirty] = useState(false);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const priceDirty = depositDirty || modeDirty || capDirty || baseDirty || dailyDirty || itemsDirty || Boolean(fundingVersion || payoutTermsId);
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
    setFundingVersion(""); setPayoutTermsId("");
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
    const currentFixed = result.priceVersions.some(price => price.id === result.release?.priceVersionId && price.fixedFeeRates);
    const nextTerm = (currentFixed ? result.release?.termVersionId : latestSealed(result.termVersions)) || result.termVersions[0]?.id || "";
    applyTerm(nextTerm, result.termOptions);
    const nextAgreement = (currentFixed ? result.release?.agreementVersionId : latestSealed(result.agreementVersions)) || result.agreementVersions[0]?.id || "";
    setAgreementId(nextAgreement);
    setDirty(false);
  }, [applyTerm]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setRules(null); setGames([]); setGamesLoaded(false); setGameId(""); setDirty(false); setFundingVersion(""); setPayoutTermsId("");
    setEditingFixedDraft(false); setCreateFixedOpen(false); setInitialRates({ ordinary: "", custom: "", fast: "" });
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

  const tradePath = (trade: "agreement" | "full_payout_terms", version?: string | null) =>
    "/content/legal?" + new URLSearchParams({ trade, gameId, ...(version ? { version } : {}) });
  useEffect(() => {
    if (agreementVersion && rules?.agreementVersions.some(version => version.id === agreementVersion)) setAgreementId(agreementVersion);
  }, [agreementVersion, rules]);

  if (!canEdit) {
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有规则草稿编辑权限；生效仅限 Boss。" /></section>;
  }

  const deltaSection = ["pricing", "items", "skin", "deposit"].includes(section);
  const showSchedules = section === "pricing" && pricingTab === "schedule";
  const show = (name: RulesSection) => (section === name ? undefined : true);
  const editorKey = `${snapshot.adminUserId}:${snapshot.session?.id}:${rules?.game.id}:${resetNonce}:${editingFixedDraft}`;
  const fixedDraft = rules?.priceVersions.find(v => v.status === "DRAFT" && v.fixedFeeRates);
  const fixedEditor = fixedFee || Boolean(editingFixedDraft && fixedDraft);
  const draftId = fixedEditor ? fixedDraft?.id ?? "" : rules && priceEditable ? activePriceDraft(rules)?.id ?? pendingSealedPrice(rules)?.id ?? "" : "";
  const canCreateFixed = !fixedFee && Boolean(rules?.newListingPrice && rules.ruleScheduling?.available);
  const recoverRulesWrite = async () => {
    const result = await command.recover();
    const recoveredDraft = result?.fresh.priceVersions.find(version => version.id === result.receipt.id && version.status === "DRAFT" && version.fixedFeeRates);
    if (createFixedOpen && recoveredDraft) { setCreateFixedOpen(false); setEditingFixedDraft(true); setPricingTab("mode"); }
  };
  const ensureDraft: EnsureDraft = async () => {
    if (!rules || !canEdit) return null;
    if (fixedEditor) {
      if (fixedDraft) return { rules, draft: fixedDraft };
      if (!fixedFee || !pricingVersion) return null;
      const result = await command.write(draftCommand(rules.game.id, "price", "create", { gameId: rules.game.id, mode: "PERCENT", sourcePriceVersionId: pricingVersion.id }));
      const draft = result?.fresh.priceVersions.find(v => v.id === result.receipt.id);
      return result && draft ? { rules: result.fresh, draft } : null;
    }
    if (!priceEditable) return null;
    const existing = activePriceDraft(rules);
    if (existing) return { rules, draft: existing };
    const source = sourcePriceVersion(rules);
    const result = await command.write(draftCommand(rules.game.id, "price", "create", { gameId: rules.game.id, mode: source?.mode ?? "SPREAD" }));
    const draft = result?.fresh.priceVersions.find(v => v.id === result.receipt.id);
    return result && draft ? { rules: result.fresh, draft } : null;
  };
  const editorProps = rules ? { rules, command, draftId, canEdit: fixedEditor ? canEdit : priceEditable, ensureDraft } : null;

  return (
    <div className="space-y-6">
      <RulesPageHeader section={section} rules={rules} showSchedules={showSchedules} deltaSection={deltaSection} error={error} success={success} command={command} gameId={gameId} onRecover={recoverRulesWrite} />
      {gamesLoaded && !gameId ? (
        <section className="section-panel"><EmptyHint>当前仅支持管理三角洲行动的规则与价目，请先在「游戏目录」中确认游戏。</EmptyHint></section>
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
          {deltaSection && !showSchedules && priceEditable && !fixedEditor ? <PublishBar rules={rules} command={command} dirty={priceDirty} canEdit={canEdit} isBoss={canSchedule} onSchedule={priceVersionId => setScheduleAsk({ priceVersionId })} onOpenSection={(name) => onOpenPath?.(`/supply/rules?section=${name}`)} /> : null}
          <FixedFeeDraftPanel rules={rules} section={section} deltaSection={deltaSection} showSchedules={showSchedules} fixedEditor={fixedEditor} fixedFee={fixedFee} canCreateFixed={canCreateFixed} pricingVersion={pricingVersion} currentPrice={currentPrice} fixedDraft={fixedDraft} command={command} priceDirty={priceDirty} anyDirty={anyDirty} canSchedule={canSchedule} guard={guard} ensureDraft={ensureDraft} setError={setError} setSuccess={setSuccess} setEditingFixedDraft={setEditingFixedDraft} setPricingTab={setPricingTab} setInitialRates={setInitialRates} setCreateFixedOpen={setCreateFixedOpen} setScheduleAsk={setScheduleAsk} />
          <div hidden={show("overview")}><RulesOverview key={`${snapshot.adminUserId}:${rules.game.id}`} rules={rules} command={command} isBoss={isBoss} canPreview={canPreview} canEdit={priceEditable} canActivate={canSchedule} onOpenSkin={() => onOpenPath?.("/supply/rules?section=skin")} onOpenSettlement={() => onOpenPath?.("/supply/rules?section=settlement")} /></div>
          <DepositSection hidden={show("deposit")} editorProps={editorProps} editorKey={editorKey} setCapDirty={setCapDirty} fixedEditor={fixedEditor} fixedDraft={fixedDraft} currentPrice={currentPrice} fundingVersion={fundingVersion} setFundingVersion={setFundingVersion} payoutTermsId={payoutTermsId} setPayoutTermsId={setPayoutTermsId} gameId={gameId} guard={guard} setError={setError} />
          <SettlementSection hidden={show("settlement")} rules={rules} fixedFee={fixedFee} onOpenPath={onOpenPath} tradePath={tradePath} />
          <PricingSection snapshot={snapshot} hidden={show("pricing")} pricingTab={pricingTab} setPricingTab={setPricingTab} showSchedules={showSchedules} adminUserId={snapshot.adminUserId} sessionId={snapshot.session?.id} gameId={gameId} canSchedule={canSchedule} editorKey={editorKey} editorProps={editorProps} fixedEditor={fixedEditor} priceEditable={priceEditable} setBaseDirty={setBaseDirty} setModeDirty={setModeDirty} setDailyDirty={setDailyDirty} loading={loading} guard={guard} termId={termId} termOptions={termOptions} setTermOptions={setTermOptions} dirty={dirty} setDirty={setDirty} applyTerm={applyTerm} setSwitchAsk={setSwitchAsk} setSealAsk={setSealAsk} setError={setError} setSuccess={setSuccess} setLoading={setLoading} />
          <div hidden={show("items")}><PriceItemsEditor key={`items:${editorKey}`} {...editorProps} onDirtyChange={setItemsDirty} /></div>
          <div hidden={show("skin")}><SkinDepositPolicyEditor key={`${editorKey}`} readOnly={!(priceEditable || fixedEditor && canEdit)} rules={rules} command={command} draftId={draftId} ensureDraft={ensureDraft} onDirtyChange={setDepositDirty} /></div>
          <AgreementSection hidden={show("agreement")} rules={rules} agreementId={agreementId} setAgreementId={setAgreementId} command={command} loading={loading} canSchedule={canSchedule} onOpenPath={onOpenPath} tradePath={tradePath} setScheduleAsk={setScheduleAsk} />
        </div>
      ) : null}
      <CreateFixedDraftDialog open={createFixedOpen} rules={rules} command={command} initialRates={initialRates} setInitialRates={setInitialRates} canCreateFixed={canCreateFixed} fixedDraft={fixedDraft} priceDirty={priceDirty} guard={guard} setError={setError} setEditingFixedDraft={setEditingFixedDraft} setPricingTab={setPricingTab} setCreateFixedOpen={setCreateFixedOpen} onRecover={recoverRulesWrite} />
      {scheduleAsk && rules && canSchedule ? <ConfirmDialog rules={rules} command={command} preferred={scheduleAsk}
        onClose={() => { setScheduleAsk(null); command.dismissResult(); }} /> : null}
      <RulesDialogs rules={rules} command={command} gameId={gameId} isBoss={isBoss} guard={guard} sealAsk={sealAsk} setSealAsk={setSealAsk} leaveAsk={leaveAsk} stayInSection={stayInSection} leaveSection={leaveSection} switchAsk={switchAsk} setSwitchAsk={setSwitchAsk} applyTerm={applyTerm} setDirty={setDirty} setError={setError} setSuccess={setSuccess} setLoading={setLoading} />
    </div>
  );
}
