import { useState, useEffect, useRef, type FormEvent } from "react";
import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";

type LockScreenProps = {
  mobile: boolean;
  loading: boolean;
  error?: string;
  onUnlock: (body: Record<string, unknown>) => void;
  onSignOut: () => void;
};

export function LockScreen({
  mobile,
  loading,
  error,
  onUnlock,
  onSignOut,
}: LockScreenProps) {
  const [mode, setMode] = useState<"pin" | "reauth">(mobile ? "reauth" : "pin");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [newPin, setNewPin] = useState("");

  const lockRoot = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const root = lockRoot.current;
    if (!root) return;
    firstInput.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button, input, textarea, select, [tabindex]:not([tabindex='-1'])"
        )
      ).filter(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-hidden") !== "true"
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (
        event.shiftKey &&
        (document.activeElement === first || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [mode, mobile]);

  const handleUnlock = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mode === "pin" && !mobile) {
      onUnlock({ pin });
    } else {
      onUnlock({
        password,
        totpCode,
        ...(!mobile ? { newPin } : {}),
      });
    }
  };

  return (
    <div
      ref={lockRoot}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/90 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div className="w-full max-w-md p-6 sm:p-8 rounded-xl bg-surface border border-border shadow-2xl space-y-5">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-surface-raised border border-border text-foreground">
            <Icons.Lock size={22} />
          </div>
          <h2 id="lock-title" className="text-xl font-semibold text-foreground">
            本次管理会话已锁定
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {mobile
              ? "移动终端不提供快捷 PIN，请通过完整密码及身份验证器重新认证解锁。"
              : "输入 6 位快捷会话 PIN，或切换为完整重认证重设 PIN。"}
          </p>
        </div>

        <form onSubmit={handleUnlock} className="space-y-4" noValidate>
          {mode === "pin" && !mobile ? (
            <div className="space-y-1.5">
              <label
                htmlFor="lock-pin-input"
                className="block text-xs font-medium text-foreground"
              >
                6 位会话 PIN
              </label>
              <input
                ref={firstInput}
                id="lock-pin-input"
                autoFocus
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="••••••"
                maxLength={6}
                className="w-full h-11 px-3 rounded-md border border-border bg-surface-raised text-center font-mono text-xl tracking-widest text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label
                  htmlFor="lock-pw-input"
                  className="block text-xs font-medium text-foreground"
                >
                  管理员密码
                </label>
                <PasswordInput
                  ref={firstInput}
                  id="lock-pw-input"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入管理员密码"
                  className="h-10 px-3 rounded border border-border bg-surface-raised text-xs"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="lock-totp-input"
                  className="block text-xs font-medium text-foreground"
                >
                  身份验证器验证码 (TOTP)
                </label>
                <input
                  id="lock-totp-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                  maxLength={6}
                  className="w-full h-10 px-3 rounded border border-border bg-surface-raised text-center font-mono text-sm tracking-widest text-foreground"
                />
              </div>

              {!mobile && (
                <div className="space-y-1">
                  <label
                    htmlFor="lock-new-pin-input"
                    className="block text-xs font-medium text-foreground"
                  >
                    重设新的 6 位 PIN
                  </label>
                  <input
                    id="lock-new-pin-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    value={newPin}
                    onChange={(e) =>
                      setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="••••••"
                    maxLength={6}
                    className="w-full h-10 px-3 rounded border border-border bg-surface-raised text-center font-mono text-sm tracking-widest text-foreground"
                  />
                </div>
              )}
            </div>
          )}

          <StatusMessage error={error} />

          <Button
            type="submit"
            loading={loading}
            disabled={
              mode === "pin" && !mobile
                ? pin.length !== 6
                : password.length < 12 ||
                  totpCode.length !== 6 ||
                  (!mobile && newPin.length !== 6)
            }
            className="w-full h-11"
          >
            <span>{mode === "pin" && !mobile ? "解锁会话" : "重认证并解锁"}</span>
          </Button>
        </form>

        <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground">
          {!mobile ? (
            <button
              type="button"
              onClick={() => setMode((m) => (m === "pin" ? "reauth" : "pin"))}
              className="hover:text-foreground underline underline-offset-4 transition-colors"
            >
              {mode === "pin" ? "PIN 不可用？完整重认证" : "使用原有 PIN"}
            </button>
          ) : (
            <span />
          )}

          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Icons.LogOut size={13} />
            <span>退出会话</span>
          </button>
        </div>
      </div>
    </div>
  );
}
