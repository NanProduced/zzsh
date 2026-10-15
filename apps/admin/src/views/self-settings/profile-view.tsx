import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { CheckIcon, CopyIcon, LoaderIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import {
  classifyReadFailure,
  ContractViolation,
  displayNameIssue,
  parseProfilePayload,
  parseProfileUpdatePayload,
  profileDraftChanged,
  readBackProfile,
  beijingDateTime,
  DISPLAY_NAME_MAX_CODE_POINTS,
  NOT_PROVIDED_TEXT,
  type ProfileFacts,
  type ReadBackConclusion,
  type ReadFailure,
} from "./model";
import { SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow } from "./settings-shell";

export type ProfileViewProps = {
  /** 资料读写都绑定到这一身份；切换时清理草稿与旧响应。 */
  adminUserId: string;
  sessionId: string;
  accountStatus: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
  locked: boolean;
  /** 注入原始响应，由本包做合同校验与身份核对。 */
  load: () => Promise<unknown>;
  /** 缺少该回调即表示本人资料写合同未接入：界面给出原因并禁用，不放一个必然失败的按钮。 */
  saveDisplayName?: (input: { displayName: string }) => Promise<unknown>;
  writeDisabledReason?: string;
  /** 既有会话快照刷新回调；合同 §1.2 说明 admin realm 无缓存，刷新即可看到新名称。 */
  onSessionRefresh?: () => Promise<unknown> | unknown;
  onDirtyChange?: (dirty: boolean) => void;
};

type SaveState =
  | { phase: "idle" }
  | { phase: "submitting"; value: string }
  | { phase: "saved"; value: string }
  | { phase: "rejected"; value: string; message: string }
  | { phase: "unknown"; value: string; updatedAtBefore: string | null; message: string };

type ReadBack =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; conclusion: ReadBackConclusion }
  | { phase: "failed"; text: string };

const readBackTones = { indistinguishable: "warning", mismatched: "warning" } as const;

