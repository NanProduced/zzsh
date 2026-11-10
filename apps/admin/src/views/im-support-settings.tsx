"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Clock3, Copy, Info, MessageSquare, ShoppingBag, Users, Webhook } from "lucide-react";
import { friendlyError } from "../api";
import { Badge } from "../components/ui/badge";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { formatDateTime } from "./im-support-format";
import type { SupportManagementRequest } from "./im-support-management";
import "./im-support-settings.css";

type SceneGroup = "welcome" | "reception" | "orders" | "reminders" | "integration";
type SceneStatus = "editable" | "builtin" | "policy";
type FieldKey = "serviceMessage" | "complaintMessage";
type Scene = {
  key: string;
  group: Exclude<SceneGroup, "integration">;
  label: string;
  when: string;
  sender: string;
  note: string;
  status: SceneStatus;
  field?: FieldKey;
  buckets?: readonly string[];
};
type ReadCopyStatus = "RECEIVER_UNAVAILABLE" | "DISABLED" | "WAITING_FOR_CALLBACK" | "CALLBACK_OBSERVED";
type ReadCopySettings = {
  version: number;
  enabled: boolean;
  publicOrigin: string | null;
  callbackPath: string;
  callbackUrl: string | null;
  receiverReady: boolean;
  status: ReadCopyStatus | string;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
  lastEventAt: string | null;
  serverNow: string;
};
type ReadCopyDraft = { version: number; enabled: boolean; publicOrigin: string };
type ReadCopyPayload = { version: number; enabled: boolean; publicOrigin: string | null; operationId: string };
type ReadCopyStatusInfo = {
  label: string;
  variant: "secondary" | "info" | "warning" | "unknown";
  title: string;
  description: string;
  inconsistent?: boolean;
};

const DUE_BUCKETS = ["到期前 24 小时", "订单已到期", "超期 1 天", "超期 2 天", "超期 3 天"] as const;

const SCENES: readonly Scene[] = [
  { key: "SERVICE_WELCOME", group: "welcome", label: "在线咨询欢迎消息", when: "新一轮在线咨询创建并完成建群后", sender: "洲洲助手（系统）", note: "只在新轮次开场发送；当前接待中的轮次沿用原消息。", status: "editable", field: "serviceMessage" },
  { key: "COMPLAINT_WELCOME", group: "welcome", label: "投诉入口欢迎消息", when: "从投诉入口发起新一轮咨询后", sender: "洲洲助手（系统）", note: "投诉使用独立持久线程；不另建工单或投诉群。", status: "editable", field: "complaintMessage" },
  { key: "QUEUE_NO_STAFF", group: "reception", label: "暂无可用客服", when: "用户已留言，自动派单没有合格候选", sender: "洲洲助手（系统）", note: "每轮最多一次；发送失败不会反复重试。", status: "builtin" },
  { key: "QUEUE_BUSY", group: "reception", label: "客服繁忙排队（已停用）", when: "历史上客服在线但均已满载时使用", sender: "洲洲助手（系统）", note: "业务不设客服接待硬上限，当前不会再触发；保留历史说明。", status: "builtin" },
  { key: "AGENT_GREETING", group: "reception", label: "客服接入问候", when: "自动分配或手动接入成功，客服成为本轮接待人", sender: "接待客服身份（系统代发）", note: "客服名称由服务端填入；不代表客服已手动输入首条回复。", status: "builtin" },
  { key: "TRANSFER_RECEIVED", group: "reception", label: "转交成功提示", when: "转交完成并确认新的接待客服后", sender: "洲洲助手（系统）", note: "只用于主动转交；新客服名称由服务端填入。", status: "builtin" },
  { key: "ORDER_WELCOME", group: "orders", label: "订单群欢迎", when: "付款后订单群准备就绪，且群内还没有更早的发言", sender: "洲洲助手（系统）", note: "群内已有沟通时跳过晚到的欢迎；每个订单阶段只发一次。", status: "builtin" },
  { key: "ORDER_OPENING", group: "orders", label: "开租确认", when: "订单进入开租核对阶段", sender: "洲洲助手（系统）", note: "引导核对账号与订单；通知本身不代表双方已确认。", status: "builtin" },
  { key: "ORDER_ENDING", group: "orders", label: "结束确认", when: "订单进入结束核对阶段", sender: "洲洲助手（系统）", note: "引导双方核对结束信息；不会自动结束订单。", status: "builtin" },
  { key: "ORDER_SETTLED", group: "orders", label: "结算完成", when: "平台确认订单已结算，且仍在结算后沟通窗口内", sender: "洲洲助手（系统）", note: "结算时间由订单填入；不代表退款已到账。", status: "builtin" },
  { key: "ORDER_CANCELLED", group: "orders", label: "订单已取消", when: "订单取消且订单群已就绪；每个订单只发一次", sender: "洲洲助手（系统）", note: "退款状态只对租客展示；不承诺渠道到账时间。", status: "builtin" },
  { key: "DUE_REMINDERS", group: "reminders", label: "租期到期提醒", when: "开租已确认、订单仍在租用，并到达对应提醒节点", sender: "洲洲助手（系统）", note: "到期时间由订单计算；进入结束或结算后停止提醒。", status: "builtin", buckets: DUE_BUCKETS },
  { key: "ESCALATION_WAIT", group: "reminders", label: "补派安抚", when: "部署显式开启首响补派后，订单仍在等待人工接待", sender: "洲洲群主助手（系统）", note: "是否发送取决于部署策略；本页只读，不提供启用开关。", status: "policy" },
];

