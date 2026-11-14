import { friendlyError } from "../api";

export type ReadCopyStatus = "RECEIVER_UNAVAILABLE" | "DISABLED" | "WAITING_FOR_CALLBACK" | "CALLBACK_OBSERVED";
export type ReadCopySettings = {
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
export type ReadCopyDraft = { version: number; enabled: boolean; publicOrigin: string };
export type ReadCopyPayload = { version: number; enabled: boolean; publicOrigin: string | null; operationId: string };
export type ReadCopyStatusInfo = {
  label: string;
  variant: "secondary" | "info" | "warning" | "unknown";
  title: string;
  description: string;
  inconsistent?: boolean;
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

export function readCopyStatusInfo(settings: ReadCopySettings): ReadCopyStatusInfo {
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

export function readCopyOriginError(value: string, enabled: boolean): string {
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

export const readCopyDraftOf = (settings: ReadCopySettings): ReadCopyDraft => ({ version: settings.version, enabled: settings.enabled, publicOrigin: settings.publicOrigin ?? "" });
export const errorStatus = (error: unknown): number | undefined => error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
export function readCopyReadError(error: unknown): string {
  const status = errorStatus(error);
  if (status === 403) return "你没有查看同步设置的权限。";
  if (status === 404) return "同步服务尚未部署，请联系技术人员。";
  return friendlyError(error);
}