export function ProfileView({
  adminUserId,
  sessionId,
  accountStatus,
  locked,
  load,
  saveDisplayName,
  writeDisabledReason,
  onSessionRefresh,
  onDirtyChange,
}: ProfileViewProps) {
  const identityKey = `${adminUserId}|${sessionId}|${accountStatus}|${locked ? "locked" : "unlocked"}`;
  const identityKeyRef = useRef(identityKey);
  const epochRef = useRef(0);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  const draftTouchedRef = useRef(false);
  const [facts, setFacts] = useState<ProfileFacts | null>(null);
  const [draft, setDraft] = useState("");
  const [loadFailure, setLoadFailure] = useState<ReadFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const [readBack, setReadBack] = useState<ReadBack>({ phase: "idle" });
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const isCurrent = (epoch: number, seq: number) => mountedRef.current && epochRef.current === epoch && seqRef.current === seq;

  useLayoutEffect(() => {
    if (identityKeyRef.current === identityKey) return;
    identityKeyRef.current = identityKey;
    epochRef.current += 1;
    // 切身份/锁定/冻结：立即丢弃上一身份的资料投影与草稿，旧响应不得落到新上下文。
    draftTouchedRef.current = false;
    setFacts(null);
    setDraft("");
    setLoadFailure(null);
    setSaveState({ phase: "idle" });
    setReadBack({ phase: "idle" });
    setRefreshFailure(null);
    setCopyNotice(null);
  }, [identityKey]);

  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const read = useCallback(
    async (options?: { silent?: boolean }) => {
      const epoch = epochRef.current;
      const seq = ++seqRef.current;
      if (!options?.silent) setLoading(true);
      if (locked || accountStatus !== "ACTIVE") {
        setFacts(null);
        setDraft("");
        setLoading(false);
        return null;
      }
      try {
        const parsed = parseProfilePayload(await load());
        if (!isCurrent(epoch, seq)) return null;
        if (parsed.adminUserId !== adminUserId) {
          // 响应身份与当前会话不一致：属于合同/装配异常，不能把它当本人资料展示。
          setLoadFailure({ kind: "contract", message: "返回的资料不属于当前管理员，已停止显示；请联系维护人员核对装配。" });
          setFacts(null);
          setDraft("");
          return null;
        }
        setFacts(parsed);
        // 用户没动过草稿时一律跟随服务端事实；动过才保留草稿。
        if (!draftTouchedRef.current) setDraft(parsed.displayName);
        setLoadFailure(null);
        return parsed;
      } catch (error) {
        if (!isCurrent(epoch, seq)) return null;
        const failure = classifyReadFailure(error, "本人资料读取未完成");
        setLoadFailure(failure);
        if (["unauthorized", "forbidden", "locked"].includes(failure.kind)) {
          setFacts(null);
          setDraft("");
          draftTouchedRef.current = false;
        }
        return null;
      } finally {
        if (isCurrent(epoch, seq)) setLoading(false);
      }
    },
    [adminUserId, identityKey, load],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const changed = profileDraftChanged(draft, facts);
  const dirty = changed || saveState.phase === "submitting" || saveState.phase === "unknown";
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const validationIssue = changed || draft.length > 0 ? displayNameIssue(draft) : null;
  const writeUnavailable = !saveDisplayName;
  const canSubmit =
    Boolean(facts) && changed && !validationIssue && !loading && !loadFailure && saveState.phase !== "submitting" && saveState.phase !== "unknown" && !writeUnavailable && !writeDisabledReason && accountStatus === "ACTIVE" && !locked;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !saveDisplayName) return;
    const value = draft.trim();
    const epoch = epochRef.current;
    const seq = ++seqRef.current;
    const updatedAtBefore = facts?.updatedAt ?? null;
    setSaveState({ phase: "submitting", value });
    setReadBack({ phase: "idle" });
    setRefreshFailure(null);
    try {
      const saved = parseProfileUpdatePayload(await saveDisplayName({ displayName: value }));
      if (!isCurrent(epoch, seq)) return;
      if (saved.adminUserId !== adminUserId || saved.displayName !== value) {
        throw new ContractViolation("保存响应与当前身份或提交名称不一致");
      }
      setSaveState({ phase: "saved", value });
      // 保存成功后草稿与服务端一致，重读时以权威事实覆盖。
      draftTouchedRef.current = false;
      // 保存结果与显示刷新分开：快照刷新失败只说明顶栏未更新，不反推资料未保存。
      try {
        await onSessionRefresh?.();
      } catch {
        if (isCurrent(epoch, seq)) setRefreshFailure("资料已保存，但顶部当前用户显示刷新失败；重新进入本页或刷新页面后可见。");
      }
      if (isCurrent(epoch, seq)) await read({ silent: true });
    } catch (error) {
      if (!isCurrent(epoch, seq)) return;
      const failure = classifyReadFailure(error, "资料保存未完成");
      if (["unauthorized", "forbidden", "locked"].includes(failure.kind)) {
        setFacts(null);
        setDraft("");
        setLoadFailure(failure);
      }
      // 网络中断与 5xx 都不能证明未生效：进入未知态，只做读回核对，不自动重发。
      if (failure.kind === "network" || failure.kind === "server" || failure.kind === "contract") {
        setSaveState({ phase: "unknown", value, updatedAtBefore, message: failure.message });
        return;
      }
      setSaveState({ phase: "rejected", value, message: failure.message });
    }
  };

  const cancel = () => {
    if (saveState.phase === "submitting") return;
    draftTouchedRef.current = false;
    setDraft(facts?.displayName ?? "");
    if (saveState.phase !== "unknown") setSaveState({ phase: "idle" });
  };

  const checkReadBack = async () => {
    if (saveState.phase !== "unknown") return;
    const epoch = epochRef.current;
    const seq = ++seqRef.current;
    const submitted = { displayName: saveState.value, updatedAtBefore: saveState.updatedAtBefore };
    setReadBack({ phase: "checking" });
    try {
      const parsed = parseProfilePayload(await load());
      if (!isCurrent(epoch, seq)) return;
      if (parsed.adminUserId !== adminUserId) {
        setReadBack({ phase: "failed", text: "读回的资料不属于当前管理员，未据此得出任何结论；未决状态仍保留。" });
        return;
      }
      setFacts(parsed);
      setReadBack({ phase: "done", conclusion: readBackProfile(parsed, submitted) });
    } catch (error) {
      if (!isCurrent(epoch, seq)) return;
      const failure = classifyReadFailure(error, "读取未完成");
      if (["unauthorized", "forbidden", "locked"].includes(failure.kind)) {
        setFacts(null);
        setDraft("");
        setLoadFailure(failure);
      }
      setReadBack({ phase: "failed", text: `读取当前资料失败：${failure.message} 未决状态仍保留。` });
    }
  };

  const copyZzNumber = async () => {
    if (!facts?.zzNumber) return;
    try {
      await navigator.clipboard.writeText(facts.zzNumber);
      setCopyNotice("已复制。");
    } catch {
      setCopyNotice("此浏览器不允许自动复制，请手动选中后复制。");
    }
  };

  const initial = (facts?.displayName ?? facts?.zzNumber ?? "").trim().slice(0, 1) || "?";
  const frozen = accountStatus === "FROZEN";

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6 lg:p-8">
      <SettingsPageHeader
        eyebrow="设置 · 个人资料"
        title="个人资料"
        description="本人在管理平台各处显示的名称。登录编号由平台分配，只读且不可自行修改。"
      />
      {locked || accountStatus !== "ACTIVE" ? (
        <SettingsNotice tone="warning">{locked ? "当前会话已锁定，解锁后可查看个人资料。" : accountStatus === "FROZEN" ? "账号已冻结，个人资料暂不可用。" : "请先完成身份验证后查看个人资料。"}</SettingsNotice>
      ) : null}

      {loadFailure ? (
        <SettingsNotice
          tone="danger"
          role="alert"
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => void read()} disabled={loading}>
              重新读取
            </Button>
          }
        >
          {loadFailure.message}
          {loadFailure.requestId ? <span className="mt-1 block break-all font-mono text-[11px]">请求编号 {loadFailure.requestId}</span> : null}
        </SettingsNotice>
      ) : null}

      {loading && !facts ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : null}

      {facts ? (
        <>
          {frozen ? (
            <SettingsNotice tone="danger" role="alert">
              账号已冻结：资料修改当前不可用。读取仍按本人范围进行。
            </SettingsNotice>
          ) : null}
          {writeUnavailable ? (
            <SettingsNotice tone="warning">
              {writeDisabledReason ?? "资料修改暂未开放，当前仅支持查看。"}
            </SettingsNotice>
          ) : null}
          {saveState.phase === "unknown" ? (
            <SettingsNotice
              tone="warning"
              role="alert"
              action={
                <Button type="button" size="sm" variant="secondary" onClick={() => void checkReadBack()} disabled={readBack.phase === "checking"}>
                  {readBack.phase === "checking" ? "核对中…" : "核对当前资料"}
                </Button>
              }
            >
              提交后未收到明确结果，无法判断是否已生效。请勿连续重复提交，可用「核对当前资料」读取服务端当前事实。
            </SettingsNotice>
          ) : null}
          {readBack.phase === "done" ? (
            <SettingsNotice tone={readBackTones[readBack.conclusion.kind]} role="status" action={
              <Button type="button" size="sm" variant="secondary" onClick={() => {
                draftTouchedRef.current = false;
                setDraft(facts.displayName);
                setSaveState({ phase: "idle" });
                setReadBack({ phase: "idle" });
              }}>按当前资料重新编辑</Button>
            }>
              {readBack.conclusion.text}
            </SettingsNotice>
          ) : null}
          {readBack.phase === "failed" ? (
            <SettingsNotice tone="danger" role="alert">
              {readBack.text}
            </SettingsNotice>
          ) : null}
          {saveState.phase === "saved" ? <SettingsNotice tone="success">显示名称已保存。</SettingsNotice> : null}
          {saveState.phase === "rejected" ? (
            <SettingsNotice tone="danger" role="alert">
              保存被拒绝：{saveState.message} 你的输入仍保留，可直接修正后重试。
            </SettingsNotice>
          ) : null}
          {refreshFailure ? <SettingsNotice tone="warning">{refreshFailure}</SettingsNotice> : null}

          <SettingsGroup title="身份标识" description="由平台分配与维护，本页只读。">
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
              <Avatar className="size-14">
                {facts.avatarUrl ? <AvatarImage src={facts.avatarUrl} alt="" /> : null}
                <AvatarFallback>{initial}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground break-words [overflow-wrap:anywhere]">{facts.displayName}</div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {facts.avatarUrl ? "头像来自服务端已返回的资料；本页不修改头像。" : "未返回头像，按姓名首字显示。"}
                </p>
              </div>
            </div>
            <SettingsRow
              title="ZZ 登录编号"
              description="用于工单与线下核对的稳定编号；不是内部标识，也不随登录邮箱变化。"
              action={
                <div className="flex items-center gap-2">
                  <code className="max-w-[16rem] truncate rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-foreground">
                    {facts.zzNumber ?? NOT_PROVIDED_TEXT}
                  </code>
                  {facts.zzNumber ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => void copyZzNumber()}>
                      <CopyIcon />
                      <span>复制</span>
                    </Button>
                  ) : null}
                </div>
              }
            />
            {copyNotice ? (
              <div className="px-4 pb-3">
                <p className="text-muted-foreground text-xs">{copyNotice}</p>
              </div>
            ) : null}
            <SettingsRow
              title="资料最后变更时间"
              description={`${beijingDateTime(facts.updatedAt)}（北京时间）。这是当前资料的变更时间，不能据此证明某次请求是否执行。`}
            />
            <SettingsRow
              title="账号状态"
              status={{
                label: frozen ? "已冻结" : accountStatus === "PENDING_ENROLLMENT" ? "待完成绑定" : "正常",
                tone: frozen ? "error" : accountStatus === "PENDING_ENROLLMENT" ? "warning" : "success",
              }}
              description="冻结与授权由服务端判定；本页不修改账号状态。"
            />
          </SettingsGroup>

          <SettingsGroup title="可维护资料" description="同事在列表、审批与客服上下文中看到的名称。">
            <form className="space-y-4 p-4" onSubmit={(event) => void submit(event)} noValidate>
              <Field
                label="显示名称"
                hint={`最多 ${DISPLAY_NAME_MAX_CODE_POINTS} 个字符（按 Unicode 码点计），不能包含控制字符；服务端按同一规则校验并以其为准。`}
                error={validationIssue ?? undefined}
              >
                <Input
                  value={draft}
                  onChange={(event) => {
                    draftTouchedRef.current = true;
                    setDraft(event.target.value);
                  }}
                  autoComplete="off"
                  disabled={!facts || (writeUnavailable && !writeDisabledReason) || locked || accountStatus !== "ACTIVE" || saveState.phase === "submitting" || saveState.phase === "unknown"}
                  aria-busy={saveState.phase === "submitting"}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={!canSubmit}>
                  {saveState.phase === "submitting" ? <LoaderIcon /> : <CheckIcon />}
                  <span>{saveState.phase === "submitting" ? "保存中…" : "保存显示名称"}</span>
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={!dirty || saveState.phase === "submitting"}>
                  <RotateCcwIcon />
                  <span>放弃修改</span>
                </Button>
                {!changed && saveState.phase === "idle" ? <span className="text-muted-foreground text-xs">没有改动，无需保存。</span> : null}
              </div>
            </form>
          </SettingsGroup>
        </>
      ) : null}
    </div>
  );
}