const scenarioCount = (scenes: readonly Scene[]) => scenes.reduce((total, scene) => total + (scene.buckets?.length ?? 1), 0);
const groupCount = (group: Scene["group"]) => scenarioCount(SCENES.filter((scene) => scene.group === group));
const WELCOME_FIELDS = SCENES.filter((scene): scene is Scene & { field: FieldKey } => scene.group === "welcome" && Boolean(scene.field));

const GROUPS: { id: SceneGroup; title: string; hint: string; description: string; icon: typeof Info }[] = [
  { id: "welcome", title: "咨询开场", hint: `${groupCount("welcome")} 条欢迎可编辑`, description: "只在新一轮咨询建群后发送；保存不重发历史。", icon: MessageSquare },
  { id: "reception", title: "接待通知", hint: `${groupCount("reception")} 条内置通知`, description: "排队、接入与转交由系统按接待状态触发。", icon: Users },
  { id: "orders", title: "订单通知", hint: `${groupCount("orders")} 条内置通知`, description: "建群、开租、结束、结算和取消通知。", icon: ShoppingBag },
  { id: "reminders", title: "到期与补派", hint: "到期提醒与接待补派", description: "五档到期提醒与补派安抚；时间由订单计算。", icon: Clock3 },
  { id: "integration", title: "阅读状态同步", hint: "云信消息接入", description: "将用户的阅读进度同步到客服会话。", icon: Webhook },
];

const STATUS: Record<SceneStatus, { label: string; variant: "outline" | "secondary" | "warning" }> = {
  editable: { label: "可编辑", variant: "outline" },
  builtin: { label: "内置规则", variant: "secondary" },
  policy: { label: "按系统设置", variant: "warning" },
};

const GROUP_FOOTER: Partial<Record<SceneGroup, string>> = {
  reception: "这些通知由系统按接待状态自动发送；客服接入问候使用接待客服身份，不代表客服已手动回复。",
  orders: "订单状态、金额、过账时间和到账判断由业务事实生成，不在此页编辑。",
  reminders: "到期时间由订单计算；补派安抚是否发送取决于部署策略，本页不提供开关。",
};

const READ_COPY_STATUS_INFO: Record<ReadCopyStatus, ReadCopyStatusInfo> = {
  RECEIVER_UNAVAILABLE: {
    label: "暂不可启用",
    variant: "warning",
    title: "同步服务尚未部署",
    description: "请联系技术人员完成服务部署，再开启同步。",
  },
  DISABLED: {
    label: "已关闭",
    variant: "secondary",
    title: "阅读状态同步已关闭",
    description: "服务部署完成后，可填写域名并开启。",
  },
  WAITING_FOR_CALLBACK: {
    label: "等待云信通知",
    variant: "info",
    title: "尚未收到云信通知",
    description: "请确认已在云信后台填写回调地址。",
  },
  CALLBACK_OBSERVED: {
    label: "已收到云信通知",
    variant: "info",
    title: "已收到云信通知",
    description: "下方显示最近收到通知的时间。",
  },
};

