"use client";

import Link from "next/link";
import Image from "next/image";
import {
  Coins,
  LockKeyhole,
  CalendarClock,
  ShieldCheck,
  Check,
  AlertCircle,
  FileText,
} from "lucide-react";
import { Input, FormSelect, FormRadioGroup, Textarea } from "../ui/form-controls";
import { FieldHelp, SectionCard, FieldError } from "./publish-dialogs";
import { ManagedNoticeSections } from "@/components/content/managed-notice";
import {
  baseFromHaffM,
  baseQuantityText,
  customTermOptions,
  haffMText,
  ratioDisplayText,
  rentalModeLabel,
  usesRentalModes,
  yuanFromCents,
} from "../../lib/publish-derive";
import { moneyText, formatHaffChineseUnit } from "./publish-form-helpers";
import type {
  DraftInput,
  PublishingOptions,
  RentalMode,
  DepositRecommendation,
} from "../../lib/supply-types";
import type {
  PublishGroupId,
  UiProblem,
  RecommendationBinding,
  OptionsAvailability,
} from "./publish-form-types";

export interface PublishTermsSectionProps {
  hasError: boolean;
  fieldError: (path: string) => string | undefined;

  haffBaseIncomplete: boolean;
  readOnly: boolean;
  haffBaseMissing: Array<{ label: string; target?: string }>;
  scrollToTarget: (group: PublishGroupId, target?: string) => void;
  haffInventoryRow: { itemId: string } | null | undefined;
  haffInput: string;
  haffControlsDisabled: boolean;
  changeHaffM: (itemId: string, value: string) => void;
  haffErrorMessage: string | undefined;
  termAdjustmentText: string | null;
  draft: DraftInput;
  options: PublishingOptions | null;
  rentalMode: RentalMode;
  setDraft: (next: DraftInput | ((previous: DraftInput) => DraftInput)) => void;
  invalidateConfirmations: () => void;

  showPricingSelect: boolean;
  disabledPricing: boolean;
  fastLocked: boolean;
  fastReady: boolean;
  optionsAvailability: OptionsAvailability;
  rentalModeEntries: RentalMode[];
  ratioRanges: any;
  changeRentalMode: (mode: RentalMode) => void;
  ratioInput: string;
  ratioInlineProblem: { message: string; target?: string } | null;
  changeRatio: (value: string) => void;
  selectedRatioRange: string | null;
  modeRange: string | null;

  displayEstimateDuration: string | null;
  durationResult: string;
  ratioKnown: boolean;
  ratioResult: string;
  rentalModes: any;
  modeHref: (fast: boolean) => string;

  payoutSelected: boolean | null;
  formDisabled: boolean;
  changeFullPayout: (payout: boolean) => void;
  recommendation: DepositRecommendation | null;
  recommendationFresh: boolean;
  recommendationAdopted: boolean;
  recommendationCatalogFresh: boolean;
  recommendationBinding: RecommendationBinding | null;
  recommendationAmountYuan: string | null;
  recommendationBusy: boolean;
  adoptRecommendation: () => Promise<void>;
  recommendDeposit: () => Promise<void>;
  depositInput: string;
  changeDeposit: (value: string) => void;
  depositProblem: () => { message: string; target?: string } | null;

  infoSourceOptions?: {
    enabled?: boolean;
    optionsState?: string;
    options?: Array<{ value: string; name: string }>;
  };
  infoSourceValue: string;
  infoSourceLegacy: boolean;
  changeAttribute: (key: string, value: string | number | boolean | null) => void;
}

