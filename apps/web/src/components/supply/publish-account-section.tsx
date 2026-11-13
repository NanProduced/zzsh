"use client";

import type { Dispatch, SetStateAction } from "react";
import { Clock3 } from "lucide-react";
import { FormSelect, FormRadioGroup, Input, IntegerStepper } from "../ui/form-controls";
import { ManagedNoticeText } from "@/components/content/managed-notice";
import { DELTA_REGION_OPTIONS } from "../../lib/delta-region-options";
import {
  SERVICE_WINDOW_END_OPTIONS,
  SERVICE_WINDOW_START_OPTIONS,
} from "../../lib/listing-filters";
import { minutesToTimeValue } from "../../lib/publish-derive";
import type { DraftInput, PublishingOptions, SupplyGame } from "../../lib/supply-types";
import {
  FieldError,
  FieldHelp,
  SectionCard,
} from "./publish-dialogs";
import {
  groupMeta,
  serviceTimeOptions,
} from "./publish-form-helpers";
import { RegionPicker } from "./publish-region-picker";
import type { PublishGroupId, UiProblem } from "./publish-form-types";

export type PublishAccountSectionProps = {
  accountId?: string;
  games: SupplyGame[];
  gameId: string;
  selectGame: (id: string) => void;
  formDisabled: boolean;
  options: PublishingOptions | null;
  draft: DraftInput;
  setDraft: (next: DraftInput | ((previous: DraftInput) => DraftInput)) => void;
  changeAttribute: (key: string, value: string | number | boolean | null) => void;
  errorGroups: Set<PublishGroupId>;
  fieldError: (path: string) => string | undefined;
  requireNewAccountFacts: boolean;
  accountRequiredDone: number;
  accountRequiredTotal: number;
  safeBoxChoiceOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  currentSafeBox: string;
  declarationOptions?: Record<string, { enabled?: boolean; required?: boolean; label?: string }>;
  currentGrading: string;
  gradingOptions: Array<{ code: string; displayName?: string | null; divisions?: number[] }>;
  currentGradingDivision: number | null;
  currentDivisions: number[];
  kdProblem: () => UiProblem | null;
  currentVitality: string;
  vitalityChoiceOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  vitalityChoiceNote: string | null;
  currentBear: string;
  bearChoiceOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  bearChoiceNote: string | null;
  currentDive: string;
  diveChoiceOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  diveChoiceNote: string | null;
  loginChoiceOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  currentLoginMethod: string;
  serviceWindowMode: "allDay" | "window" | null;
  serviceWindowStart: number | null;
  serviceWindowEnd: number | null;
  serviceWindowAllDay: boolean;
  serviceWindowEqual: boolean;
  serviceWindowHasLegacyValue: boolean;
  changeAllDay: (allDay: boolean) => void;
  changeServiceWindow: (key: "service_window_start_minute" | "service_window_end_minute", value: string) => void;
  applyServiceWindowPreset: (start: number, end: number) => void;
};

