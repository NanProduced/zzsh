import React, { useEffect, useRef, useSyncExternalStore } from 'react';

const ED = 0.14;
const TD = 1.35;
const ND = 0.52;
const RD = 120;
const ID = 0.2;

export function bumpParticleTypingImpulse(ref: React.RefObject<number> | null, amount = ED) {
  if (ref && 'current' in ref && typeof ref.current === 'number') {
    ref.current = Math.min(ref.current + amount, TD);
  }
}

export function pulseParticleSubmitImpulse(ref: React.RefObject<number> | null) {
  bumpParticleTypingImpulse(ref, ND);
  window.setTimeout(() => {
    bumpParticleTypingImpulse(ref, ID);
  }, RD);
}

export function handleParticleKeyDown(ref: React.RefObject<number> | null, e: React.KeyboardEvent) {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.key === 'Tab' || e.key === 'Escape') return;
  bumpParticleTypingImpulse(ref, ED);
}

function subscribeTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', callback);
  };
}

function getThemeSnapshot() {
  if (typeof document === 'undefined') return true;
  return (
    document.documentElement.classList.contains('dark') ||
    document.documentElement.dataset.theme === 'dark'
  );
}

function getThemeServerSnapshot() {
  return true;
}

export interface ParticleFieldProps {
  src: string;
  sampleStep?: number;
  threshold?: number;
  renderScale?: number;
  dotSize?: number;
  mouseForce?: number;
  mouseRadius?: number;
  spring?: number;
  damping?: number;
  className?: string;
  align?: 'center' | 'bottom';
  color?: string;
  invert?: boolean;
  adaptToTheme?: boolean;
  typingImpulseRef?: React.RefObject<number>;
  denseParticles?: boolean;
}

interface Particle {
  ox: number;
  oy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
  springJitter: number;
  appear: number;
  fading: boolean;
}

