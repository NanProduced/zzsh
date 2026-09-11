"use client";

import {
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useId,
} from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { normalizeCodePaste } from "./code-input";

// Animation constants from SmoothUI
const EASE_OUT_QUINT_X1 = 0.22;
const EASE_OUT_QUINT_Y1 = 1;
const EASE_OUT_QUINT_X2 = 0.36;
const EASE_OUT_QUINT_Y2 = 1;
const EASE_OUT_QUINT = [
  EASE_OUT_QUINT_X1,
  EASE_OUT_QUINT_Y1,
  EASE_OUT_QUINT_X2,
  EASE_OUT_QUINT_Y2,
] as const;

const ANIMATION_DURATION_SHORT = 0.1;
const ANIMATION_DURATION_MEDIUM = 0.15;
const ANIMATION_DURATION_STANDARD = 0.2;
const ANIMATION_DURATION_LONG = 0.3;
const STAGGER_DELAY = 0.04;
const SCALE_FILLED = 1.04;
const SCALE_HOVER = 1.02;
const SCALE_TAP = 0.98;
const INITIAL_SCALE = 0.85;
const INITIAL_Y = 8;
const SEPARATOR_DELAY = 0.12;

function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export interface AnimatedInputOTPProps {
  "aria-describedby"?: string;
  "aria-label"?: string;
  className?: string;
  containerClassName?: string;
  maxLength?: number;
  pattern?: string;
  pasteTransformer?: (value: string) => string;
  inputMode?: "numeric" | "text";
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  value?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}

export function AnimatedInputOTP({
  className,
  containerClassName,
  value,
  onChange,
  onComplete,
  maxLength = 6,
  pattern,
  disabled,
  autoFocus,
  id,
  children,
  ...props
}: AnimatedInputOTPProps & { children: ReactNode }) {
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <OTPInput
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      id={inputId}
      aria-describedby={props["aria-describedby"]}
      aria-label={props["aria-label"] || "动态安全验证码"}
      className={cn("disabled:cursor-not-allowed", className)}
      containerClassName={cn(
        "flex items-center justify-center gap-1.5 has-disabled:opacity-50",
        containerClassName
      )}
      data-slot="input-otp"
      maxLength={maxLength}
      pattern={pattern}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={onChange}
      onComplete={onComplete}
      value={value}
      {...props}
    >
      {children}
    </OTPInput>
  );
}

export interface AnimatedInputOTPGroupProps {
  children?: ReactNode;
  className?: string;
}

export function AnimatedInputOTPGroup({
  className,
  children,
}: AnimatedInputOTPGroupProps) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.div
      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      className={cn("flex items-center gap-1.5 sm:gap-2", className)}
      data-slot="input-otp-group"
      initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: INITIAL_Y }}
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : {
              duration: ANIMATION_DURATION_LONG,
              ease: EASE_OUT_QUINT,
            }
      }
    >
      {children}
    </motion.div>
  );
}

export interface AnimatedInputOTPSlotProps {
  className?: string;
  index: number;
  size?: "default" | "compact";
}

export function AnimatedInputOTPSlot({
  index,
  className,
  size = "default",
}: AnimatedInputOTPSlotProps) {
  const inputOTPContext = useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};
  const [isFilled, setIsFilled] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (char && !isFilled) {
      setIsFilled(true);
    } else if (!char && isFilled) {
      setIsFilled(false);
    }
  }, [char, isFilled]);

  const sizeClasses =
    size === "compact"
      ? "h-11 w-7 sm:w-8 text-sm font-mono"
      : "h-12 w-10 sm:h-13 sm:w-12 text-lg sm:text-xl font-mono font-semibold";

  return (
    <motion.div
      animate={
        shouldReduceMotion
          ? { opacity: 1 }
          : {
              opacity: 1,
              scale: isFilled ? SCALE_FILLED : 1,
              y: 0,
            }
      }
      className={cn(
        "relative flex items-center justify-center rounded-lg border",
        "border-input/70 bg-background/50 text-foreground shadow-2xs outline-none transition-all",
        "dark:border-border/70 dark:bg-input/20",
        "data-[active=true]:z-10 data-[active=true]:border-primary data-[active=true]:ring-2 data-[active=true]:ring-ring/30",
        sizeClasses,
        className
      )}
      data-active={isActive}
      data-slot="input-otp-slot"
      initial={
        shouldReduceMotion
          ? { opacity: 1 }
          : { opacity: 0, scale: INITIAL_SCALE, y: INITIAL_Y }
      }
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : {
              delay: index * STAGGER_DELAY,
              duration: ANIMATION_DURATION_STANDARD,
              ease: EASE_OUT_QUINT,
              scale: {
                duration: ANIMATION_DURATION_MEDIUM,
                ease: EASE_OUT_QUINT,
              },
            }
      }
      whileHover={
        shouldReduceMotion
          ? {}
          : {
              scale: SCALE_HOVER,
              transition: {
                duration: ANIMATION_DURATION_MEDIUM,
                ease: EASE_OUT_QUINT,
              },
            }
      }
      whileTap={
        shouldReduceMotion
          ? {}
          : {
              scale: SCALE_TAP,
              transition: {
                duration: ANIMATION_DURATION_SHORT,
                ease: EASE_OUT_QUINT,
              },
            }
      }
    >
      <AnimatePresence mode="wait">
        {char ? (
          <motion.span
            animate={
              shouldReduceMotion
                ? { opacity: 1, scale: 1 }
                : { opacity: 1, rotateY: 0, scale: 1 }
            }
            className="select-none font-bold"
            exit={
              shouldReduceMotion
                ? { opacity: 0, transition: { duration: 0 } }
                : { opacity: 0, rotateY: 90, scale: 0.5 }
            }
            initial={
              shouldReduceMotion
                ? { opacity: 1, scale: 1 }
                : { opacity: 0, rotateY: -90, scale: 0.5 }
            }
            key={char}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : {
                    duration: ANIMATION_DURATION_STANDARD,
                    ease: EASE_OUT_QUINT,
                  }
            }
          >
            {char}
          </motion.span>
        ) : null}
      </AnimatePresence>

      {hasFakeCaret && !shouldReduceMotion && (
        <motion.div
          animate={{ opacity: 1 }}
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: ANIMATION_DURATION_SHORT }}
        >
          <motion.div
            animate={{ opacity: [0, 1, 0] }}
            className="h-5 w-0.5 rounded-full bg-primary"
            transition={{
              duration: 1,
              ease: [0.645, 0.045, 0.355, 1],
              repeat: Number.POSITIVE_INFINITY,
            }}
          />
        </motion.div>
      )}
    </motion.div>
  );
}