export function PublishAccountSection({
  accountId,
  games,
  gameId,
  selectGame,
  formDisabled,
  options,
  draft,
  setDraft,
  changeAttribute,
  errorGroups,
  fieldError,
  requireNewAccountFacts,
  accountRequiredDone,
  accountRequiredTotal,
  safeBoxChoiceOptions,
  currentSafeBox,
  declarationOptions,
  currentGrading,
  gradingOptions,
  currentGradingDivision,
  currentDivisions,
  kdProblem,
  currentVitality,
  vitalityChoiceOptions,
  vitalityChoiceNote,
  currentBear,
  bearChoiceOptions,
  bearChoiceNote,
  currentDive,
  diveChoiceOptions,
  diveChoiceNote,
  loginChoiceOptions,
  currentLoginMethod,
  serviceWindowMode,
  serviceWindowStart,
  serviceWindowEnd,
  serviceWindowAllDay,
  serviceWindowEqual,
  serviceWindowHasLegacyValue,
  changeAllDay,
  changeServiceWindow,
  applyServiceWindowPreset,
}: PublishAccountSectionProps) {
  return (
    <SectionCard
      id="account"
      title={groupMeta.account.title}
      hasError={errorGroups.has("account")}
      headerMeta={
        <span className="publish-section-progress" data-complete={accountRequiredDone === accountRequiredTotal ? "true" : "false"}>
          {accountRequiredDone === accountRequiredTotal ? "必填已齐" : `必填 ${accountRequiredDone}/${accountRequiredTotal}`}
        </span>
      }
    >
      <div className="publish-account-flow">
        {!accountId && games.length > 1 ? (
          <label className="publish-game-field">游戏
            <FormSelect label="游戏"
              value={gameId}
              disabled={Boolean(accountId) || formDisabled}
              placeholder="选择游戏"
              popupClassName="publish-select-popup"
              options={games.map((option) => ({ value: option.id, label: option.name }))}
              onChange={(val) => selectGame(val)}
            />
            <small>仅显示已开放出租的游戏。</small>
          </label>
        ) : null}
        <div className="publish-account-subhead supply-wide"><span>基础规格与赛季</span></div>
        <fieldset id="publish-attribute-safe-box" tabIndex={-1} className="supply-radio-field publish-choice-field publish-safe-box-field supply-wide"><legend><span className="publish-account-label">安全箱档位{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="安全箱档位"><ManagedNoticeText contentKey="placement:PUBLISH_SAFE_BOX" fallback="根据账号当前赛季实际安全箱规格如实选择；顶级安全箱(3*3)仅限赛季3x3可选，与九格保险体验卡二选一。" /></FieldHelp></span></legend>
          {safeBoxChoiceOptions.length ? <FormRadioGroup variant="segmented" name="safe_box_code" label="安全箱档位" required={requireNewAccountFacts} error={fieldError("attributes.safe_box_code")} value={currentSafeBox} options={safeBoxChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("safe_box_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置安全箱档位。" : "正在读取安全箱档位…"}</small>}
          <small className="publish-choice-hint">顶级安全箱(3*3)仅限赛季3x3可选，与九格保险体验卡互斥</small>
        </fieldset>
        {(["next_season_pass", "demulan_unlocked"] as const).some(key => declarationOptions?.[key]?.enabled || typeof draft.attributes[key] === "boolean") ? <div className="publish-safety-row supply-wide">
          {(["next_season_pass", "demulan_unlocked"] as const).map(key => {
            const field = declarationOptions?.[key];
            if (!field?.enabled && typeof draft.attributes[key] !== "boolean") return null;
            const label = key === "next_season_pass" ? "下赛季通行证" : "解锁德穆兰";
            const selected = typeof draft.attributes[key] === "boolean" ? draft.attributes[key] as boolean : null;
            return <fieldset key={key} id={`publish-declaration-${key}`} tabIndex={-1} aria-required={field?.required || undefined} className="supply-radio-field publish-choice-field">
              <legend><span className="publish-account-label">{label}</span></legend>
              <FormRadioGroup variant="segmented" name={key} label={label} value={selected} options={[{ value: true, label: "是" }, { value: false, label: "否" }]} disabled={formDisabled || !field?.enabled} onChange={value => changeAttribute(key, value)} error={fieldError(`attributes.${key}`)} />
              <small>{key === "next_season_pass" ? "下赛季是否计划购买通行证、续费六格保险箱。" : "当前账号是否已经解锁德穆兰。"}</small>
            </fieldset>;
          })}
        </div> : null}
        <div className="publish-performance-row supply-wide">
          <div id="publish-character-level" tabIndex={-1} className="publish-account-integer-field"><span className="publish-account-label">账号等级{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}</span><IntegerStepper label="账号等级" required={requireNewAccountFacts} value={String(draft.attributes.character_level??"")} max="60" disabled={formDisabled} onChange={raw=>changeAttribute("character_level",raw===""?null:Number(raw))} /><div className="publish-quick-chips" role="group" aria-label="常用账号等级">{([{ value: 30, label: "30级" }, { value: 50, label: "50级" }, { value: 60, label: "60级满级" }] as const).map((preset) => <button key={preset.value} type="button" className="publish-quick-chip" data-active={draft.attributes.character_level === preset.value ? "true" : "false"} disabled={formDisabled} onClick={() => changeAttribute("character_level", preset.value)}>{preset.label}</button>)}</div>{typeof draft.attributes.character_level==="number"&&draft.attributes.character_level>60?<small className="publish-legacy-choice-note">已保留历史{draft.attributes.character_level}级原值；请核对后填写0–60级。</small>:null}</div>
          <label id="publish-attribute-grading" tabIndex={-1} className="publish-grading-field"><span className="publish-account-label">段位<span className="publish-required-mark">必填</span></span>
            <div className="publish-grading-group">
              <FormSelect label="账号段位" required
                value={currentGrading}
                disabled={formDisabled || !options}
                placeholder="请选择段位"
                popupClassName="publish-select-popup"
                options={[
                  { value: "", label: "未申报" },
                  ...(currentGrading && !gradingOptions.some((option) => option.code === currentGrading) ? [{ value: currentGrading, label: "未确认" }] : []),
                  ...(gradingOptions.map((option) => ({ value: option.code, label: option.displayName ?? "未确认" }))),
                ]}
                onChange={(val) => {
                  changeAttribute("grading_code", val || null);
                  const nextOpt = gradingOptions.find((opt) => opt.code === val) as { divisions?: number[] } | undefined;
                  const nextDivs = nextOpt?.divisions?.length
                    ? nextOpt.divisions
                    : ["2", "3", "4", "5", "6", "7"].includes(val)
                      ? [3, 2, 1]
                      : [];
                  if (!nextDivs.length || (currentGradingDivision !== null && !nextDivs.includes(currentGradingDivision))) {
                    changeAttribute("grading_division", null);
                  }
                }}
              />
              {currentDivisions.length > 0 ? (
                <FormSelect label="小段位"
                  value={currentGradingDivision !== null ? String(currentGradingDivision) : ""}
                  disabled={formDisabled || !options}
                  placeholder="小段位（选填）"
                  popupClassName="publish-select-popup"
                  options={[
                    { value: "", label: "未选小段位" },
                    ...currentDivisions.map((div: number) => ({ value: String(div), label: `${div} 级` })),
                  ]}
                  onChange={(val) => changeAttribute("grading_division", val ? Number(val) : null)}
                />
              ) : null}
            </div>
          </label>
          <label className="publish-kd-field" htmlFor="publish-secret-kd"><span className="publish-account-label">绝密KD{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="绝密KD">填写当前赛季绝密模式显示的KD，可填写小数，例如1.85。</FieldHelp></span><Input id="publish-secret-kd" data-publish-entry aria-label="绝密KD" aria-required={requireNewAccountFacts || undefined} type="text" inputMode="decimal" maxLength={32} autoComplete="off" value={String(draft.attributes.secret_kd ?? "")} disabled={formDisabled} aria-invalid={Boolean(kdProblem())} aria-describedby={kdProblem() ? "publish-secret-kd-error" : undefined} onChange={(event) => changeAttribute("secret_kd", event.target.value === "" ? null : event.target.value)} placeholder="例如 1.85" /><FieldError id="publish-secret-kd-error" text={kdProblem()?.message} /></label>
        </div>
        <div className="publish-account-subhead supply-wide"><span>角色身体素质</span></div>
        <div className="publish-vitality-matrix supply-wide">
          <fieldset id="publish-attribute-vit" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-vitality-field"><legend>体力等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="vit_level" label="体力等级" required error={fieldError("attributes.vit_level")} value={currentVitality} options={vitalityChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("vit_level", Number(value))} />{vitalityChoiceNote ? <small className="publish-legacy-choice-note">{vitalityChoiceNote}</small> : null}</fieldset>
          <fieldset id="publish-attribute-bear" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-bear-field"><legend>负重等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="bear_level" label="负重等级" required error={fieldError("attributes.bear_level")} value={currentBear} options={bearChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("bear_level", Number(value))} />{bearChoiceNote ? <small className="publish-legacy-choice-note">{bearChoiceNote}</small> : null}</fieldset>
          <fieldset id="publish-attribute-dive" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-dive-field"><legend>潜水等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="dive_level" label="潜水等级" required error={fieldError("attributes.dive_level")} value={currentDive} options={diveChoiceOptions} disabled={formDisabled} onChange={(value) => changeAttribute("dive_level", Number(value))} />{diveChoiceNote ? <small className="publish-legacy-choice-note">{diveChoiceNote}</small> : null}</fieldset>
        </div>
        <div className="publish-account-subhead supply-wide"><span>上号配合与合规声明</span></div>
        <fieldset id="publish-attribute-login" tabIndex={-1} className="supply-radio-field publish-choice-field publish-login-field supply-wide"><legend><span className="publish-account-label">上号方式<span className="publish-required-mark">必填</span><FieldHelp label="上号方式">选择租客上号时，你可以配合的登录方式。</FieldHelp></span></legend>
          {loginChoiceOptions.length ? <FormRadioGroup variant="segmented" className="publish-login-segmented" name="login_method_code" label="上号方式" required error={fieldError("attributes.login_method_code")} value={currentLoginMethod} options={loginChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("login_method_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置上号方式。" : "正在读取上号方式…"}</small>}
        </fieldset>
        <div className="publish-service-row supply-wide">
          <RegionPicker province={String(draft.attributes.region_province ?? "")} city={String(draft.attributes.region_city ?? "")} options={DELTA_REGION_OPTIONS} disabled={formDisabled} required={requireNewAccountFacts} error={fieldError("attributes.region_province") || fieldError("attributes.region_city")} onChange={(province, city) => setDraft((previous) => ({ ...previous, attributes: { ...previous.attributes, region_province: province, region_city: city } }))} />
          <div id="publish-service-window" tabIndex={-1} className="publish-service-window">
            <span className="publish-account-label"><Clock3 size={16} aria-hidden="true" />可配合上号时间{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<span className="publish-timezone">北京时间</span><FieldHelp label="可配合上号时间">填写你能协助上号的时间。支持跨日时段，例如22:00至次日02:00。</FieldHelp></span>
            <FormRadioGroup variant="segmented" className="publish-window-mode" name="service_window_mode" label="可配合上号时间" required={requireNewAccountFacts} value={serviceWindowMode} options={[{value:"allDay",label:"全天可配合"},{value:"window",label:"按时段配合"}]} disabled={formDisabled} onChange={value => changeAllDay(value === "allDay")} />
            {serviceWindowMode === "window" ? <>
              <div className="publish-quick-chips publish-window-presets" role="group" aria-label="常用配合时段">
                {([{ start: 480, end: 1440, label: "白天 08:00–24:00" }, { start: 1080, end: 120, label: "晚间 18:00–02:00" }, { start: 1320, end: 480, label: "通宵 22:00–08:00" }] as const).map((preset) => (
                  <button key={preset.label} type="button" className="publish-quick-chip" data-active={serviceWindowStart === preset.start && serviceWindowEnd === preset.end ? "true" : "false"} disabled={formDisabled} onClick={() => applyServiceWindowPreset(preset.start, preset.end)}>{preset.label}</button>
                ))}
              </div>
              <span className="supply-time-range">
                <FormSelect label="开始时间" value={serviceWindowStart === null ? "" : String(serviceWindowStart)} disabled={formDisabled} placeholder="开始时间" popupClassName="publish-select-popup" options={serviceTimeOptions(SERVICE_WINDOW_START_OPTIONS, serviceWindowStart)} onChange={(value) => changeServiceWindow("service_window_start_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
                <span aria-hidden="true" className="supply-time-separator">至</span>
                <FormSelect label="结束时间" value={serviceWindowEnd === null ? "" : String(serviceWindowEnd)} disabled={formDisabled} placeholder="结束时间" popupClassName="publish-select-popup" options={serviceTimeOptions(SERVICE_WINDOW_END_OPTIONS, serviceWindowEnd)} onChange={(value) => changeServiceWindow("service_window_end_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
              </span>
            </> : serviceWindowAllDay ? <output className="publish-window-summary sr-only">全天可配合 · 00:00 至 24:00</output> : null}
            {serviceWindowEqual ? <small className="supply-field-error" role="alert">开始和结束时间不能相同。</small> : null}
            {serviceWindowMode === "window" && serviceWindowStart !== null && serviceWindowEnd !== null && !serviceWindowEqual ? <output className="publish-window-summary">可配合时间：{minutesToTimeValue(serviceWindowStart)} 至 {serviceWindowEnd < serviceWindowStart ? "次日 " : ""}{minutesToTimeValue(serviceWindowEnd)}</output> : null}
            {serviceWindowHasLegacyValue ? <small className="publish-legacy-choice-note">已保留历史非 30 分钟原值；新选择仅支持每 30 分钟一个时间点。</small> : null}
          </div>
        </div>
        <div className="publish-safety-row supply-wide">
          <fieldset id="publish-attribute-ban" tabIndex={-1} className="supply-radio-field"><legend>封禁记录{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}</legend>
            <div className="supply-radio-group">
              <FormRadioGroup variant="segmented" name="ban_record" label="封禁记录" required={requireNewAccountFacts} value={draft.attributes.ban_record as boolean | null} options={[{value:false,label:"无封禁记录"},{value:true,label:"有封禁记录"}]} disabled={formDisabled} onChange={value => changeAttribute("ban_record",value)} />
            </div>
            {draft.attributes.ban_record === true ? <small className="publish-choice-hint publish-choice-hint--alert">注意：已声明有封禁记录，必须在下方“展示图片”区域上传该账号三角洲行动所有封禁记录截图。</small> : null}
          </fieldset>
          <fieldset id="publish-attribute-face" tabIndex={-1} className="supply-radio-field"><legend><span className="publish-account-label">人脸归属{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="人脸归属">请选择账号人脸认证是否属于号主本人；该信息由号主申报。</FieldHelp></span></legend>
            <div className="supply-radio-group">
              <FormRadioGroup variant="segmented" name="face_is_self" label="人脸归属" required={requireNewAccountFacts} value={draft.attributes.face_is_self as boolean | null} options={[{value:true,label:"号主本人"},{value:false,label:"非号主本人"}]} disabled={formDisabled} onChange={value => changeAttribute("face_is_self",value)} />
            </div>
          </fieldset>
        </div>
      </div>
    </SectionCard>
  );
}
