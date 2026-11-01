"use client";

import { useId, useState } from "react";
import { CircleAlert, X } from "lucide-react";
import "./support-round-rating.css";

export type RoundRatingResolution = "submitted" | "dismissed";

/**
 * 409 表示本轮已有评价结果（超时重试或他端先提交），服务端可能已经成功。
 * 优先读响应体的 rating 事实，其次读冲突文案；无法证明结果时返回 null，保留原有失败提示。
 */
async function conflictResolution(response: Response): Promise<RoundRatingResolution | null> {
  if (response.status !== 409) return null;
  try {
    const value = await response.json() as { rating?: { submitted?: unknown; dismissed?: unknown }; error?: { message?: unknown } } | null;
    if (value?.rating?.submitted === true) return "submitted";
    if (value?.rating?.dismissed === true) return "dismissed";
    const message = typeof value?.error?.message === "string" ? value.error.message : "";
    if (message.includes("已评价")) return "submitted";
    if (message.includes("已关闭")) return "dismissed";
  } catch {
    // 响应体不可解析时按结果未知处理。
  }
  return null;
}

const RATING_LEVELS = [
  { score: 1, emoji: "😡", label: "很不满" },
  { score: 2, emoji: "🙁", label: "不满意" },
  { score: 3, emoji: "😐", label: "一般" },
  { score: 4, emoji: "🙂", label: "满意" },
  { score: 5, emoji: "😄", label: "很满意" },
] as const;

/**
 * 本轮评价卡：内嵌在消息流里的极简卡，点表情即提交，X 表示不评价。
 * 失败只做行内提示并保留刚才的选择，方便直接重试。
 */
export function SupportRoundRating({ roundId, onResolved }: { roundId: string; onResolved: (resolution: RoundRatingResolution) => void }) {
  const titleId = useId();
  const [score, setScore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const post = (suffix: string, body?: unknown) => fetch(
    `/api/im/consultations/${encodeURIComponent(roundId)}/rating${suffix}`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    },
  );

  const submit = async (nextScore: number) => {
    if (busy) return;
    setScore(nextScore);
    setBusy(true);
    setError(undefined);
    try {
      const response = await post("", { score: nextScore });
      const resolution = response.ok ? "submitted" : await conflictResolution(response);
      if (!resolution) throw new Error("rating rejected");
      setBusy(false);
      onResolved(resolution);
    } catch {
      setBusy(false);
      setError("评价提交失败，请稍后重试。");
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await post("/dismiss");
      const resolution = response.ok ? "dismissed" : await conflictResolution(response);
      if (!resolution) throw new Error("dismiss rejected");
      setBusy(false);
      onResolved(resolution);
    } catch {
      setBusy(false);
      setError("暂时无法跳过评价，请稍后重试。");
    }
  };

  return <section className="support-rating-card" aria-labelledby={titleId} aria-busy={busy}>
    <button type="button" className="support-rating-close" aria-label="不评价" title="不评价" disabled={busy} onClick={() => void dismiss()}><span className="support-rating-skip-text">跳过</span><X size={13} aria-hidden="true" /></button>
    <strong id={titleId} className="support-rating-title">您对本次服务满意吗？</strong>
    <div className="support-rating-options" role="group" aria-label="服务满意度">
      {RATING_LEVELS.map((level) => <button
        key={level.score}
        type="button"
        aria-pressed={score === level.score}
        aria-label={level.label}
        className="support-rating-option"
        data-active={score === level.score}
        disabled={busy}
        onClick={() => void submit(level.score)}
      >
        <span aria-hidden="true">{level.emoji}</span>
        <span>{level.label}</span>
      </button>)}
    </div>
    {error ? <p className="support-rating-error" role="alert"><CircleAlert size={13} aria-hidden="true" />{error}</p> : null}
  </section>;
}