export function AnimatedInputOTPSeparator() {
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.div
      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      className="flex items-center justify-center px-1 text-muted-foreground select-none"
      data-slot="input-otp-separator"
      initial={
        shouldReduceMotion ? { opacity: 1 } : { opacity: 0, scale: INITIAL_SCALE }
      }
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : {
              delay: SEPARATOR_DELAY,
              duration: ANIMATION_DURATION_LONG,
              ease: EASE_OUT_QUINT,
            }
      }
    >
      <svg
        className="h-3 w-3 sm:h-4 sm:w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </motion.div>
  );
}

// -------------------------------------------------------------
// Composite Export 1: TOTP Input (6 Digits Numeric: 3 + 3)
// -------------------------------------------------------------
export interface SmoothTotpInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
}

export function SmoothTotpInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus = true,
  id,
  className,
}: SmoothTotpInputProps) {
  const handleChange = (raw: string) => {
    // Digits only
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    onChange(digits);
  };

  return (
    <AnimatedInputOTP
      id={id}
      value={value}
      maxLength={6}
      pattern="^[0-9]+$"
      pasteTransformer={normalizeCodePaste}
      inputMode="numeric"
      onChange={handleChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className}
    >
      <AnimatedInputOTPGroup>
        <AnimatedInputOTPSlot index={0} />
        <AnimatedInputOTPSlot index={1} />
        <AnimatedInputOTPSlot index={2} />
      </AnimatedInputOTPGroup>
      <AnimatedInputOTPSeparator />
      <AnimatedInputOTPGroup>
        <AnimatedInputOTPSlot index={3} />
        <AnimatedInputOTPSlot index={4} />
        <AnimatedInputOTPSlot index={5} />
      </AnimatedInputOTPGroup>
    </AnimatedInputOTP>
  );
}

// -------------------------------------------------------------
// Composite Export 2: Backup Code Input (10 Chars Alphanumeric: 5 + 5 with hyphen "AWtNQ-x8Fl8")
// -------------------------------------------------------------
export interface SmoothBackupCodeInputProps {
  value: string;
  onChange: (formattedValue: string) => void;
  onComplete?: (formattedValue: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
  className?: string;
}

export function SmoothBackupCodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus = true,
  id,
  className,
}: SmoothBackupCodeInputProps) {
  // Strip hyphens for raw OTP state (10 characters: AWtNQx8Fl8)
  const rawValue = value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);

  const formatWithHyphen = (cleaned: string): string => {
    if (cleaned.length > 5) {
      return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
    }
    return cleaned;
  };

  const handleChange = (input: string) => {
    // Strip hyphens and any invalid chars from typed/pasted string
    const cleaned = input.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    const formatted = formatWithHyphen(cleaned);
    onChange(formatted);
  };

  const handleComplete = (completedRaw: string) => {
    const cleaned = completedRaw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    onComplete?.(formatWithHyphen(cleaned));
  };

  return (
    <AnimatedInputOTP
      id={id}
      value={rawValue}
      maxLength={10}
      pattern="^[a-zA-Z0-9]+$"
      pasteTransformer={normalizeCodePaste}
      inputMode="text"
      onChange={handleChange}
      onComplete={handleComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className}
      containerClassName="gap-1 sm:gap-1.5"
    >
      <AnimatedInputOTPGroup className="gap-1 sm:gap-1.5">
        <AnimatedInputOTPSlot index={0} size="compact" />
        <AnimatedInputOTPSlot index={1} size="compact" />
        <AnimatedInputOTPSlot index={2} size="compact" />
        <AnimatedInputOTPSlot index={3} size="compact" />
        <AnimatedInputOTPSlot index={4} size="compact" />
      </AnimatedInputOTPGroup>
      <AnimatedInputOTPSeparator />
      <AnimatedInputOTPGroup className="gap-1 sm:gap-1.5">
        <AnimatedInputOTPSlot index={5} size="compact" />
        <AnimatedInputOTPSlot index={6} size="compact" />
        <AnimatedInputOTPSlot index={7} size="compact" />
        <AnimatedInputOTPSlot index={8} size="compact" />
        <AnimatedInputOTPSlot index={9} size="compact" />
      </AnimatedInputOTPGroup>
    </AnimatedInputOTP>
  );
}

export default SmoothTotpInput;