export function PublishTermsSection({
  hasError,
  fieldError,

  haffBaseIncomplete,
  readOnly,
  haffBaseMissing,
  scrollToTarget,
  haffInventoryRow,
  haffInput,
  haffControlsDisabled,
  changeHaffM,
  haffErrorMessage,
  termAdjustmentText,
  draft,
  options,
  rentalMode,
  setDraft,
  invalidateConfirmations,

  showPricingSelect,
  disabledPricing,
  fastLocked,
  fastReady,
  optionsAvailability,
  rentalModeEntries,
  ratioRanges,
  changeRentalMode,
  ratioInput,
  ratioInlineProblem,
  changeRatio,
  selectedRatioRange,
  modeRange,

  displayEstimateDuration,
  durationResult,
  ratioKnown,
  ratioResult,
  rentalModes,
  modeHref,

  payoutSelected,
  formDisabled,
  changeFullPayout,
  recommendation,
  recommendationFresh,
  recommendationAdopted,
  recommendationCatalogFresh,
  recommendationBinding,
  recommendationAmountYuan,
  recommendationBusy,
  adoptRecommendation,
  recommendDeposit,
  depositInput,
  changeDeposit,
  depositProblem,

  infoSourceOptions,
  infoSourceValue,
  infoSourceLegacy,
  changeAttribute,
}: PublishTermsSectionProps) {
  return (
    <SectionCard id="terms" title="出租条件与条款" hasError={hasError}>
      <div className="publish-terms-flow">
        <section className={`publish-term-section publish-term-haff-section${haffBaseIncomplete && !readOnly ? " is-prereq-locked" : ""}`}>
          <div className="publish-term-section-heading"><Coins size={20} aria-hidden="true" /><h3>出租设置</h3></div>
          {haffBaseIncomplete && !readOnly ? (
            <div className="publish-haff-prereq-banner" role="status">
              <div className="publish-haff-prereq-copy">
                <strong>请先填写账号属性，再设置哈夫币与出租条件</strong>
                <p>哈夫币基准比例与允许范围依赖安全箱、体力与负重等级，待补全：{haffBaseMissing.map((item) => item.label).join("、")}。</p>
              </div>
              <button
                type="button"
                className="button secondary publish-haff-prereq-jump"
                onClick={() => scrollToTarget("account", haffBaseMissing[0]?.target)}
              >
                去补全
              </button>
            </div>
          ) : null}
          <div className="publish-term-row publish-term-haff-row">
            <div className="publish-term-label"><label htmlFor="publish-haff-balance">哈夫币余额</label><span className="publish-required-mark">必填</span><FieldHelp label="哈夫币余额">填写仓库右上角的现金余额；1 M = 100万哈夫币，仅支持整数。</FieldHelp></div>
            <div className="publish-term-control">
              {haffInventoryRow ? (
                <div className="publish-haff-balance-control">
                  <div className="publish-haff-input-wrap">
                    <Input
                      id="publish-haff-balance"
                      aria-label="哈夫币数量（M）"
                      aria-required="true"
                      data-first-field
                      inputMode="numeric"
                      autoComplete="off"
                      value={haffInput}
                      disabled={haffControlsDisabled}
                      onChange={(event) => changeHaffM(haffInventoryRow.itemId, event.target.value)}
                      placeholder="0"
                      aria-invalid={Boolean(haffErrorMessage)}
                      aria-describedby={haffErrorMessage ? "publish-haff-balance-hint publish-haff-balance-error" : "publish-haff-balance-hint"}
                    />
                    <span className="publish-haff-unit">M</span>
                  </div>
                  <div id="publish-haff-balance-hint" className="publish-haff-hint-row">
                    <span className="publish-haff-hint-base">1 M = 100万哈夫币 · 仅支持整数</span>
                    {/^\d+$/.test(haffInput.trim()) && baseFromHaffM(haffInput) ? (
                      <span className="publish-haff-conversion">
                        = {baseQuantityText(baseFromHaffM(haffInput) ?? "")} 哈夫币
                        {formatHaffChineseUnit(haffInput) ? <em className="publish-haff-chinese">（约 {formatHaffChineseUnit(haffInput)}）</em> : null}
                      </span>
                    ) : null}
                  </div>
                  <div className="publish-quick-chips" role="group" aria-label="常用哈夫币档位">
                    {(["50", "100", "200", "500"] as const).map((preset) => (
                      <button key={preset} type="button" className="publish-quick-chip" data-active={haffInput.trim() === preset ? "true" : "false"} disabled={haffControlsDisabled} onClick={() => changeHaffM(haffInventoryRow.itemId, preset)}>{preset}M</button>
                    ))}
                  </div>
                  <FieldError id="publish-haff-balance-error" text={haffErrorMessage} />
                </div>
              ) : (
                <p className="publish-term-unavailable">当前发布目录尚未提供哈夫币计费项，暂不能填写。</p>
              )}
            </div>
          </div>
          <div className="publish-term-row publish-term-options-row">
            <span className="publish-term-label">每日消耗<span className="publish-required-mark">必填</span><FieldHelp label="每日消耗">选择租客每日消耗哈夫币档位{termAdjustmentText ? `（当前档位比例调整：${termAdjustmentText}）` : ""}；自定义比例固定为 10M/天。</FieldHelp></span>
            <div className="publish-term-control">
              <FormRadioGroup
                name="term_option"
                label="每日消耗"
                value={draft.termOptionCode}
                options={options?.termOptions.map((option) => {
                  const is10m = option.dailyConsumption === "10000000";
                  const allowed = options?.rentalTermOptions?.[rentalMode]?.termOptionCodes;
                  return {
                    value: option.code,
                    label: `${haffMText(option.dailyConsumption)} / 天`,
                    disabled: (rentalMode === "custom" && !is10m) || Boolean(allowed && !allowed.includes(option.code)),
                  };
                }) ?? []}
                disabled={haffControlsDisabled || !options}
                onChange={(value) => {
                  setDraft({ ...draft, termOptionCode: value });
                  invalidateConfirmations();
                }}
              />
              {rentalMode === "custom" ? (
                <small className="publish-term-subnote">自定义比例仅支持 10M/天 方案</small>
              ) : null}
            </div>
          </div>
          <div className="publish-term-row publish-term-options-row">
            <span className="publish-term-label">出租方案<FieldHelp label="出租方案">普通比例按安全箱、体力、负重与日耗自动匹配；自定义比例（仅限10M/天）与极速比例可在允许区间内设置。</FieldHelp></span>
            <div className="publish-term-control publish-ratio-control">
            {showPricingSelect ? <div><FormSelect label="计价方案" value={draft.pricingOptionCode} disabled={disabledPricing || haffBaseIncomplete} placeholder="选择计价方案" popupClassName="publish-select-popup" options={[{ value: "", label: "选择计价方案" }, ...(options?.pricingOptionCodes.map((code, index) => ({ value: code, label: `计价方案 ${index + 1}` })) ?? [])]} onChange={(val) => setDraft({ ...draft, pricingOptionCode: val })} /><FieldError text={fieldError("pricingOptionCode")} /></div> : <>
              {fastLocked ? <div className={`supply-ratio-locked${fastReady ? "" : " is-disabled"}`} aria-label="极速比例（已锁定）"><LockKeyhole size={14} aria-hidden="true" />{optionsAvailability !== "ready" ? "正在读取极速比例规则" : fastReady ? "当前使用极速出租" : "极速比例当前未启用"}</div> : <FormRadioGroup name="rental_mode" label="出租比例" value={rentalMode} options={rentalModeEntries.map((entry) => {
                const range = ratioDisplayText(ratioRanges?.[entry]);
                return { value: entry, label: rentalModeLabel(entry), description: range ? `${range}${entry === "custom" ? "（10M/天）" : ""}` : undefined, disabled: entry === "custom" && !customTermOptions(options).length };
              })} disabled={haffControlsDisabled} onChange={changeRentalMode} />}
              {rentalMode !== "ordinary" ? <label className="publish-ratio-input"><span>兑换比例</span><div className="publish-ratio-equation publish-ratio-equation--input"><span>1 元 =</span><Input data-first-field inputMode="decimal" value={ratioInput} disabled={haffControlsDisabled} aria-invalid={Boolean(ratioInlineProblem)} onChange={(event) => changeRatio(event.target.value)} placeholder="填写比例" aria-label="兑换比例" /><span>万哈夫币</span></div><small>{haffBaseIncomplete ? `请先补全${haffBaseMissing.map((item) => item.label).join("、")}后获取兑换比例范围` : selectedRatioRange ? `允许范围：${selectedRatioRange}` : modeRange ? `允许范围（万哈夫币/元）：${modeRange}` : "允许范围需读取当前规则后确认"}</small>{ratioInlineProblem ? <FieldError text={ratioInlineProblem.message} /> : null}</label> : null}
            </>}
          </div></div>
          <div className="publish-term-row publish-term-result-row">
            <span className="publish-term-label">测算结果<span className="publish-auto-tag">自动计算</span></span>
            <div className="publish-term-control publish-calc-results">
              <div className="publish-calc-item">
                <span className="publish-calc-label"><CalendarClock size={14} aria-hidden="true" />预计租期<FieldHelp label="预计租期">按哈夫币余额 ÷ 每日消耗计算，不足一天按一天计；租期与收入按实时规则自动测算。</FieldHelp></span>
                <output className="publish-calc-value" data-state={displayEstimateDuration ? "ready" : "pending"} aria-label="预计租期">{durationResult}</output>
              </div>
              <div className="publish-calc-item">
                <span className="publish-calc-label">出租比例<FieldHelp label="出租比例">每收入 1 元可兑换多少万哈夫币（1 万＝10,000 哈夫币）；普通比例由平台按账号配置与日耗核定，自定义比例需在允许范围内。</FieldHelp></span>
                <output className="publish-calc-value" data-state={ratioKnown ? "ready" : "pending"} aria-label="测算出租比例">{ratioResult}</output>
              </div>
            </div>
          </div>
          {fastLocked && options && !usesRentalModes(options) ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>当前规则暂不支持极速出租。</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
          {fastLocked && optionsAvailability === "ready" && usesRentalModes(options) && rentalModes?.fast?.enabled !== true ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>{rentalModes?.fast ? "当前规则未启用极速比例，不能以极速入口上架。" : "当前规则未提供极速比例范围，不能以极速入口上架。"}</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
          <details className="publish-rule-disclosure"><summary><span>日耗、租期与比例怎么选？</span></summary><div className="publish-disclosure-panel"><ManagedNoticeSections contentKey="placement:PUBLISH_TERM" compact /><p>预计租期按哈夫币余额除以每日消耗推算，不足一天按一天计。租期结束后按约定办理结算，不是手动承诺的成交时间。</p><p>普通比例由平台按账号配置和日耗核定；自定义比例仅支持10M/天。每收入1元对应的哈夫币越多，租金就越低，租客也更容易比较。</p><p>具体可选档位与比例以当前页面为准；修改资料后预估会更新，最终以上架时确认的报价为准。</p></div></details>
        </section>

        <section className="publish-term-section">
          <div className="publish-term-section-heading"><ShieldCheck size={20} aria-hidden="true" /><h3>赔付与押金</h3></div>
          <div className="publish-term-row publish-term-options-row"><span className="publish-term-label">赔付方案</span><div className="publish-term-control publish-payout-control"><FormRadioGroup<boolean | null> name="full_payout" label="赔付方案" className="publish-payout-group" value={payoutSelected} disabled={formDisabled} onChange={(val) => { if (typeof val === "boolean") changeFullPayout(val); }} options={[{ value: false, label: "普通赔付" }, { value: true, label: "全额包赔", badge: "推荐" }]} />
            <div className="publish-payout-feature" data-selected={payoutSelected === true ? "true" : "false"}>
              <div className="publish-payout-feature-heading">{payoutSelected === true ? <Image className="publish-payout-art" src="/art/quote/full-payout-shield.png" width={88} height={88} sizes="88px" alt="" /> : <ShieldCheck size={28} aria-hidden="true" />}<div><strong>{payoutSelected === true ? "全额包赔" : "可选全额包赔方案说明"}</strong><span>{payoutSelected === true ? "已选择此方案 · 平台推荐" : payoutSelected === false ? "当前选择普通赔付" : "可选保障 · 尚未选择赔付方案"}</span></div>{payoutSelected === true ? <Check size={18} aria-hidden="true" /> : null}</div>
              <dl className="publish-payout-facts"><div><dt>包赔费率</dt><dd>8%</dd></div><div><dt>全额包赔基础押金门槛</dt><dd>{recommendation?.available && recommendationFresh ? `${yuanFromCents(recommendation.fullPayoutMinCents)} 元起` : "300 元起"}</dd></div></dl>
              <p>正常结束时，按已消耗的哈夫币与物资收入收取8%服务费，并从收入中扣除。具体保障范围与提前结束的处理，请查看赔付规则。</p>
            </div>
          <details id="publish-payout-rules" className="publish-policy-disclosure"><summary><span>查看赔付规则</span></summary>
            <div className="publish-disclosure-panel">
              <div className="publish-payout-scenes"><div className="publish-payout-scene-card"><strong>正常结束或提前结束</strong><p>按实际消耗对应的号主扣费前收入计算，由号主承担。上架时的全量收入仅为预估。</p></div></div>
              <p className="publish-payout-subnote">未选择全额包赔或未正常交付开租，不自动收取。押金、保证金、价差、提前补足及赔款均不计入收费基数。</p>
              <p className="publish-payout-subnote">服务费在结算生效时计算一次。保障针对本次租赁导致的约定损失，范围与实际赔付按有效条款处理；不承诺无条件赔付。</p>
              <p className="publish-payout-subnote">以上是平台政策说明；提交上架前需在右侧确认适用协议。</p>
            </div>
          </details>
          </div></div>

          <div className="publish-term-row"><label className="publish-term-label" htmlFor="publish-deposit">基础租客押金<FieldHelp label="基础租客押金">结合账号价值设置租客押金（不计入你的出租收入）；也可点击“查看推荐押金”后一键采用。</FieldHelp></label><div className="publish-term-control"><div className="supply-deposit-input-group"><div className="supply-deposit-input-wrap"><Input id="publish-deposit" data-first-field inputMode="decimal" value={depositInput} disabled={formDisabled} onChange={(event) => changeDeposit(event.target.value)} placeholder="填写押金金额" aria-invalid={Boolean(depositProblem())} /><span className="supply-deposit-unit">元</span></div><button type="button" className="button secondary supply-recommend-btn" disabled={formDisabled || recommendationBusy} onClick={() => void recommendDeposit()}>{recommendationBusy ? "计算中…" : "查看推荐押金"}</button></div><div className="publish-quick-chips" role="group" aria-label="常用押金档位">{(["200", "300", "500", "800"] as const).map((preset) => <button key={preset} type="button" className="publish-quick-chip" data-active={depositInput.trim() === preset ? "true" : "false"} disabled={formDisabled} onClick={() => changeDeposit(preset)}>{`${preset} 元`}</button>)}</div><FieldError text={depositProblem()?.message} />{recommendation?.available ? <div className="supply-recommend-result" data-fresh={recommendationFresh && !recommendationBinding?.mismatch ? "true" : "false"}><small>{recommendationAmountYuan === null ? "推荐金额待确认，请重新读取；不会按零元采用。" : recommendationAdopted && recommendationCatalogFresh ? `已采用推荐 ${moneyText({ amount: recommendationAmountYuan })}。` : recommendationBinding?.mismatch ? "推荐结果与当前账号资料或规则不匹配，已过期；请重新查看。" : recommendationFresh ? `推荐 ${moneyText({ amount: recommendationAmountYuan })}（依据当前账号资料）。` : `推荐 ${moneyText({ amount: recommendationAmountYuan })}已过期：资料已修改，请重新查看。`}</small><button type="button" className="button quiet" disabled={formDisabled || recommendationBusy || !recommendationFresh || recommendationAdopted} onClick={() => void adoptRecommendation()}>{recommendationBusy ? "核对中…" : recommendationAdopted && recommendationCatalogFresh ? "已采用" : "采用推荐"}</button></div> : recommendation && !recommendation.available ? <div className="supply-recommend-result supply-recommend-result--unavailable" role="status"><AlertCircle size={14} aria-hidden="true" /><span>{recommendation.reason === "FUNDING_POLICY_UNCONFIGURED" ? "当前规则尚未配置推荐押金依据，可自行填写押金。" : "请先补全安全箱、体力、负重、潜水与皮肤资料后再查看推荐押金。"}</span></div> : null}</div></div>
        </section>

        <section className="publish-term-section publish-term-note-section">
          <div className="publish-term-section-heading"><FileText size={20} aria-hidden="true" /><h3>补充信息</h3></div>
          <div className="publish-term-row">
            <div className="publish-term-label"><label htmlFor="publish-description">备注（选填）</label><span className="publish-visibility-tag">向租客公开</span></div>
            <div className="publish-term-control">
              <Textarea id="publish-description" rows={3} maxLength={4000} value={draft.description ?? ""} disabled={formDisabled} aria-invalid={Boolean(fieldError("description"))} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="填写上号配合或账号使用说明（向租客公开展示）" />
              <FieldError text={fieldError("description")} />
            </div>
          </div>
          {infoSourceOptions?.enabled || infoSourceValue ? <div className="publish-term-row">
            <div className="publish-term-label"><span>信息来源（选填）</span><span className="publish-visibility-tag publish-visibility-tag--private">仅平台可见</span></div>
            <div className="publish-term-control">
              <FormSelect label="信息来源（选填）" value={infoSourceValue} disabled={formDisabled || !infoSourceOptions?.enabled || infoSourceOptions.optionsState !== "CONFIGURED"} placeholder="请选择信息来源" popupClassName="publish-select-popup" options={[{ value: "", label: "请选择信息来源" }, ...(infoSourceLegacy ? [{ value: infoSourceValue, label: `${infoSourceValue}（历史来源原文）` }] : []), ...(infoSourceOptions?.options?.map(option => ({ value: option.value, label: option.name })) ?? [])]} onChange={value => changeAttribute("info_source", value || null)} />
              {infoSourceLegacy ? <small>已保留历史来源原文，重新选择后才会替换。</small> : null}
              <FieldError text={fieldError("attributes.info_source")} />
            </div>
          </div> : null}
        </section>
      </div>
    </SectionCard>
  );
}
