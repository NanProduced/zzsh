import { useState, useEffect, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import { readTotpSecret } from "../api";
import { useAuthTypingImpulse } from "../components/devl/auth-shell";
import { bumpParticleTypingImpulse } from "../components/devl/particle-field";
import { SmoothTotpInput } from "../components/smoothui/animated-otp-input";

export type OnboardingStep = 1 | 2 | 3 | 4;

type OnboardingViewProps = {
  accountIdentifier: string;
  initialStep?: OnboardingStep;
  loading: boolean;
  error?: string;
  cachedPassword?: string;
  totpURI?: string;
  backupCodes: string[];
  onChangePassword: (current: string, next: string) => Promise<void>;
  onEnable2FA: (password: string) => Promise<void>;
  onVerify2FA: (code: string) => Promise<void>;
  onActivateEnrollment: () => Promise<void>;
  onComplete: () => void;
};

export function OnboardingView({
  accountIdentifier,
  initialStep = 1,
  loading,
  error,
  cachedPassword = "",
  totpURI,
  backupCodes,
  onChangePassword,
  onEnable2FA,
  onVerify2FA,
  onActivateEnrollment,
  onComplete,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const typingImpulse = useAuthTypingImpulse();

  // Step 1 states
  const [currentPassword, setCurrentPassword] = useState(cachedPassword);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Step 2 states
  const [totpCode, setTotpCode] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [manualKeyCopied, setManualKeyCopied] = useState(false);

  // Step 3 states
  const [backupSaved, setBackupSaved] = useState(false);
  const [codesCopied, setCodesCopied] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  useEffect(() => {
    if (initialStep > step) {
      setStep(initialStep);
    }
  }, [initialStep]);

  const handlePasswordSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!currentPassword || newPassword.length < 12 || newPassword !== confirmPassword) {
      return;
    }
    try {
      await onChangePassword(currentPassword, newPassword);
      setStep(2);
    } catch { /* Parent renders the API error; remain on this step. */ }
  };

  const handleVerify2FASubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (totpCode.length !== 6) return;
    try {
      await onVerify2FA(totpCode);
      setStep(3);
    } catch { /* Parent renders the API error; remain on this step. */ }
  };

  const handleActivateSubmit = async () => {
    if (!backupSaved) return;
    try {
      await onActivateEnrollment();
      setStep(4);
    } catch { /* Parent renders the API error; remain on this step. */ }
  };

  const copyManualKey = async (key: string) => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setManualKeyCopied(true);
      setTimeout(() => setManualKeyCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const copyAllBackupCodes = async () => {
    if (backupCodes.length === 0) return;
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCodesCopied(true);
      setTimeout(() => setCodesCopied(false), 2500);
    } catch {
      // ignore
    }
  };

  const downloadBackupCodesFile = () => {
    if (backupCodes.length === 0) return;
    const content = `洲洲商行管理平台 - 一次性备份码\n账号: ${accountIdentifier}\n生成时间: ${new Intl.DateTimeFormat(
      "zh-CN",
      { dateStyle: "long", timeStyle: "medium" }
    ).format(new Date())}\n\n注意：每枚备份码仅可单次使用，请保存在离线或安全密码管理器中。\n\n${backupCodes.join(
      "\n"
    )}\n`;

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zzsh-backup-codes-${accountIdentifier || "admin"}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setDownloadSuccess(true);
    setTimeout(() => setDownloadSuccess(false), 3000);
  };

  const setupKey = totpURI ? readTotpSecret(totpURI) : "";
  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const passwordTooShort = newPassword.length > 0 && newPassword.length < 12;

  return (
    <div
      className="w-full max-w-lg"
      onKeyDown={() => bumpParticleTypingImpulse(typingImpulse)}
    >
      <DevlStepper step={step} />

      {/* STEP 1: PASSWORD CHANGE */}
      {step === 1 && (
        <>
          <h1 className="mt-6 font-heading text-3xl font-bold leading-tight text-foreground">
            设置个人安全密码
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            首次登录系统必须修改初始凭证，密码长度至少需包含 12 位字符。
          </p>

          <form onSubmit={handlePasswordSubmit} className="mt-6 flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="current-pwd">
                初始临时密码
              </label>
              <PasswordInput
                id="current-pwd"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="输入初始临时密码"
                className="box-border h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 dark:bg-input/20"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="new-pwd">
                新个人密码（至少 12 位）
              </label>
              <PasswordInput
                id="new-pwd"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="建议组合大小写字母、数字与符号"
                className="box-border h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 dark:bg-input/20"
              />
              {passwordTooShort && (
                <span className="text-xs text-amber-500 font-medium">
                  密码长度不足 12 位（当前 {newPassword.length} 位）
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="confirm-pwd">
                确认新密码
              </label>
              <PasswordInput
                id="confirm-pwd"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                className="box-border h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 dark:bg-input/20"
              />
              {passwordMismatch && (
                <span className="text-xs text-destructive font-medium">两次输入的密码不一致</span>
              )}
            </div>

            <StatusMessage error={error} />

            <Button
              type="submit"
              loading={loading}
              disabled={
                !currentPassword ||
                newPassword.length < 12 ||
                newPassword !== confirmPassword
              }
              className="mt-2 h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm flex items-center justify-center gap-2"
            >
              <span>保存新密码并继续</span>
              <Icons.ArrowRight size={16} />
            </Button>
          </form>
        </>
      )}

      {/* STEP 2: TOTP 2FA BINDING */}
      {step === 2 && (
        <div>
          <h1 className="mt-6 font-heading text-3xl font-bold leading-tight text-foreground">
            扫码绑定双因素 (TOTP)
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            使用身份验证器扫描下方二维码。
          </p>

          {!totpURI && <form className="mt-4 space-y-3" onSubmit={(event) => {
            event.preventDefault();
            void onEnable2FA(cachedPassword || currentPassword).catch(() => undefined);
          }}>
            {!cachedPassword && <><label htmlFor="binding-password">当前登录密码</label>
              <PasswordInput id="binding-password" autoComplete="current-password" value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)} required /></>}
            <Button type="submit" loading={loading} disabled={!(cachedPassword || currentPassword)}>生成绑定二维码</Button>
          </form>}

          <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-border/70 bg-card/30 p-6">
            {totpURI ? (
              <div className="rounded-lg bg-white p-3 shadow-md ring-1 ring-black/5">
                <QRCodeSVG value={totpURI} size={176} level="M" />
              </div>
            ) : (
              <div className="flex h-44 w-44 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                请先生成绑定二维码
              </div>
            )}

            <div className="mt-4 w-full">
              <button
                type="button"
                onClick={() => setShowManualKey(!showManualKey)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto block"
              >
                {showManualKey ? "收起手动密钥" : "无法扫码？点击查看手动密钥"}
              </button>
              {showManualKey && setupKey && (
                <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-muted/40 p-2.5 text-xs font-mono">
                  <span className="truncate select-all text-foreground">{setupKey}</span>
                  <button
                    type="button"
                    onClick={() => copyManualKey(setupKey)}
                    className="ml-2 px-2 py-1 rounded bg-background border border-border text-[11px] hover:bg-accent text-foreground"
                  >
                    {manualKeyCopied ? "已复制" : "复制"}
                  </button>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={handleVerify2FASubmit} className="mt-6 flex flex-col gap-5" noValidate>
            <div className="flex flex-col items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="totp-verify-code">
                输入验证器显示的 6 位动态口令
              </label>
              <div className="relative py-2 flex justify-center w-full">
                <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center">
                  <div className="h-16 w-3/4 rounded-full bg-primary/10 blur-xl dark:bg-primary/15" />
                </div>
                <SmoothTotpInput
                  id="totp-verify-code"
                  autoFocus
                  value={totpCode}
                  onChange={(val) => setTotpCode(val)}
                />
              </div>
            </div>

            <StatusMessage error={error} />

            <Button
              type="submit"
              loading={loading}
              disabled={!totpURI || totpCode.length !== 6}
              className="mt-2 h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm flex items-center justify-center gap-2"
            >
              <span>核验口令并继续</span>
              <Icons.ArrowRight size={16} />
            </Button>
          </form>
        </div>
      )}

      {/* STEP 3: BACKUP CODES */}
      {step === 3 && (
        <>
          <h1 className="mt-6 font-heading text-3xl font-bold leading-tight text-foreground">
            离线妥善备份恢复码
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            以下 10 枚恢复码是您在丢失手机或验证器失效时的唯一自助登录凭据，每枚单次有效。
          </p>

          <div className="mt-6 rounded-xl border border-border bg-card/40 p-4">
            <div className="grid grid-cols-2 gap-2">
              {backupCodes.map((code, idx) => (
                <div
                  key={idx}
                  className="rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 text-center font-mono text-xs font-medium text-foreground tracking-wider"
                >
                  <span className="text-muted-foreground/50 mr-1.5 select-none">{idx + 1}.</span>
                  {code}
                </div>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={copyAllBackupCodes}
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground shadow-xs transition hover:bg-accent"
              >
                <Icons.Copy size={13} />
                <span>{codesCopied ? "已复制全部" : "复制全部 10 枚"}</span>
              </button>
              <button
                type="button"
                onClick={downloadBackupCodesFile}
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-medium text-foreground shadow-xs transition hover:bg-accent"
              >
                <Icons.Download size={13} />
                <span>{downloadSuccess ? "已下载文件" : "下载备份码 TXT"}</span>
              </button>
            </div>
          </div>

          <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-500">
            <Icons.AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <strong>重要提醒</strong>
              <p className="mt-0.5 text-amber-500/80">
                备份码将不可再次查看，请确保安全存储。
              </p>
            </div>
          </div>

          <label className="mt-5 flex items-center gap-2.5 text-xs text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={backupSaved}
              onChange={(e) => setBackupSaved(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
            />
            <span>我已完整保存上述 10 枚紧急恢复码，并知晓其重要性</span>
          </label>

          <StatusMessage error={error} />

          <Button
            type="button"
            loading={loading}
            disabled={!backupSaved}
            onClick={handleActivateSubmit}
            className="mt-4 h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm flex items-center justify-center gap-2"
          >
            <span>激活账号并完成初始化</span>
            <Icons.CheckCircle2 size={16} />
          </Button>
        </>
      )}

      {/* STEP 4: ALL SET */}
      {step === 4 && (
        <div>
          <h1 className="mt-6 font-heading text-3xl font-bold leading-tight text-foreground">
            账号初始化配置完成
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            您已成功建立安全基线，个人密码、双因素验证器及离线备份码均已生效。
          </p>

          <div className="mt-8 rounded-xl border border-border/70 bg-card/30 divide-y divide-border/40 p-1">
            <div className="flex items-center justify-between px-3.5 py-3 text-xs">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                管理员账号
              </span>
              <span className="font-semibold text-foreground font-mono text-xs select-all text-right break-all ml-4">
                {accountIdentifier || "ADMIN"}
              </span>
            </div>
            <div className="flex items-center justify-between px-3.5 py-3 text-xs">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                双因素认证
              </span>
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                TOTP 动态口令
              </span>
            </div>
            <div className="flex items-center justify-between px-3.5 py-3 text-xs">
              <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                安全基线
              </span>
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-400">
                <Icons.CheckCircle2 size={13} />
                合规生效 (Grade A)
              </span>
            </div>
          </div>

          <div className="mt-6 rounded-lg border border-border/70 bg-card/30 p-4 text-xs text-muted-foreground space-y-1.5">
            <div className="flex items-center gap-2 text-foreground font-medium">
              <Icons.ShieldCheck size={14} className="text-emerald-500" />
              <span>权限门禁保护已启动</span>
            </div>
            <p>后续登录将要求输入您的个人密码与验证器 6 位动态口令。</p>
          </div>

          <Button
            type="button"
            onClick={onComplete}
            className="mt-8 h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm"
          >
            进入安全运营工作台
          </Button>
        </div>
      )}
    </div>
  );
}

function DevlStepper({ step, total = 4 }: { step: number; total?: number }) {
  const steps = ["修改密码", "绑定2FA", "备份凭证", "初始化完成"];
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.3em]">
      <span>
        STEP {String(step).padStart(2, "0")} / {String(total).padStart(2, "0")} · {steps[step - 1]}
      </span>
      <div className="ml-2 flex items-center gap-1.5">
        {steps.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${
              i + 1 === step
                ? "w-5 bg-foreground"
                : i + 1 < step
                  ? "w-1.5 bg-foreground/70"
                  : "w-1.5 bg-foreground/20"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
