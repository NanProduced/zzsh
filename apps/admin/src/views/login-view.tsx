import { useState, type FormEvent } from "react";
import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuthTypingImpulse } from "../components/devl/auth-shell";
import { bumpParticleTypingImpulse } from "../components/devl/particle-field";
import { AltchaField } from "../components/altcha-field";

type LoginViewProps = {
  identifier: string;
  loading: boolean;
  error?: string;
  onIdentifier: (value: string) => void;
  onSubmit: (identifier: string, password: string, altcha?: string) => void;
  captchaRequired?: boolean;
  captchaRound?: number;
  onRecovery: () => void;
};

export function LoginView({
  identifier,
  loading,
  error,
  onIdentifier,
  onSubmit,
  onRecovery,
  captchaRequired = false,
  captchaRound = 0,
}: LoginViewProps) {
  const [altcha, setAltcha] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const typingImpulse = useAuthTypingImpulse();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (identifier.trim() && password && (!captchaRequired || altcha)) {
      const payload = captchaRequired ? altcha : undefined;
      setAltcha(undefined);
      onSubmit(identifier.trim(), password, payload);
    }
  };

  return (

    <div
      className="w-full max-w-lg"
      onKeyDown={() => bumpParticleTypingImpulse(typingImpulse)}
    >
      <div className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.3em]">
        ZHOUZHOU CONSOLE · RESTRICTED
      </div>
      <h1 className="mt-2 font-heading text-3xl font-bold leading-tight text-foreground">
        管理员登录
      </h1>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="admin-identifier"
            className="text-sm font-medium text-foreground"
          >
            管理员账号
          </label>
          <input
            id="admin-identifier"
            type="text"
            autoFocus
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => onIdentifier(e.target.value)}
            placeholder="请输入管理员账号"
            className="box-border h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 dark:bg-input/20"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="admin-password"
              className="text-sm font-medium text-foreground"
            >
              登录密码
            </label>
          </div>
          <PasswordInput
            id="admin-password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入登录密码"
            className="box-border h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 dark:bg-input/20"
          />
        </div>

        <div className="flex items-center justify-between pt-0.5">
          <label
            htmlFor="remember-account"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer hover:text-foreground transition-colors"
          >
            <Checkbox
              id="remember-account"
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <span>记住账号</span>
          </label>
          <span className="font-mono text-[11px] text-muted-foreground/70 bg-muted/40 px-2 py-0.5 rounded border border-border/40">
            公共设备请勿勾选
          </span>
        </div>

        {captchaRequired ? <AltchaField key={captchaRound} onPayload={setAltcha} hint="多次登录失败，请先完成人机验证。" /> : null}

        <StatusMessage error={error} />

        <Button
          type="submit"
          loading={loading}
          disabled={!identifier.trim() || !password || (captchaRequired && !altcha)}
          className="mt-2 h-10 w-full rounded-lg bg-primary font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 text-sm flex items-center justify-center gap-2"
        >
          <span>登录并验证身份</span>
          <Icons.ArrowRight size={16} />
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.3em]">
          or
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onRecovery}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-input bg-card/60 px-4 text-sm font-medium text-foreground shadow-xs transition hover:bg-accent/50 dark:bg-input/20"
        >
          <Icons.Key size={15} />
          <span>无法登录？申请账号恢复</span>
        </button>
      </div>
    </div>

  );
}
