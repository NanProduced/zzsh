import { useState, type FormEvent } from "react";
import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import { useAuthTypingImpulse } from "../components/devl/auth-shell";
import { bumpParticleTypingImpulse } from "../components/devl/particle-field";
import {
  SmoothTotpInput,
  SmoothBackupCodeInput,
} from "../components/smoothui/animated-otp-input";

type ChallengeViewProps = {
  loading: boolean;
  error?: string;
  onSubmit: (method: "totp" | "backup", code: string) => void;
  onBack: () => void;
  onRecovery: () => void;
};

export function ChallengeView({
  loading,
  error,
  onSubmit,
  onBack,
  onRecovery,
}: ChallengeViewProps) {
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const typingImpulse = useAuthTypingImpulse();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.trim()) {
      onSubmit(method, code.trim());
    }
  };

  const isCodeComplete =
    method === "totp"
      ? code.length === 6
      : code.replace(/[^a-zA-Z0-9]/g, "").length === 10;

  return (
    <div
      className="w-full max-w-lg"
      onKeyDown={() => bumpParticleTypingImpulse(typingImpulse)}
    >
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4 focus-visible:outline-none"
      >
        <Icons.ArrowLeft size={14} />
        <span>返回修改账号</span>
      </button>

      <h1 className="mt-2 font-heading text-3xl font-bold leading-tight text-foreground">
        安全验证
      </h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {method === "totp"
          ? "打开身份验证器 App（如 2FAS 或微软验证器），输入当前 6 位动态口令。"
          : "输入初始化时离线保存的 10 位应急备份码（例如 AWtNQ-x8Fl8）。"}
      </p>

      <div className="mt-6 flex p-1 rounded-lg bg-muted/60 border border-border" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={method === "totp"}
          onClick={() => {
            setMethod("totp");
            setCode("");
          }}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
            method === "totp"
              ? "bg-background text-foreground shadow-xs font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          身份验证器 (TOTP)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "backup"}
          onClick={() => {
            setMethod("backup");
            setCode("");
          }}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
            method === "backup"
              ? "bg-background text-foreground shadow-xs font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          应急备份码
        </button>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6" noValidate>
        <div className="flex flex-col items-center gap-3">
          <label
            htmlFor={method === "totp" ? "challenge-totp" : "challenge-backup"}
            className="text-xs font-medium text-muted-foreground"
          >
            {method === "totp"
              ? "6 位动态验证码"
              : "10 位备份码（支持自动解析连字符）"}
          </label>

          <div className="w-full flex justify-center py-2">
            {method === "totp" ? (
              <SmoothTotpInput
                key="totp-input"
                id="challenge-totp"
                value={code}
                onChange={(val) => setCode(val)}
                autoFocus
              />
            ) : (
              <SmoothBackupCodeInput
                key="backup-input"
                id="challenge-backup"
                value={code}
                onChange={(val) => setCode(val)}
                autoFocus
              />
            )}
          </div>
        </div>

        <StatusMessage error={error} />

        <Button
          type="submit"
          loading={loading}
          disabled={!isCodeComplete}
          className="h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm flex items-center justify-center gap-2"
        >
          <span>完成验证并进入</span>
          <Icons.ArrowRight size={16} />
        </Button>
      </form>

      <div className="mt-8 pt-4 border-t border-border/60 flex flex-col items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={onRecovery}
          className="text-foreground/90 hover:text-foreground underline underline-offset-4 transition-colors"
        >
          验证器与备份码均丢失？进入账号恢复
        </button>
        <span className="text-[11px] text-muted-foreground/70">
          恢复请求需另一名同级管理员在工作台确认协助
        </span>
      </div>
    </div>
  );
}
