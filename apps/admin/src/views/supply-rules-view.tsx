import { useCallback, useEffect, useState, type FormEvent } from "react";

import { AdminApiError, adminRequest, friendlyError, hasPermission, type CatalogItem, type PriceLineRecord, type PriceVersionRecord, type RulesResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";
const textareaClass = "w-full min-h-32 px-3 py-2 rounded border border-border bg-surface-raised text-xs font-mono";

type PriceLineDraft = { itemId: string; pricingKind: "FIXED_UNIT" | "HAFF_RATIO"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string };
type TermOptionDraft = { code: string; name: string; dailyConsumption: string };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-xs block">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
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
  const [lines, setLines] = useState<Record<string, PriceLineDraft>>({});
  const [termOptions, setTermOptions] = useState<TermOptionDraft[]>([]);
  const [agreementTitle, setAgreementTitle] = useState("");
  const [agreementBody, setAgreementBody] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewError, setPreviewError] = useState<string>();
  const [previewInput, setPreviewInput] = useState({ safeBoxCode: "", vitLevel: "6", bearLevel: "6", pricingOptionCode: "standard", quantity: "60000000" });
  const [activatePrice, setActivatePrice] = useState("");
  const [activateTerm, setActivateTerm] = useState("");
  const [activateAgreement, setActivateAgreement] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const loadGames = useCallback(async () => {
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    setGames(result.games);
    setGameId((current) => (current && result.games.some((game) => game.id === current) ? current : result.games[0]?.id ?? ""));
  }, []);

  const applyPrice = useCallback((record: PriceVersionRecord, allLines: PriceLineRecord[], items: CatalogItem[]) => {
    setPriceId(record.id);
    setPriceMode(record.mode);
    setCommissionRate(record.commissionRate ?? "");
    setHaffRuleText(record.haffRule ? JSON.stringify(record.haffRule, null, 2) : "");
    const next: Record<string, PriceLineDraft> = {};
    const linesForVersion = allLines.filter((line) => line.priceVersionId === record.id);
    if (linesForVersion.length === 0) {
      for (const item of items) {
        next[item.id] = { itemId: item.id, pricingKind: item.unit === "HAFF_BASE" ? "HAFF_RATIO" : "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "", ownerUnitAmount: "" };
      }
    } else {
      for (const line of linesForVersion) {
        next[line.itemId] = {
          itemId: line.itemId,
          pricingKind: line.pricingKind,
          unitQuantity: line.unitQuantity ?? "1",
          buyerUnitAmount: line.buyerUnitAmount ?? "",
          ownerUnitAmount: line.ownerUnitAmount ?? "",
        };
      }
    }
    setLines(next);
  }, []);

  const applyTerm = useCallback((recordId: string, options: RulesResponse["termOptions"]) => {
    setTermId(recordId);
    setTermOptions(options.filter((option) => option.versionId === recordId).map((option) => ({ code: option.code, name: option.name, dailyConsumption: option.dailyConsumption })));
  }, []);

  const loadRules = useCallback(async (targetGameId: string) => {
    if (!targetGameId) {
      setRules(null);
      return;
    }
    const result = await adminRequest<RulesResponse>(`/supply/games/${targetGameId}/rules`);
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
    setActivatePrice(latestSealed(result.priceVersions));
    setActivateTerm(latestSealed(result.termVersions));
    setActivateAgreement(latestSealed(result.agreementVersions));
    setDirty(false);
  }, [applyPrice, applyTerm]);

  useEffect(() => {
    setError(undefined);
    loadGames().catch((failure) => setError(friendlyError(failure)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  useEffect(() => {
    if (!gameId) {
      setRules(null);
      return;
    }
    setLoading(true);
    loadRules(gameId)
      .catch((failure) => setError(friendlyError(failure)))
      .finally(() => setLoading(false));
  }, [gameId, loadRules, refreshNonce]);

  const reload = async (): Promise<RulesResponse | undefined> => {
    if (!gameId) return undefined;
    const result = await adminRequest<RulesResponse>(`/supply/games/${gameId}/rules`);
    setRules(result);
    setDirty(false);
    return result;
  };

  const selectedPrice = rules?.priceVersions.find((version) => version.id === priceId);
  const selectedTerm = rules?.termVersions.find((version) => version.id === termId);
  const selectedAgreement = rules?.agreementVersions.find((version) => version.id === agreementId);
  const items = rules?.items ?? [];
  const haffItem = items.find((item) => item.unit === "HAFF_BASE");

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
      const created = await adminRequest<{ id: string }>("/supply/price-drafts", { gameId, mode: priceMode });
      const fresh = await reload();
      selectPrice(created.id, fresh);
      setSuccess("价格草稿已创建；草稿可继续修改，封存后才可生效。");
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  const savePrice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPrice) return;
    let haffRule: unknown = undefined;
    if (haffRuleText.trim()) {
      try {
        haffRule = JSON.parse(haffRuleText);
      } catch {
        setError("Haff 规则不是合法 JSON，未保存。");
        return;
      }
    }
    const builtLines = Object.values(lines)
      .filter((line) => line.buyerUnitAmount !== "" || line.pricingKind === "HAFF_RATIO")
      .map((line) =>
        line.pricingKind === "HAFF_RATIO"
          ? { itemId: line.itemId, pricingKind: "HAFF_RATIO" }
          : {
              itemId: line.itemId,
              pricingKind: "FIXED_UNIT",
              unitQuantity: line.unitQuantity,
              buyerUnitAmount: line.buyerUnitAmount,
              ...(priceMode === "SPREAD" && line.ownerUnitAmount !== "" ? { ownerUnitAmount: line.ownerUnitAmount } : {}),
            },
      );
    if (builtLines.length === 0) {
      setError("至少配置一条计价行；固定物资需要买方单价。");
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest(`/supply/price-drafts/${selectedPrice.id}`, {
        expectedRevision: selectedPrice.revision,
        mode: priceMode,
        ...(priceMode === "PERCENT" ? { commissionRate } : {}),
        ...(haffRule === undefined ? {} : { haffRule }),
        roundingPolicy: selectedPrice.roundingPolicy,
        lines: builtLines,
      }, "PUT");
      await reload();
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
      await adminRequest(`/supply/term-drafts/${selectedTerm.id}`, {
        expectedRevision: selectedTerm.revision,
        options: termOptions.map((option) => ({ code: option.code, name: option.name, dailyConsumption: option.dailyConsumption, durationRounding: "CEIL_DAY" })),
      }, "PUT");
      await reload();
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
      await adminRequest(`/supply/agreement-drafts/${selectedAgreement.id}`, { expectedRevision: selectedAgreement.revision, title: agreementTitle, body: agreementBody }, "PUT");
      await reload();
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
      const created = await adminRequest<{ id: string }>("/supply/term-drafts", { gameId });
      await reload();
      applyTerm(created.id, []);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  const createAgreement = async () => {
    try {
      const created = await adminRequest<{ id: string }>("/supply/agreement-drafts", { gameId, title: "出租协议草稿", body: "在此填写协议正文。" });
      await reload();
      const record = (await adminRequest<RulesResponse>(`/supply/games/${gameId}/rules`)).agreementVersions.find((version) => version.id === created.id);
      setAgreementId(created.id);
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
      await adminRequest(`/supply/${kind}-drafts/${id}/seal`, { expectedRevision: revision });
      await reload();
      setSuccess("版本已封存；封存后内容不可修改。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const activate = async () => {
    setError(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<{ releaseId: string; generation: string; affectedCount: number }>("/supply/releases", {
        gameId,
        priceVersionId: activatePrice,
        termVersionId: activateTerm,
        agreementVersionId: activateAgreement,
        expectedGeneration: rules?.release?.generation ?? "0",
      });
      await reload();
      setSuccess(`规则已原子生效：第 ${result.generation} 代；受影响账号 ${result.affectedCount} 个。切换后旧条件立即被后续调用方拒绝。`);
    } catch (failure) {
      setError(failure instanceof AdminApiError && failure.status === 409 ? "规则已被更新，请刷新当前页，核对版本后重新确认生效。" : friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const runPreview = async () => {
    if (!rules || !priceId || !termId || !haffItem) {
      setPreviewError("需要价格草稿、租期草稿与一个 HAFF_BASE 计费物品才能演算。");
      return;
    }
    setPreviewError(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<Record<string, unknown>>("/supply/quote-preview", {
        priceVersionId: priceId,
        termVersionId: termId,
        accountId: "preview_account",
        conditions: {
          safeBoxCode: previewInput.safeBoxCode,
          vitLevel: Number(previewInput.vitLevel),
          bearLevel: Number(previewInput.bearLevel),
          termOptionCode: termOptions[0]?.code ?? "",
          pricingOptionCode: previewInput.pricingOptionCode,
        },
        inventory: [{ itemId: haffItem.id, quantity: previewInput.quantity }],
      });
      setPreview(result);
    } catch (failure) {
      setPreview(null);
      setPreviewError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  if (!canEdit) {
    return <section className="section-panel"><StatusMessage error="当前账号没有规则草稿编辑权限；生效仅限 Boss。" /></section>;
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>规则与价目</h3>
            <p>运营编辑草稿、封存版本；Boss 原子生效。当前 release 切换后，引用旧条件的后续调用立即被拒绝，不依赖批量改状态。未配置参数不生成可上线报价。</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <Field label="游戏">
            <select value={gameId} onChange={(event) => setGameId(event.target.value)} className={selectClass}>
              {games.length === 0 ? <option value="">暂无可维护游戏</option> : null}
              {games.map((game) => <option key={game.id} value={game.id}>{game.name}（{game.code}）</option>)}
            </select>
          </Field>
          <Field label="当前 release">
            <div className="h-9 flex items-center text-xs text-muted-foreground">
              {rules?.release ? `第 ${rules.release.generation} 代 · ${rules.release.id}` : "尚未生效任何版本"}
            </div>
          </Field>
        </div>
        <StatusMessage error={error} success={success} className="mt-3" />
      </section>

      {rules ? (
        <>
          <section className="section-panel">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">价格版本</h3>
              <div className="flex items-center gap-2">
                <select value={priceMode} onChange={(event) => setPriceMode(event.target.value as "SPREAD" | "PERCENT")} className={selectClass}>
                  <option value="SPREAD">SPREAD 差价</option>
                  <option value="PERCENT">PERCENT 百分比</option>
                </select>
                <Button type="button" size="sm" onClick={() => void createPrice()}>新建价格草稿</Button>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <select value={priceId} onChange={(event) => selectPrice(event.target.value)} className={selectClass}>
                {rules.priceVersions.map((version) => <option key={version.id} value={version.id}>{version.mode} · {version.status} · rev {version.revision}</option>)}
              </select>
              {selectedPrice?.status === "DRAFT" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void seal("price", selectedPrice.id, selectedPrice.revision)}>封存</Button> : null}
            </div>
            {selectedPrice ? (
              <form onSubmit={savePrice} className="mt-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Field label="封存状态"><div className="h-9 flex items-center text-xs">{selectedPrice.status === "SEALED" ? "已封存（只读）" : "草稿"}</div></Field>
                  {priceMode === "PERCENT" ? (
                    <Field label="平台抽成 commission_rate（0–1）">
                      <input value={commissionRate} disabled={selectedPrice.status === "SEALED"} onChange={(event) => { setCommissionRate(event.target.value); setDirty(true); }} className={inputClass} placeholder="0.2" />
                    </Field>
                  ) : null}
                </div>
                <Field label="haff-ratio-v1 规则 JSON（SPREAD 必须含 spreadDelta；所有比例单位为 M/100元）">
                  <textarea value={haffRuleText} disabled={selectedPrice.status === "SEALED"} onChange={(event) => { setHaffRuleText(event.target.value); setDirty(true); }} className={textareaClass} />
                </Field>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>物品</th><th>计价方式</th><th>unit_quantity</th><th>买方单价</th><th>号主单价</th></tr></thead>
                    <tbody>
                      {items.map((item) => {
                        const line = lines[item.id];
                        if (!line) return null;
                        return (
                          <tr key={item.id}>
                            <td>{item.name}（{item.code}）</td>
                            <td>{line.pricingKind === "HAFF_RATIO" ? "HAFF_RATIO（按规则推算）" : "FIXED_UNIT"}</td>
                            <td>{line.pricingKind === "HAFF_RATIO" ? "-" : <input value={line.unitQuantity} disabled={selectedPrice.status === "SEALED"} onChange={(event) => { setLines({ ...lines, [item.id]: { ...line, unitQuantity: event.target.value } }); setDirty(true); }} className={inputClass} />}</td>
                            <td>{line.pricingKind === "HAFF_RATIO" ? "-" : <input value={line.buyerUnitAmount} disabled={selectedPrice.status === "SEALED"} onChange={(event) => { setLines({ ...lines, [item.id]: { ...line, buyerUnitAmount: event.target.value } }); setDirty(true); }} className={inputClass} placeholder="2.5" />}</td>
                            <td>{line.pricingKind === "HAFF_RATIO" || priceMode === "PERCENT" ? "-" : <input value={line.ownerUnitAmount} disabled={selectedPrice.status === "SEALED"} onChange={(event) => { setLines({ ...lines, [item.id]: { ...line, ownerUnitAmount: event.target.value } }); setDirty(true); }} className={inputClass} placeholder="2" />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {selectedPrice.status === "DRAFT" ? <Button type="submit" size="sm" loading={loading}>保存价格草稿</Button> : null}
              </form>
            ) : null}
          </section>

          <section className="section-panel">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">租期版本</h3>
              <Button type="button" size="sm" onClick={() => void createTerm()}>新建租期草稿</Button>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <select value={termId} onChange={(event) => applyTerm(event.target.value, rules.termOptions)} className={selectClass}>
                {rules.termVersions.map((version) => <option key={version.id} value={version.id}>{version.status} · rev {version.revision}</option>)}
              </select>
              {selectedTerm?.status === "DRAFT" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void seal("term", selectedTerm.id, selectedTerm.revision)}>封存</Button> : null}
            </div>
            <form onSubmit={saveTerm} className="mt-4 space-y-3">
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>选项 code</th><th>名称</th><th>日消耗（基础哈夫币）</th><th /></tr></thead>
                  <tbody>
                    {termOptions.map((option, index) => (
                      <tr key={index}>
                        <td><input value={option.code} disabled={selectedTerm?.status === "SEALED"} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, code: event.target.value } : item)); setDirty(true); }} className={inputClass} /></td>
                        <td><input value={option.name} disabled={selectedTerm?.status === "SEALED"} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item)); setDirty(true); }} className={inputClass} /></td>
                        <td><input value={option.dailyConsumption} disabled={selectedTerm?.status === "SEALED"} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, dailyConsumption: event.target.value } : item)); setDirty(true); }} className={inputClass} /></td>
                        <td>{selectedTerm?.status === "DRAFT" ? <Button type="button" size="sm" variant="ghost" onClick={() => { setTermOptions(termOptions.filter((_, itemIndex) => itemIndex !== index)); setDirty(true); }}>删除</Button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selectedTerm?.status === "DRAFT" ? (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => { setTermOptions([...termOptions, { code: `daily-${termOptions.length + 1}`, name: "新档位", dailyConsumption: "10000000" }]); setDirty(true); }}>添加档位</Button>
                  <Button type="submit" size="sm" loading={loading}>保存租期草稿</Button>
                </div>
              ) : null}
            </form>
          </section>

          <section className="section-panel">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">协议版本</h3>
              <Button type="button" size="sm" onClick={() => void createAgreement()}>新建协议草稿</Button>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <select value={agreementId} onChange={(event) => { const record = rules.agreementVersions.find((version) => version.id === event.target.value); setAgreementId(event.target.value); setAgreementTitle(record?.title ?? ""); setAgreementBody(record?.body ?? ""); setDirty(false); }} className={selectClass}>
                {rules.agreementVersions.map((version) => <option key={version.id} value={version.id}>{version.title} · {version.status} · rev {version.revision}</option>)}
              </select>
              {selectedAgreement?.status === "DRAFT" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void seal("agreement", selectedAgreement.id, selectedAgreement.revision)}>封存</Button> : null}
            </div>
            <form onSubmit={saveAgreement} className="mt-4 space-y-3">
              <Field label="标题"><input value={agreementTitle} disabled={selectedAgreement?.status === "SEALED"} onChange={(event) => { setAgreementTitle(event.target.value); setDirty(true); }} className={inputClass} /></Field>
              <Field label="正文（纯文本；服务端保存 digest）"><textarea value={agreementBody} disabled={selectedAgreement?.status === "SEALED"} onChange={(event) => { setAgreementBody(event.target.value); setDirty(true); }} className={textareaClass} /></Field>
              {selectedAgreement?.status === "DRAFT" ? <Button type="submit" size="sm" loading={loading}>保存协议草稿</Button> : null}
            </form>
          </section>

          <section className="section-panel">
            <h3 className="text-sm font-semibold">Boss 生效</h3>
            <p className="text-xs text-muted-foreground mt-1">本次确认基于第 {rules.release?.generation ?? "0"} 代规则；期间有其他生效操作时，需刷新后重新确认。</p>
            <p className="text-[11px] text-muted-foreground mt-1">只有已封存版本可被引用；同一游戏一次生效一个 release，切换在同事务完成并立即影响后续调用。</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
              <Field label="价格版本">
                <select value={activatePrice} onChange={(event) => setActivatePrice(event.target.value)} className={selectClass}>
                  <option value="">请选择</option>
                  {rules.priceVersions.filter((version) => version.status === "SEALED").map((version) => <option key={version.id} value={version.id}>{version.mode} · rev {version.revision}</option>)}
                </select>
              </Field>
              <Field label="租期版本">
                <select value={activateTerm} onChange={(event) => setActivateTerm(event.target.value)} className={selectClass}>
                  <option value="">请选择</option>
                  {rules.termVersions.filter((version) => version.status === "SEALED").map((version) => <option key={version.id} value={version.id}>rev {version.revision}</option>)}
                </select>
              </Field>
              <Field label="协议版本">
                <select value={activateAgreement} onChange={(event) => setActivateAgreement(event.target.value)} className={selectClass}>
                  <option value="">请选择</option>
                  {rules.agreementVersions.filter((version) => version.status === "SEALED").map((version) => <option key={version.id} value={version.id}>{version.title}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <Button type="button" size="sm" loading={loading} disabled={!isBoss || !activatePrice || !activateTerm || !activateAgreement} onClick={() => void activate()}>原子生效</Button>
              {!isBoss ? <span className="text-[11px] text-muted-foreground">当前账号不是 Boss，只能编辑草稿。</span> : null}
            </div>
          </section>

          {canPreview ? (
            <section className="section-panel">
              <h3 className="text-sm font-semibold">报价演算（内部投影）</h3>
              <p className="text-[11px] text-muted-foreground mt-1">使用当前选中的价格/租期草稿与合成条件演算；押金策略未配置时以 null 返回，不会填 0.00。</p>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">
                <Field label="安全箱 code"><input value={previewInput.safeBoxCode} onChange={(event) => setPreviewInput({ ...previewInput, safeBoxCode: event.target.value })} className={inputClass} placeholder="box-a" /></Field>
                <Field label="体力等级"><input value={previewInput.vitLevel} onChange={(event) => setPreviewInput({ ...previewInput, vitLevel: event.target.value })} className={inputClass} /></Field>
                <Field label="负重等级"><input value={previewInput.bearLevel} onChange={(event) => setPreviewInput({ ...previewInput, bearLevel: event.target.value })} className={inputClass} /></Field>
                <Field label="计价选项 code"><input value={previewInput.pricingOptionCode} onChange={(event) => setPreviewInput({ ...previewInput, pricingOptionCode: event.target.value })} className={inputClass} /></Field>
                <Field label="哈夫币数量"><input value={previewInput.quantity} onChange={(event) => setPreviewInput({ ...previewInput, quantity: event.target.value })} className={inputClass} /></Field>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button type="button" size="sm" loading={loading} onClick={() => void runPreview()}>演算</Button>
                <span className="text-[11px] text-muted-foreground">租期选项：{termOptions[0]?.code ?? "未配置"}；皮肤不参与计价。</span>
              </div>
              <StatusMessage error={previewError} className="mt-3" />
              {preview ? <pre className="mt-3 max-h-96 overflow-auto text-[11px] bg-surface-raised border border-border rounded-md p-3">{JSON.stringify(preview, null, 2)}</pre> : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