export function ParticleField({
  src,
  sampleStep = 3,
  threshold = 50,
  renderScale = 1,
  dotSize = 1.15,
  mouseForce = 90,
  mouseRadius = 110,
  spring = 0.035,
  damping = 0.86,
  className,
  align = 'center',
  color = 'rgba(255, 255, 255, 0.92)',
  invert = false,
  adaptToTheme = true,
  typingImpulseRef,
  denseParticles = false,
}: ParticleFieldProps) {
  const isDark = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const colorRef = useRef(color);
  colorRef.current = adaptToTheme ? (isDark ? 'rgba(255, 255, 255, 0.92)' : 'rgba(10, 12, 16, 1)') : color;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });

  const srcRef = useRef(src);
  srcRef.current = src;
  const updateImageRef = useRef<((s: string) => void) | null>(null);

  const sampleStepRef = useRef(sampleStep);
  sampleStepRef.current = sampleStep;
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const renderScaleRef = useRef(renderScale);
  renderScaleRef.current = renderScale;
  const dotSizeRef = useRef(dotSize);
  dotSizeRef.current = dotSize;
  const mouseForceRef = useRef(mouseForce);
  mouseForceRef.current = mouseForce;
  const mouseRadiusRef = useRef(mouseRadius);
  mouseRadiusRef.current = mouseRadius;
  const springRef = useRef(spring);
  springRef.current = spring;
  const dampingRef = useRef(damping);
  dampingRef.current = damping;
  const alignRef = useRef(align);
  alignRef.current = align;
  const invertRef = useRef(invert);
  invertRef.current = invert;
  const denseRef = useRef(denseParticles);
  denseRef.current = denseParticles;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let particles: Particle[] = [];
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cw = 0, ch = 0;
    let iw = 0, ih = 0;
    let ox = 0, oy = 0;
    let stopped = false;
    let time = 0;
    let resizeTimer: any = null;
    let currentImg: HTMLImageElement | null = null;
    let seq = 0;
    let animId = 0;

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      cw = Math.max(1, Math.floor(rect.width));
      ch = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    };

    const sampleImage = (img: HTMLImageElement) => {
      if (!img.width || !img.height) return [];
      const imgAspect = img.width / img.height;
      const contAspect = cw / ch;
      let renderW = cw;
      let renderH = ch;
      if (imgAspect > contAspect) {
        renderH = ch;
        renderW = ch * imgAspect;
      } else {
        renderW = cw;
        renderH = cw / imgAspect;
      }
      renderW *= renderScaleRef.current;
      renderH *= renderScaleRef.current;

      const sampleW = Math.max(80, Math.floor(renderW / sampleStepRef.current));
      const sampleH = Math.max(80, Math.floor(renderH / sampleStepRef.current));
      const offscreen = document.createElement('canvas');
      offscreen.width = sampleW;
      offscreen.height = sampleH;
      const offCtx = offscreen.getContext('2d', { willReadFrequently: true });
      if (!offCtx) return [];
      offCtx.drawImage(img, 0, 0, sampleW, sampleH);
      const data = offCtx.getImageData(0, 0, sampleW, sampleH).data;

      const stepX = renderW / sampleW;
      const stepY = renderH / sampleH;
      iw = renderW;
      ih = renderH;
      ox = (cw - iw) / 2;
      oy = alignRef.current === 'bottom' ? ch - ih - Math.min(40, ch * 0.04) : (ch - ih) / 2;

      const thresh = thresholdRef.current;
      const inv = invertRef.current;
      const dense = denseRef.current;
      const baseDot = dotSizeRef.current;
      const pts: { ox: number; oy: number; size: number; alpha: number }[] = [];

      for (let y = 0; y < sampleH; y++) {
        for (let x = 0; x < sampleW; x++) {
          const idx = (y * sampleW + x) * 4;
          const r = data[idx] ?? 0;
          const g = data[idx + 1] ?? 0;
          const b = data[idx + 2] ?? 0;
          const a = data[idx + 3] ?? 0;
          const avg = (r + g + b) / 3;
          const val = inv ? 255 - avg : avg;
          if (a < 200 || val < thresh) continue;
          const normVal = val / 255;
          if (!dense && !(normVal > 0.8 || (normVal > 0.5 ? Math.random() < 0.85 : normVal > 0.25 ? Math.random() < 0.55 : Math.random() < 0.28))) {
            continue;
          }
          const px = (ox + x * stepX + stepX / 2) * dpr;
          const py = (oy + y * stepY + stepY / 2) * dpr;
          pts.push({
            ox: px,
            oy: py,
            size: (baseDot + normVal * 0.9) * dpr,
            alpha: 0.35 + normVal * 0.6,
          });
        }
      }
      return pts;
    };

    const randJitter = () => 0.9 + Math.random() * 0.2;

    const initParticles = (img: HTMLImageElement) => {
      if (!img.width || !img.height) return;
      resizeCanvas();
      particles = sampleImage(img).map((p) => ({
        ox: p.ox,
        oy: p.oy,
        x: p.ox + (Math.random() - 0.5) * 40,
        y: p.oy + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        size: p.size,
        alpha: p.alpha,
        phase: Math.random() * Math.PI * 2,
        springJitter: randJitter(),
        appear: 1,
        fading: false,
      }));
    };

    const shuffle = (len: number) => {
      const arr = Array(len);
      for (let i = 0; i < len; i++) arr[i] = i;
      for (let i = len - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
      }
      return arr;
    };

    const morphParticles = (img: HTMLImageElement) => {
      if (!img.width || !img.height) return;
      if (particles.length === 0) {
        initParticles(img);
        return;
      }
      resizeCanvas();
      const newPts = sampleImage(img);
      const oldLen = particles.length;
      const newLen = newPts.length;
      const minLen = Math.min(oldLen, newLen);
      const oldIdxs = shuffle(oldLen);
      const newIdxs = shuffle(newLen);

      for (let i = 0; i < minLen; i++) {
        const p = particles[oldIdxs[i]!];
        const np = newPts[newIdxs[i]!];
        if (!p || !np) continue;
        p.ox = np.ox;
        p.oy = np.oy;
        p.size = np.size;
        p.alpha = np.alpha;
        p.fading = false;
        p.springJitter = randJitter();
      }
      for (let i = minLen; i < oldLen; i++) {
        const p = particles[oldIdxs[i]!];
        if (p) p.fading = true;
      }
      for (let i = minLen; i < newLen; i++) {
        const np = newPts[newIdxs[i]!];
        if (!np) continue;
        const angle = Math.random() * Math.PI * 2;
        const radius = (20 + Math.random() * 40) * dpr;
        particles.push({
          ox: np.ox,
          oy: np.oy,
          x: np.ox + Math.cos(angle) * radius,
          y: np.oy + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          size: np.size,
          alpha: np.alpha,
          phase: Math.random() * Math.PI * 2,
          springJitter: randJitter(),
          appear: 0,
          fading: false,
        });
      }
    };

    const loop = () => {
      if (stopped) return;
      time += 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = colorRef.current;
      const mForce = mouseForceRef.current;
      const mRad = mouseRadiusRef.current * dpr;
      const mRadSq = mRad * mRad;
      const sp = springRef.current;
      const damp = dampingRef.current;
      const mx = mouseRef.current.x * dpr;
      const my = mouseRef.current.y * dpr;

      let impulse = typingImpulseRef?.current ?? 0;
      if (typingImpulseRef && impulse > 1e-4) {
        (typingImpulseRef as any).current *= 0.93;
      }
      const impulseMultiplier = 1 + impulse * 10;
      const centerX = (ox + iw * 0.5) * dpr;
      const centerY = (oy + ih * 0.48) * dpr;
      let activeCount = 0;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p) continue;
        const dx = p.ox - p.x;
        const dy = p.oy - p.y;
        const k = sp * p.springJitter;
        p.vx += dx * k;
        p.vy += dy * k;

        if (mouseRef.current.active) {
          const ex = p.x - mx;
          const ey = p.y - my;
          const distSq = ex * ex + ey * ey;
          if (distSq < mRadSq && distSq > 1e-4) {
            const dist = Math.sqrt(distSq);
            const factor = (1 - dist / mRad) * mForce;
            p.vx += (ex / dist) * factor * 0.04;
            p.vy += (ey / dist) * factor * 0.04;
          }
        }

        const wave = Math.sin(time * 0.8 + p.phase) * 0.08;
        p.vx += wave * 0.05 * impulseMultiplier;
        p.vy += Math.cos(time * 0.9 + p.phase) * 0.04 * impulseMultiplier;

        if (impulse > 1e-4) {
          p.vx += (Math.random() - 0.5) * impulse * 2.8;
          p.vy += (Math.random() - 0.5) * impulse * 2.8;
          const cx = p.x - centerX;
          const cy = p.y - centerY;
          const cdist = Math.sqrt(cx * cx + cy * cy) + 0.5;
          const push = (impulse * 22 * dpr) / cdist;
          p.vx += (cx / cdist) * push * 0.018;
          p.vy += (cy / cdist) * push * 0.018;
        }

        p.vx *= damp;
        p.vy *= damp;
        p.x += p.vx;
        p.y += p.vy;

        const targetAppear = p.fading ? 0 : 1;
        p.appear += (targetAppear - p.appear) * 0.08;
        if (p.fading && p.appear < 0.02) continue;

        const pulse = 0.85 + Math.sin(time * (1.4 + impulse * 2.2) + p.phase) * (0.15 + impulse * 0.35);
        ctx.globalAlpha = p.alpha * p.appear * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();

        if (activeCount !== i) {
          particles[activeCount] = p;
        }
        activeCount++;
      }

      if (activeCount !== particles.length) {
        particles.length = activeCount;
      }
      ctx.globalAlpha = 1;
      animId = requestAnimationFrame(loop);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
      mouseRef.current.active = true;
    };

    const onPointerLeave = () => {
      mouseRef.current.active = false;
      mouseRef.current.x = -9999;
      mouseRef.current.y = -9999;
    };

    const ro = new ResizeObserver(() => {
      if (resizeTimer) cancelAnimationFrame(resizeTimer);
      resizeTimer = requestAnimationFrame(() => {
        if (currentImg) {
          initParticles(currentImg);
        }
      });
    });

    const loadImage = (url: string, isMorph: boolean) => {
      const curSeq = ++seq;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (stopped || curSeq !== seq) return;
        currentImg = img;
        if (isMorph) morphParticles(img);
        else initParticles(img);
      };
      img.src = url;
    };

    updateImageRef.current = (url: string) => loadImage(url, true);
    ro.observe(container);
    animId = requestAnimationFrame(loop);
    loadImage(srcRef.current, false);

    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);

    return () => {
      stopped = true;
      cancelAnimationFrame(animId);
      if (resizeTimer) cancelAnimationFrame(resizeTimer);
      ro.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      updateImageRef.current = null;
    };
  }, [typingImpulseRef]);

  const lastSrcRef = useRef(src);
  useEffect(() => {
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      updateImageRef.current?.(src);
    }
  }, [src]);

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}
