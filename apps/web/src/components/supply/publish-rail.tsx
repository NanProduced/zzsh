"use client";

import Link from "next/link";
import type { Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from "react";
import { ChevronDown, Check, TriangleAlert, Clock3 } from "lucide-react";
import { FieldHelp, PendingValue } from "./publish-dialogs";
import { centsText, yuanFromCents } from "../../lib/publish-derive";
import { moneyText, blockerText } from "./publish-form-helpers";
import type {
  MySupply,
  PublishingCatalog,
  OwnerIncomePreview,
  PublishingOptions,
  FullPayoutTerms,
} from "../../lib/supply-types";
import type { IdentityState } from "./publish-form-types";

export interface PublishRailProps {
  railRef: RefObject<HTMLElement | null>;
  railExpanded: boolean;
  setRailExpanded: Dispatch<SetStateAction<boolean>>;
  effectiveQuote: any;
  ownerPreviewStale: boolean;
  ownerIncomePreviewPending: boolean;
  railSummary: { label: string; value: string; pending?: boolean };
  published: boolean;
  readOnly: boolean;
  accountId?: string;
  netEstimate: any;
  breakdown: any;
  previewGrossAmount: string | null;
  payoutSelected: boolean | null;
  ownerPreview: OwnerIncomePreview | null;
  pendingTotalHint: string;
  displayEstimateDuration: string | null;
  resourceTotalText: string | null;
  declaredDepositCents: string | null;
  depositInput: string;
  actualPublisherRequirement: bigint | null;
  catalog: PublishingCatalog | null;
  supply: MySupply | null;
  quoteConsistent: boolean;
  visibleBlockers: string[];
  userBlockers: string[];
  systemBlockers: string[];
  busy: string | null;
  formDisabled: boolean;
  refreshLatest: (preserveQuote?: boolean) => Promise<void>;
  agreement: PublishingOptions["agreement"] | null | undefined;
  currentPayoutTerms: FullPayoutTerms | null;
  payoutTerms: any;
  payoutTarget: any;
  mustCreateAccount: boolean;
  reviewState?: string | null;
  identityState: IdentityState;
  identityRef: MutableRefObject<any>;
  beginEditing: () => Promise<void>;
  agreementConsent: ReactNode;
  payoutConsent: ReactNode;
  primaryDisabled: boolean;
  blockerHint: string | undefined;
  confirmPublish: () => Promise<void>;
  primaryLabel: string;
  save: () => Promise<void>;
  rulesAccepted: boolean;
  primaryAction: () => Promise<void>;
}

export function PublishRail({
  railRef,
  railExpanded,
  setRailExpanded,
  effectiveQuote,
  ownerPreviewStale,
  ownerIncomePreviewPending,
  railSummary,
  published,
  readOnly,
  accountId,
  netEstimate,
  breakdown,
  previewGrossAmount,
  payoutSelected,
  ownerPreview,
  pendingTotalHint,
  displayEstimateDuration,
  resourceTotalText,
  declaredDepositCents,
  depositInput,
  actualPublisherRequirement,
  catalog,
  supply,
  quoteConsistent,
  visibleBlockers,
  userBlockers,
  systemBlockers,
  busy,
  formDisabled,
  refreshLatest,
  agreement,
  currentPayoutTerms,
  payoutTerms,
  payoutTarget,
  mustCreateAccount,
  reviewState,
  identityState,
  identityRef,
  beginEditing,
  agreementConsent,
  payoutConsent,
  primaryDisabled,
  blockerHint,
  confirmPublish,
  primaryLabel,
  save,
  rulesAccepted,
  primaryAction,
}: PublishRailProps) {
  return (
    <>
      {railExpanded ? <div className="publish-rail-backdrop" aria-hidden="true" onClick={() => setRailExpanded(false)} /> : null}
      <aside ref={railRef} id="publish-quote" tabIndex={-1} className="publish-rail" data-quoted={effectiveQuote ? "true" : "false"} data-expanded={railExpanded ? "true" : "false"} data-stale={ownerPreviewStale ? "true" : "false"} data-pending={ownerIncomePreviewPending ? "true" : undefined} aria-label="出租报价">
        <div className="publish-rail-head">
          <div className="publish-rail-heading-group">
            <h2>预计出租收入</h2>
          </div>
          <FieldHelp label="查看出租报价">预计收入为号主侧哈夫币和物品的扣费前金额，按全部库存消耗估算。押金不计入收入；实际收入按使用情况和结算场景计算，不保证最终到账；计价单位均为人民币（元）。</FieldHelp>
          <div className="publish-rail-mobile-summary">
            <span>{railSummary.label}</span>
            <strong data-pending={railSummary.pending ? "true" : undefined}>{railSummary.value}</strong>
          </div>
          <button type="button" className="publish-rail-mobile-toggle" aria-expanded={railExpanded} aria-controls="publish-quote-body" onClick={() => setRailExpanded((value) => !value)}>
            {railExpanded ? "收起" : "明细"}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="publish-rail-scroll" id="publish-quote-body">
        {published ? <div className="publish-success" role="status"><Check size={20} aria-hidden="true" /><strong>已上架</strong><p>公众列表、详情与“我的上架账号”显示的是同一份发布资料。</p>{readOnly ? <p>上架后不可修改；如需变更，请先在账号管理中下架，再重新填写上架资料。</p> : null}<div className="supply-inline-actions"><Link className="button primary" href={`/accounts/${encodeURIComponent(accountId ?? "")}`}>查看公开详情</Link><Link className="button secondary" href="/account?view=accounts">我的上架账号</Link></div></div> : <>
          {netEstimate ? <div className="publish-income-total"><span>预计所得</span><output aria-label="预计净所得">{netEstimate.ownerNet.amount} 元</output></div> : effectiveQuote ? (
            <div className="publish-income-total">
              <span>预计收入（扣费前）</span>
              <output aria-label="预计收入合计">{breakdown ? `${centsText(breakdown.totalCents)} 元` : "金额待核对"}</output>
            </div>
          ) : previewGrossAmount ? (
            <div className="publish-income-total">
              <span>{payoutSelected === true ? "预计收入（扣费前）" : ownerPreview?.state === "PARTIAL" ? "预计总收入（部分）" : "预计总收入"}{ownerPreviewStale ? <small className="publish-stale-tag">（上次预估）</small> : null}</span>
              <output aria-label="实时预估总收入">{`${previewGrossAmount} 元`}</output>
            </div>
          ) : (
            <div className="publish-income-total publish-income-total--pending">
              <span>预计总收入</span>
              <output aria-label="待核算总收入"><PendingValue label="待核算" /></output>
              <small className="publish-pending-hint">{pendingTotalHint}</small>
            </div>
          )}
          <dl className="publish-rail-lines">
            <div>
              <dt>哈夫币计价比例</dt>
              <dd>
                {effectiveQuote?.ownerHaffRatio
                  ? `${effectiveQuote.ownerHaffRatio} 万哈夫币/元`
                  : ownerPreview?.ownerHaffRatioWanPerYuan
                    ? `${ownerPreview.ownerHaffRatioWanPerYuan} 万哈夫币/元`
                    : <PendingValue label="待核定" />}
              </dd>
            </div>
            <div>
              <dt>预计租期{!effectiveQuote && displayEstimateDuration ? <small>按当前条件估算</small> : null}</dt>
              <dd>
                {displayEstimateDuration ?? <PendingValue label="待核算" />}
              </dd>
            </div>
            <div>
              <dt>哈夫币预计收入</dt>
              <dd>
                {effectiveQuote && breakdown
                  ? `${centsText(breakdown.haffCents)} 元`
                  : ownerPreview?.ownerHaffIncome
                    ? `${ownerPreview.ownerHaffIncome.amount} 元`
                    : ownerIncomePreviewPending
                      ? "计算中…"
                      : <PendingValue label="待核定" />}
              </dd>
            </div>
            <div className="publish-live-resource-total" aria-busy={ownerIncomePreviewPending&&!effectiveQuote}>
              <dt>物品预计收入{ownerPreviewStale&&!effectiveQuote?<small>上次预估</small>:null}</dt>
              <dd><output aria-label="物品预估收入" aria-live="off">{resourceTotalText ?? <PendingValue label="待填" />}</output></dd>
            </div>
          </dl>
          <p className="publish-rail-note">按库存全部用完预估，押金不计入收入。</p>
          {netEstimate ? <div className="publish-fee-pending" role="status">
            <div><span>扣费前收入</span><strong>{netEstimate.ownerGross.amount} 元</strong></div>
            {netEstimate.platformFee ? <div><span>平台手续费</span><strong>−{netEstimate.platformFee.amount.amount} 元</strong></div> : null}
            <div><span>全额包赔服务费{netEstimate.selected ? "（8%）" : ""}</span><strong>{netEstimate.selected ? `−${netEstimate.serviceFee.amount.amount} 元` : "未选择，不收取"}</strong></div>
            <p>按全部申报库存用完、正常结束预估；实际按使用情况与结算条款核算。</p>
          </div> : payoutSelected === true ? <div className="publish-fee-pending" role="status"><div><span>全额包赔服务费</span><strong>{ownerIncomePreviewPending || ownerPreviewStale ? "正在重新核算…" : "金额待核定"}</strong></div><p>当前为扣费前收入，费后金额尚未核定。</p></div> : payoutSelected === null ? <p className="publish-rail-note">选择赔付方案后可查看费后预计所得。</p> : null}
          <dl className="publish-rail-lines publish-rail-deposits">
            <div><dt>基础租客押金<small>不计入收入</small></dt><dd>{!ownerPreviewStale && ownerPreview?.depositState === "KNOWN" && ownerPreview.baseTenantDeposit ? moneyText(ownerPreview.baseTenantDeposit) : declaredDepositCents !== null ? `${yuanFromCents(declaredDepositCents)} 元` : depositInput.trim() ? "请检查金额" : <PendingValue label="待填" />}</dd></div>
            {!ownerPreviewStale && ownerPreview?.depositState === "KNOWN" && ownerPreview.baseTenantDeposit ? <div className="publish-deposit-verified"><dt><Check size={12} aria-hidden="true" />符合押金要求</dt></div> : null}
            {actualPublisherRequirement !== null && actualPublisherRequirement > 0n ? <div><dt>发布保证金<small>本次规则要求</small></dt><dd>{moneyText(effectiveQuote?.publisherBailRequirement)}</dd></div> : null}
          </dl>
          {actualPublisherRequirement !== null && actualPublisherRequirement > 0n ? <p className="publish-rail-note">请先保存草稿，再前往 <Link href="/account?view=credit">信用与保证金</Link> 查看缴纳状态。</p> : null}
          {effectiveQuote ? <small className="publish-rail-deposit-note">会员实际实付押金以下单时的个人报价为准。</small> : null}
          {effectiveQuote?.expiryDisclosures.length ? <div className="publish-rail-expiry"><strong>权益有效期</strong>{effectiveQuote.expiryDisclosures.map((item: any) => <p key={item.entitlementId}>{catalog?.entitlements.find((entitlement: any) => entitlement.id === item.entitlementId)?.name ?? supply?.version?.presentation?.entitlements.find((entitlement: any) => entitlement.id === item.entitlementId)?.name ?? "该项权益"}：{item.expiresAt ? new Date(item.expiresAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "长期有效"} · 本租期不保证覆盖完整有效期</p>)}</div> : null}
          {effectiveQuote && !quoteConsistent ? <div className="supply-blockers" role="alert"><strong>报价金额待核对</strong><p>本次报价的行金额与合计不一致，暂不能确认上架。</p></div> : null}
          {visibleBlockers.length ? <div className="supply-blockers" data-blocker-count={visibleBlockers.length}>
            {userBlockers.length ? <section className="supply-blocker-group is-user" data-blocker-group="user"><strong><TriangleAlert size={14} aria-hidden="true" />上架限制（{userBlockers.length}）</strong><ul>{Array.from(new Set(userBlockers.map(blockerText))).map((text) => <li key={text}>{text}</li>)}</ul></section> : null}
            {systemBlockers.length ? <section className="supply-blocker-group is-system" data-blocker-group="system"><strong><Clock3 size={14} aria-hidden="true" />暂无法上架</strong><ul>{Array.from(new Set(systemBlockers.map(blockerText))).map((text) => <li key={text}>{text}</li>)}</ul></section> : null}
            <p className="supply-muted" role="status">当前暂不可提交上架，请处理上述事项或联系客服。</p>
            <button type="button" className="button secondary" disabled={Boolean(busy) || formDisabled} onClick={() => void refreshLatest(false)}>刷新状态</button>
          </div> : null}
          {!agreement ? <p className="supply-muted">本次条款正文尚未读取，暂不能确认上架。</p> : null}
          {payoutSelected === true && !published && !currentPayoutTerms ? (
            <p className="supply-muted" role={payoutTerms?.status === "unavailable" ? "alert" : "status"}>
              {payoutTerms?.target === payoutTarget && payoutTerms.status === "unavailable"
                ? "全额包赔条款暂时无法读取或版本已变化，请刷新后重试。"
                : "正在读取本次全额包赔条款…"}
            </p>
          ) : null}
        </>}
        </div>
        {!published ? <div className="publish-rail-footer">
          {readOnly ? <div className="publish-rail-readonly"><p>{mustCreateAccount ? "此账号不能修改或再次上架；如需出租，请重新填写上架资料。" : reviewState === "SUBMITTED" ? "当前资料正在审核中，不能直接编辑。" : "当前资料不是可编辑草稿。"}</p>{mustCreateAccount ? <Link className="button primary" href="/publish">重新填写上架资料</Link> : reviewState === "SUBMITTED" ? <Link href="/account?view=accounts" className="button secondary">返回账号管理</Link> : <button type="button" className="button primary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "继续填写草稿"}</button>}</div> : <>
            {effectiveQuote ? <div className="publish-confirm">
              <div className="publish-consent-card">
                {agreementConsent}
                {payoutConsent}
              </div>
              <button type="button" className="button primary" disabled={primaryDisabled} title={blockerHint} onClick={() => void confirmPublish()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
              {rulesAccepted ? <p className="supply-muted">条款已按当前资料确认；资料变化后需重新确认。</p> : null}
            </div> : <div className="publish-rail-actions">
              <div className="publish-consent-card">
                {agreementConsent}
                {payoutConsent}
              </div>
              <button type="button" className="button primary" disabled={primaryDisabled} title={blockerHint} onClick={() => void primaryAction()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
            </div>}
          </>}
        </div> : null}
      </aside>
    </>
  );
}