function readCopyStatusInfo(settings: ReadCopySettings): ReadCopyStatusInfo {
  const base = Object.hasOwn(READ_COPY_STATUS_INFO, settings.status) ? READ_COPY_STATUS_INFO[settings.status as ReadCopyStatus] : undefined;
  if (!base) {
    return {
      label: "状态未知",
      variant: "unknown",
      title: "无法确认接入状态",
      description: "暂时无法确认同步状态，请刷新重试。",
    };
  }
  if (!settings.receiverReady) {
    return { ...READ_COPY_STATUS_INFO.RECEIVER_UNAVAILABLE, inconsistent: settings.status !== "RECEIVER_UNAVAILABLE" };
  }
  if (settings.status === "RECEIVER_UNAVAILABLE"
    || settings.enabled !== (settings.status !== "DISABLED")
    || (settings.enabled && !settings.publicOrigin)
    || (settings.status === "WAITING_FOR_CALLBACK" && !settings.callbackUrl)
    || (settings.status === "WAITING_FOR_CALLBACK" && Boolean(settings.lastVerifiedAt || settings.lastEventAt))
    || (settings.status === "CALLBACK_OBSERVED" && !settings.lastVerifiedAt && !settings.lastEventAt)) {
    return {
      label: "状态待核对",
      variant: "warning",
      title: "接入状态不一致",
      description: "设置与服务状态不一致，请刷新后核对。",
      inconsistent: true,
    };
  }
  return base;
}

function readCopyOriginError(value: string, enabled: boolean): string {
  const input = value.trim();
  if (!input) return enabled ? "启用前请填写公网 HTTPS 域名。" : "";
  if (input.length > 512) return "公网域名不能超过 512 个字符。";
  let url: URL;
  try { url = new URL(input); } catch {
    return "请填写完整的 HTTPS 域名，例如 https://im-dev.example.com。";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || Boolean(url.username) || Boolean(url.password) || url.pathname !== "/" || Boolean(url.search) || Boolean(url.hash)
    || !host.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) {
    return "请填写完整的 HTTPS 域名，例如 https://im-dev.example.com，不要附加路径或参数。";
  }
  return "";
}

const readCopyDraftOf = (settings: ReadCopySettings): ReadCopyDraft => ({ version: settings.version, enabled: settings.enabled, publicOrigin: settings.publicOrigin ?? "" });
const errorStatus = (error: unknown): number | undefined => error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
function readCopyReadError(error: unknown): string {
  const status = errorStatus(error);
  if (status === 403) return "你没有查看同步设置的权限。";
  if (status === 404) return "同步服务尚未部署，请联系技术人员。";
  return friendlyError(error);
}

type Settings = { version: number; serviceMessage: string; complaintMessage: string; updatedAt: string | null };

function invalidReasonFor(text: string): string | null {
  if (!text.trim()) return "欢迎消息不能为空。";
  if (text.length > 1000) return "每条欢迎消息最多 1000 字。";
  if (new TextEncoder().encode(text).length > 3000) return "每条欢迎消息最多 3000 字节（UTF-8）。";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]|\$\{|\{\{|\}\}/.test(text)) return "暂不支持变量或控制字符；请直接输入纯文本。";
  return null;
}

function PreviewMessage({ text }: { text: string }) {
  return <>
    <Message align="start" className="im-assistant-preview-message">
      <MessageAvatar className="im-assistant-preview-avatar" aria-hidden="true"><img src="/art/zhouzhou/avatar.webp" alt="" /></MessageAvatar>
      <MessageContent>
        <MessageHeader className="im-assistant-preview-meta"><b>洲洲助手</b><span>平台自动消息</span><span>新轮次开场</span></MessageHeader>
        <Bubble variant="secondary"><BubbleContent className="im-assistant-bubble">{text}</BubbleContent></Bubble>
      </MessageContent>
    </Message>
  </>;
}

