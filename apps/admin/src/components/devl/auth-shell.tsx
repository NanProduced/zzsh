import React, { createContext, useContext, useRef, ReactNode } from 'react';
import { ParticleField } from './particle-field';
import { AuthSplitLayout } from './auth-split-layout';
import welcomeSrc from '../../assets/devl/welcome.png';
import teamSrc from '../../assets/devl/team.png';
import clustersSrc from '../../assets/devl/clusters.png';

type ImpulseRef = React.RefObject<number>;
const TypingImpulseContext = createContext<ImpulseRef | null>(null);

export function useAuthTypingImpulse(): ImpulseRef {
  const ctx = useContext(TypingImpulseContext);
  if (!ctx) throw new Error('useAuthTypingImpulse outside <AuthShell>');
  return ctx;
}

export type AuthShellVariant = 'welcome' | 'request-access' | 'onboarding';

const FIGURES: Record<AuthShellVariant, string> = {
  welcome: welcomeSrc,
  'request-access': teamSrc,
  onboarding: clustersSrc,
};

export interface AuthShellProps {
  children: ReactNode;
  variant?: AuthShellVariant;
  customFigureSrc?: string;
  brandTag?: ReactNode;
  mobileBrandTag?: ReactNode;
  topRight?: ReactNode;
  rightClassName?: string;
  forceMobile?: boolean;
}

export function AuthShell({
  children,
  variant = 'welcome',
  customFigureSrc,
  brandTag,
  mobileBrandTag,
  topRight,
  rightClassName = 'lg:w-[620px]',
  forceMobile = false,
}: AuthShellProps) {
  const typingImpulseRef = useRef(0);
  const src = customFigureSrc || FIGURES[variant] || welcomeSrc;

  return (
    <TypingImpulseContext.Provider value={typingImpulseRef}>
      <AuthSplitLayout
        forceMobile={forceMobile}
        rightClassName={rightClassName}
        topRight={topRight}
        left={
          <>
            <ParticleField
              src={src}
              sampleStep={3}
              threshold={34}
              dotSize={1}
              renderScale={1}
              align="center"
              typingImpulseRef={typingImpulseRef}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(900px 600px at 50% 50%, transparent 45%, color-mix(in srgb, var(--background) 88%, transparent) 92%)',
              }}
            />
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-12">
              <div className="pointer-events-auto flex items-center gap-2 font-mono text-sm">
                {brandTag ? (
                  brandTag
                ) : (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-foreground" />
                    <span className="tracking-[0.2em] uppercase">Sean&apos;s scratch pad</span>
                  </>
                )}
              </div>
              <div className="max-w-md flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-primary/70" />
                  <span className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground/70 uppercase">
                    ZHOUZHOU CONSOLE
                  </span>
                </div>
                <p className="font-heading text-[29px] font-semibold tracking-tight text-foreground leading-snug">
                  玩的更远，一直有洲洲
                </p>
              </div>
            </div>
          </>
        }
        right={
          <>
            <div className={`absolute top-6 left-6 flex items-center gap-2 font-mono text-sm ${forceMobile ? 'flex' : 'lg:hidden'}`}>
              {mobileBrandTag ? (
                mobileBrandTag
              ) : brandTag ? (
                brandTag
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-foreground" />
                  <span className="tracking-[0.2em] uppercase">Sean&apos;s scratch pad</span>
                </>
              )}
            </div>
            {children}
          </>
        }
      />
    </TypingImpulseContext.Provider>
  );
}