export function SupportAssistantSettings({ active, request, canConfigure, canConfigureIntegration = false, demo = false, onDirtyChange, onWriteLockChange }: { active: boolean; request: SupportManagementRequest; canConfigure: boolean; canConfigureIntegration?: boolean; demo?: boolean; onDirtyChange?: (dirty: boolean) => void; onWriteLockChange?: (locked: boolean) => void }) {
  const [group, setGroup] = useState<SceneGroup>("welcome");
  const [previewKey, setPreviewKey] = useState<FieldKey>("serviceMessage");
  const sectionRef = useRef<HTMLElement | null>(null);
  const flight = useRef(false);
  const [saved, setSaved] = useState<Settings | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0), operation = useRef(""), loaded = useRef(-1);
  const [readCopy, setReadCopy] = useState<ReadCopySettings | null>(null);
  const [readCopyDraft, setReadCopyDraft] = useState<ReadCopyDraft | null>(null);
  const [readCopyLoading, setReadCopyLoading] = useState(true);
  const [readCopyBusy, setReadCopyBusy] = useState(false);
  const [readCopyError, setReadCopyError] = useState("");
  const [readCopyNotice, setReadCopyNotice] = useState("");
  const [readCopyReload, setReadCopyReload] = useState(0);
  const [readCopyUnknown, setReadCopyUnknown] = useState(false);
  const [readCopyConflict, setReadCopyConflict] = useState(false);
  const [readCopyWriteDenied, setReadCopyWriteDenied] = useState(false);
  const [readCopyReadDenied, setReadCopyReadDenied] = useState(false);
  const [readCopyReadFailed, setReadCopyReadFailed] = useState(false);
  const [readCopyConfirmDiscard, setReadCopyConfirmDiscard] = useState(false);
  const [readCopyCopyNotice, setReadCopyCopyNotice] = useState("");
  const readCopyLoaded = useRef(-1);
  const readCopyFlight = useRef(false);
  const readCopyReadGeneration = useRef(0);
  const readCopyOperation = useRef("");
  const readCopyPending = useRef<ReadCopyPayload | null>(null);
  const readCopyCallbackInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!active || demo || loaded.current === reload) return;
    let current = true;
    setLoading(true); setError("");
    void request<Settings>("/im/support-settings").then((value) => {
      if (current) { setSaved(value); setDraft(value); operation.current = ""; loaded.current = reload; }
    }).catch((reason) => { if (current) setError(friendlyError(reason)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, request, reload, demo]);

  useEffect(() => {
    if (!active || demo || group !== "integration" || readCopyLoaded.current === readCopyReload) return;
    let current = true;
    const generation = ++readCopyReadGeneration.current;
    setReadCopyLoading(true); setReadCopyError("");
    setReadCopyReadDenied(false); setReadCopyReadFailed(false);
    void request<ReadCopySettings>("/im/read-copy-settings").then((value) => {
      if (!current || readCopyReadGeneration.current !== generation) return;
      setReadCopy(value); setReadCopyDraft(readCopyDraftOf(value));
      readCopyOperation.current = ""; readCopyPending.current = null;
      setReadCopyUnknown(false); setReadCopyConflict(false); setReadCopyWriteDenied(false);
      setReadCopyReadDenied(false); setReadCopyReadFailed(false); setReadCopyCopyNotice(""); readCopyLoaded.current = readCopyReload;
    }).catch((reason) => {
      if (!current || readCopyReadGeneration.current !== generation) return;
      const status = errorStatus(reason);
      if (status === 403 || status === 401 || status === 423) {
        // A denied read is terminal for the current projection; invalidate older reads and keep any unknown write intent.
        readCopyReadGeneration.current += 1;
        setReadCopyReadDenied(true); setReadCopyReadFailed(false);
        setReadCopy(null); setReadCopyDraft(null);
        setReadCopyNotice(""); setReadCopyCopyNotice(""); setReadCopyConfirmDiscard(false);
        setReadCopyError(status === 403
          ? "你没有查看同步设置的权限。"
          : friendlyError(reason));
        setReadCopyLoading(false);
        return;
      }
      setReadCopyError(readCopyReadError(reason)); setReadCopyReadFailed(true);
    }).finally(() => {
      if (current && readCopyReadGeneration.current === generation) setReadCopyLoading(false);
    });
    return () => { current = false; };
  }, [active, demo, group, request, readCopyReload]);

  const dirty = Boolean(saved && draft && (saved.serviceMessage !== draft.serviceMessage || saved.complaintMessage !== draft.complaintMessage));
  const readCopyDirty = Boolean(readCopy && readCopyDraft && (readCopy.enabled !== readCopyDraft.enabled || (readCopy.publicOrigin ?? "") !== readCopyDraft.publicOrigin.trim()));
  const readCopyOriginValidation = readCopyDraft ? readCopyOriginError(readCopyDraft.publicOrigin, readCopyDraft.enabled) : "";
  const readCopyReceiverBlocked = Boolean(readCopyDraft?.enabled && readCopy && !readCopy.receiverReady);
  const readCopyInvalid = Boolean(readCopyOriginValidation || readCopyReceiverBlocked);
  const readCopyFormDisabled = !canConfigureIntegration || readCopyLoading || readCopyBusy || readCopyUnknown || readCopyConflict || readCopyWriteDenied || readCopyReadDenied || readCopyReadFailed;
  const readCopyToggleDisabled = readCopyFormDisabled || Boolean(readCopy && !readCopy.receiverReady && !readCopyDraft?.enabled);
  const readCopyCanSave = canConfigureIntegration && !readCopyFormDisabled && !readCopyInvalid && readCopyDirty && !readCopyConfirmDiscard;
  const readCopyCanRetry = canConfigureIntegration && readCopyUnknown && !readCopyReadFailed && !readCopyReadDenied && !readCopyBusy && !readCopyLoading && !readCopyConflict && !readCopyConfirmDiscard;
  const readCopyWriteLocked = readCopyBusy || readCopyUnknown;
  const readCopyStatus = readCopy ? readCopyStatusInfo(readCopy) : null;
  const readCopyCallbackUrl = readCopy?.callbackUrl ?? "";
  const readCopyCallbackDirty = Boolean(readCopy && readCopyDraft && (readCopy.publicOrigin ?? "") !== readCopyDraft.publicOrigin.trim());
  const pageDirty = dirty || busy || readCopyDirty || readCopyBusy || readCopyUnknown || readCopyConflict;
  useEffect(() => { if (sectionRef.current) sectionRef.current.scrollTop = 0; }, [group]);
  useEffect(() => { onDirtyChange?.(pageDirty); }, [pageDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(readCopyWriteLocked); }, [readCopyWriteLocked, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);

  const invalidReason = draft ? WELCOME_FIELDS.map((scene) => invalidReasonFor(draft[scene.field])).find(Boolean) ?? "" : "";
  const invalid = Boolean(invalidReason);

  const edit = (key: FieldKey, value: string) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    operation.current = "";
    setNotice("");
  };

  const reloadSettings = () => {
    if (flight.current) return;
    setConfirmDiscard(false); setNotice(""); setError("");
    setReload((value) => value + 1);
  };

  const updateReadCopy = (patch: Partial<Pick<ReadCopyDraft, "enabled" | "publicOrigin">>) => {
    setReadCopyDraft((current) => current ? { ...current, ...patch } : current);
    readCopyOperation.current = ""; readCopyPending.current = null;
    setReadCopyNotice(""); setReadCopyCopyNotice("");
  };

  const reloadReadCopy = () => {
    if (readCopyFlight.current || readCopyBusy || readCopyLoading) return;
    setReadCopyConfirmDiscard(false); setReadCopyNotice(""); setReadCopyError(""); setReadCopyCopyNotice("");
    setReadCopyReload((value) => value + 1);
  };

  const requestReadCopyReload = () => {
    if (readCopyBusy || readCopyLoading) return;
    if (readCopyDirty || readCopyUnknown || readCopyConflict) { setReadCopyConfirmDiscard(true); return; }
    reloadReadCopy();
  };

  async function saveReadCopy() {
    if (!readCopyDraft || readCopyBusy || readCopyLoading || readCopyFlight.current || !canConfigureIntegration || readCopyConflict || readCopyReadDenied || readCopyReadFailed || readCopyWriteDenied || readCopyConfirmDiscard || readCopyInvalid) return;
    readCopyReadGeneration.current += 1;
    readCopyFlight.current = true;
    onWriteLockChange?.(true);
    const payload = readCopyUnknown && readCopyPending.current ? readCopyPending.current : {
      version: readCopyDraft.version,
      enabled: readCopyDraft.enabled,
      publicOrigin: readCopyDraft.publicOrigin.trim() || null,
      operationId: readCopyOperation.current ||= crypto.randomUUID().replaceAll("-", ""),
    };
    readCopyPending.current = payload;
    setReadCopyBusy(true); setReadCopyError(""); setReadCopyNotice("");
    try {
      const value = await request<ReadCopySettings>("/im/read-copy-settings", payload, "PUT");
      setReadCopy(value); setReadCopyDraft(readCopyDraftOf(value));
      readCopyOperation.current = ""; readCopyPending.current = null;
      setReadCopyUnknown(false); setReadCopyConflict(false); setReadCopyWriteDenied(false);
      setReadCopyReadDenied(false); setReadCopyReadFailed(false);
      setReadCopyNotice("同步设置已保存。");
    } catch (reason) {
      const status = errorStatus(reason);
      if (status === 409) {
        setReadCopyConflict(true);
        setReadCopyError("设置或服务状态已变化，请刷新后核对；草稿已保留。");
      } else if (status === 403) {
        setReadCopyWriteDenied(true);
        setReadCopyError("你没有修改阅读状态同步的权限。");
      } else if (status === 404) {
        setReadCopyReadFailed(true);
        setReadCopyError("同步服务尚未部署，设置未保存。");
      } else if (status === 400) {
        setReadCopyError("保存内容未通过服务端校验，请检查公网域名。");
      } else if (status === 0 || status === undefined || status >= 500) {
        setReadCopyUnknown(true);
        setReadCopyError("保存结果尚未确认，请重试保存或刷新核对。");
      } else {
        setReadCopyError(friendlyError(reason));
      }
    } finally {
      readCopyFlight.current = false; setReadCopyBusy(false);
    }
  }

  async function copyReadCopyCallback() {
    if (!readCopyCallbackUrl) return;
    try {
      await navigator.clipboard.writeText(readCopyCallbackUrl);
      setReadCopyCopyNotice("已复制回调地址。");
    } catch {
      readCopyCallbackInput.current?.focus(); readCopyCallbackInput.current?.select();
      setReadCopyCopyNotice("无法自动复制，请手动选择复制。");
    }
  }

  async function save() {
    if (!draft || busy || flight.current || !canConfigure || invalid) return;
    flight.current = true;
    operation.current ||= crypto.randomUUID().replaceAll("-", "");
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request<Settings>("/im/support-settings", { version: draft.version, serviceMessage: draft.serviceMessage, complaintMessage: draft.complaintMessage, operationId: operation.current }, "PUT");
      setSaved(value); setDraft(value);
      setNotice("已保存。仅对之后新建的咨询轮次生效，不会重发历史消息。");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      flight.current = false; setBusy(false);
    }
  }

  if (demo) return <section className="im-assistant-settings"><Card><CardHeader><CardTitle>洲洲助手设置</CardTitle><CardDescription>演示模式不修改全局自动消息。</CardDescription></CardHeader></Card></section>;

  const currentGroup = GROUPS.find((item) => item.id === group)!;
  const catalogScenes = SCENES.filter((scene) => scene.group === group);
  const previewText = draft?.[previewKey]?.trim() || "填写欢迎消息后，这里会显示发送效果。";

  return <section className="im-assistant-settings" aria-labelledby="assistant-settings-title" ref={sectionRef}>
    <div className="im-assistant-inner">
      <header className="im-assistant-head">
        <span className="im-assistant-avatar"><Bot aria-hidden="true" /></span>
        <div className="im-assistant-heading">
          <h2 id="assistant-settings-title">洲洲助手设置</h2>
        </div>
      </header>
      <div className="im-assistant-layout">
        <nav className="im-assistant-nav" aria-label="自动消息场景">
          {GROUPS.map((item) => <Button key={item.id} data-group={item.id} disabled={readCopyBusy} variant={group === item.id ? "secondary" : "ghost"} className="im-assistant-scene" aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>
            <item.icon aria-hidden="true" />
            <span><strong>{item.title}</strong><small>{item.hint}</small></span>
          </Button>)}
        </nav>
        <main className="im-assistant-main">
          {group === "welcome" && error ? <p role="alert" className="im-assistant-alert text-destructive">{error}</p> : null}
          {group === "welcome" && notice ? <p role="status" className="im-assistant-alert">{notice}</p> : null}

          {group === "welcome" ? <>
            <div className="im-assistant-welcome-grid">
              <Card className="im-assistant-editor">
                <CardHeader>
                  <div className="im-assistant-card-head">
                    <div><CardTitle>欢迎消息</CardTitle><CardDescription>新一轮咨询建群后发送。保存只影响后续新轮次，不重发历史消息。</CardDescription></div>
                  </div>
                </CardHeader>
                <CardContent className="im-assistant-fields">
                  {loading ? <div aria-label="正在加载助手设置"><Skeleton className="h-36 w-full" /></div> : draft ? WELCOME_FIELDS.map((scene) => <article key={scene.key} className="im-assistant-field">
                    <Field
                      label={<span className="im-assistant-field-label">{scene.label}<Badge variant="outline">可编辑</Badge></span>}
                      hint={`纯文本，1–1000 字；当前 ${draft[scene.field].length} / 1000 字。`}
                    >
                      <Textarea rows={3} maxLength={1000} value={draft[scene.field]} disabled={!canConfigure || busy} onFocus={() => setPreviewKey(scene.field)} onChange={(event) => edit(scene.field, event.target.value)} />
                    </Field>
                    <p className="im-assistant-field-meta"><span>触发：{scene.when}</span><span>发送身份：{scene.sender}</span></p>
                  </article>) : <Button variant="outline" onClick={reloadSettings}>重新加载设置</Button>}
                  {invalid ? <p role="alert" className="text-sm text-destructive">{invalidReason}</p> : null}
                </CardContent>
                <CardFooter className="im-assistant-savebar">
                  <div className="im-assistant-save-actions">
                    <Button disabled={!canConfigure || busy || !dirty || invalid} onClick={() => void save()}>{busy ? "正在保存…" : "保存欢迎消息"}</Button>
                    <Button variant="outline" disabled={busy || loading} onClick={() => dirty ? setConfirmDiscard(true) : reloadSettings()}>重新加载</Button>
                  </div>
                  <span className="im-assistant-save-note">{dirty ? "有未保存的修改" : saved?.updatedAt ? `已保存 · ${formatDateTime(saved.updatedAt)}` : "使用默认欢迎消息"}</span>
                </CardFooter>
              </Card>
                <Card className="im-assistant-preview">
                  <CardHeader>
                    <div className="im-assistant-card-head">
                      <CardTitle>消息预览</CardTitle>
                      <div className="im-assistant-preview-switch" role="group" aria-label="选择预览消息">
                        {WELCOME_FIELDS.map((scene) => <Button key={scene.key} size="sm" variant={previewKey === scene.field ? "secondary" : "ghost"} aria-pressed={previewKey === scene.field} onClick={() => setPreviewKey(scene.field)}>{scene.field === "serviceMessage" ? "普通咨询" : "投诉入口"}</Button>)}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent><PreviewMessage text={previewText} /></CardContent>
                </Card>
            </div>
            {!canConfigure ? <p className="im-assistant-help">当前可以查看；修改需要“配置洲洲助手”权限。</p> : null}
            {confirmDiscard ? <div className="im-assistant-discard" role="alert"><span>重新加载会放弃未保存的欢迎消息。</span><Button size="sm" variant="destructive" disabled={busy} onClick={reloadSettings}>确认放弃</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDiscard(false)}>取消</Button></div> : null}
          </> : group === "integration" ? <div className="im-assistant-integration">
            {readCopyError ? <p role="alert" className={`im-assistant-alert ${readCopyUnknown || readCopyConflict ? "" : "text-destructive"}`}>{readCopyError}</p> : null}
            {readCopyReadFailed && readCopy ? <p className="im-assistant-help">上次读取的设置，可能已变化；请刷新核对。</p> : null}
            {readCopyNotice ? <p role="status" className="im-assistant-alert">{readCopyNotice}</p> : null}
            {readCopyReadDenied ? <Card><CardHeader><CardTitle>无法查看同步设置</CardTitle></CardHeader><CardContent className="im-assistant-fields">
              {readCopyUnknown ? <p role="alert">此前保存结果尚未确认，恢复权限后请刷新核对。</p> : null}
              <div><Button variant="outline" disabled={readCopyLoading} onClick={reloadReadCopy}>{readCopyLoading ? "正在刷新…" : "刷新"}</Button></div>
            </CardContent></Card> : readCopyLoading && !readCopy ? <Card><CardContent className="im-assistant-loading"><Skeleton className="h-40 w-full" /><span>正在读取同步设置…</span></CardContent></Card> : readCopy ? <>
              <div className="im-assistant-integration-grid">
                <Card>
                  <CardHeader><CardTitle>阅读状态同步</CardTitle><CardDescription>将用户的阅读进度同步到客服会话。</CardDescription></CardHeader>
                  <CardContent className="im-assistant-fields">
                    <label className="im-assistant-check">
                      <Checkbox checked={readCopyDraft?.enabled ?? false} disabled={readCopyToggleDisabled} onCheckedChange={(checked) => updateReadCopy({ enabled: checked === true })} />
                      <span><b>开启阅读状态同步</b></span>
                    </label>
                    <Field label="服务域名" error={readCopyOriginValidation || undefined} hint="请向技术人员获取 HTTPS 域名；尚未部署时可保持关闭。">
                      <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={readCopyDraft?.publicOrigin ?? ""} disabled={readCopyFormDisabled} placeholder="https://im-dev.example.com" onChange={(event) => updateReadCopy({ publicOrigin: event.target.value })} />
                    </Field>
                    {readCopyReceiverBlocked ? <p role="alert" className="text-sm text-destructive">同步服务尚未部署，暂时无法开启。</p> : null}
                    <div className="im-assistant-field">
                      <label className="im-assistant-label" htmlFor="read-copy-callback">云信回调地址</label>
                      <div className="im-assistant-copy-row">
                        <Input ref={readCopyCallbackInput} id="read-copy-callback" readOnly value={readCopyCallbackUrl} placeholder="保存服务域名后生成" onClick={(event) => event.currentTarget.select()} />
                        <Button variant="outline" size="sm" disabled={!readCopyCallbackUrl || readCopyBusy} onClick={() => void copyReadCopyCallback()}><Copy aria-hidden="true" />复制</Button>
                      </div>
                      <p className="im-assistant-help">开启并保存后，将此地址填入云信后台。</p>
                      {readCopyCallbackDirty ? <p className="im-assistant-note">域名尚未保存，此处仍为原地址。</p> : null}
                      {readCopyCopyNotice ? <p role="status" className="im-assistant-note">{readCopyCopyNotice}</p> : null}
                    </div>
                    {!canConfigureIntegration ? <p className="im-assistant-help">你可以查看设置，修改需要“配置客服消息接入”权限。</p> : null}
                    {readCopyConfirmDiscard ? <div className="im-assistant-discard" role="alert"><span>刷新会放弃未保存的修改。</span><Button size="sm" variant="destructive" disabled={readCopyBusy || readCopyLoading} onClick={reloadReadCopy}>确认放弃</Button><Button size="sm" variant="outline" disabled={readCopyBusy} onClick={() => setReadCopyConfirmDiscard(false)}>取消</Button></div> : null}
                  </CardContent>
                  <CardFooter className="im-assistant-savebar">
                    <div className="im-assistant-save-actions">
                      {readCopyConflict ? <Button disabled={readCopyBusy || readCopyLoading} onClick={requestReadCopyReload}>刷新</Button> : <Button disabled={readCopyUnknown ? !readCopyCanRetry : !readCopyCanSave} onClick={() => void saveReadCopy()}>{readCopyBusy ? "正在保存…" : readCopyUnknown ? "重试保存" : "保存设置"}</Button>}
                      {readCopyConflict ? null : <Button variant="outline" disabled={readCopyBusy || readCopyLoading} onClick={requestReadCopyReload}>刷新</Button>}
                    </div>
                    <span className="im-assistant-save-note">{readCopyConflict ? "设置已变化，请刷新核对" : readCopyUnknown ? "保存结果待确认" : readCopyDirty ? "有未保存的修改" : readCopy.updatedAt ? `已保存 · ${formatDateTime(readCopy.updatedAt)}` : "尚未保存"}</span>
                  </CardFooter>
                </Card>
                <div className="im-assistant-side">
                  <Card>
                    <CardHeader><div className="im-assistant-card-head"><CardTitle>同步状态</CardTitle>{readCopyStatus ? <Badge variant={readCopyStatus.variant}>{readCopyStatus.label}</Badge> : null}</div></CardHeader>
                    <CardContent>
                      <p className="im-assistant-help">{readCopyStatus?.description}</p>
                      <dl className="im-assistant-facts">
                        <div><dt>最近地址验证</dt><dd>{readCopy.lastVerifiedAt ? formatDateTime(readCopy.lastVerifiedAt) : "尚无"}</dd></div>
                        <div><dt>最近阅读通知</dt><dd>{readCopy.lastEventAt ? formatDateTime(readCopy.lastEventAt) : "尚无"}</dd></div>
                      </dl>
                    </CardContent>
                  </Card>
                  <details className="im-assistant-integration-help">
                    <summary><Info size={15} aria-hidden="true" />配置说明</summary>
                    <ol className="im-assistant-steps">
                      <li>请技术人员部署云信通知接收服务，并提供公网 HTTPS 域名。</li>
                      <li>在本页填写服务域名，开启并保存后复制回调地址。</li>
                      <li>在云信开发 App → 消息抄送中填写地址，选择“会话已读回执”（85）。</li>
                    </ol>
                    <p className="im-assistant-note">收到地址验证，只说明云信曾访问过该地址；收到阅读通知，也不代表全部消息都已同步。</p>
                  </details>
                </div>
              </div>
            </> : <Card><CardHeader><CardTitle>无法读取同步设置</CardTitle><CardDescription>{readCopyError || "请稍后刷新重试。"}</CardDescription></CardHeader><CardContent className="im-assistant-fields">{readCopyUnknown ? <p role="alert">此前保存结果尚未确认，请刷新核对。</p> : null}<div><Button variant="outline" disabled={readCopyLoading} onClick={reloadReadCopy}>刷新</Button></div></CardContent></Card>}
          </div> : <Card>
            <CardHeader>
              <div className="im-assistant-card-head">
                <div><CardTitle>{currentGroup.title}</CardTitle><CardDescription>{currentGroup.description}</CardDescription></div>
                <Badge variant="outline">{scenarioCount(catalogScenes)} 种场景</Badge>
              </div>
            </CardHeader>
            <CardContent className="im-assistant-catalog">
              {catalogScenes.map((scene) => <article key={scene.key}>
                <div className="im-assistant-scene-head"><h3>{scene.label}</h3><Badge variant={STATUS[scene.status].variant}>{STATUS[scene.status].label}</Badge></div>
                {scene.buckets ? <ul className="im-assistant-buckets" aria-label="到期提醒档位">{scene.buckets.map((bucket) => <li key={bucket}>{bucket}</li>)}</ul> : null}
                <dl className="im-assistant-facts">
                  <div><dt>触发</dt><dd>{scene.when}</dd></div>
                  <div><dt>发送身份</dt><dd>{scene.sender}</dd></div>
                </dl>
                <small>{scene.note}</small>
              </article>)}
            </CardContent>
            <CardFooter><p className="im-assistant-help">{GROUP_FOOTER[group]}</p></CardFooter>
          </Card>}

        </main>
      </div>
    </div>
  </section>;
}
