"use client";

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { EDGE_DROP, TIER_ORDER, TIER_SHORT, type TrackTier } from "./membership-center-format";

export function TierTrack({ actual, selected, onSelect, reduced, visible }: { actual: TrackTier | null; selected: TrackTier; onSelect: (tier: TrackTier) => void; reduced: boolean; visible: number }) {
  const [viewportRef, emblaApi] = useEmblaCarousel({ align: "start", loop: false, containScroll: false });
  const selectedIndex = TIER_ORDER.indexOf(selected);
  const ghost = 2;
  const snapOffset = ghost - Math.floor(visible / 2);
  const lastSnap = snapOffset + TIER_ORDER.length - 1;
  const groupRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const selectionRef = useRef(selectedIndex);
  selectionRef.current = selectedIndex;

  useEffect(() => {
    if (!emblaApi) return;
    const sync = () => {
      const snap = emblaApi.selectedScrollSnap();
      if (snap < snapOffset || snap > lastSnap) {
        emblaApi.scrollTo(Math.min(Math.max(snap, snapOffset), lastSnap), true);
        return;
      }
      const tier = TIER_ORDER[snap - snapOffset];
      if (tier && tier !== selected) onSelect(tier);
    };
    emblaApi.on("select", sync);
    return () => {
      emblaApi.off("select", sync);
    };
  }, [emblaApi, onSelect, selected, snapOffset, lastSnap]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit();
    emblaApi.scrollTo(selectionRef.current + snapOffset, true);
  }, [emblaApi, visible, snapOffset]);

  useEffect(() => {
    if (!emblaApi) return;
    const target = selectedIndex + snapOffset;
    if (emblaApi.selectedScrollSnap() === target) return;
    emblaApi.scrollTo(target, reduced);
  }, [emblaApi, selectedIndex, snapOffset, reduced]);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    groupRef.current?.querySelector<HTMLElement>(`.mc-node[data-tier="${selected}"]`)?.focus({ preventScroll: true });
  }, [selected]);

  useEffect(() => {
    if (!emblaApi) return;
    const curve = EDGE_DROP / Math.pow(0.5 - 0.5 / visible, 2);
    const arcDrop = curve * 0.25;
    // Follow the rendered scroll position, not the destination snap, so dots stay on the arc while dragging.
    const paint = () => {
      const snaps = emblaApi.scrollSnapList();
      const first = snaps[snapOffset];
      const next = snaps[snapOffset + 1];
      if (first === undefined || next === undefined) return;
      const step = next - first;
      if (!step) return;
      const centerIndex = ghost + (emblaApi.scrollProgress() - first) / step;
      emblaApi.slideNodes().forEach((node, index) => {
        const distance = index - centerIndex;
        const offset = distance / visible;
        node.style.setProperty("--mc-node-y", `${(arcDrop - curve * offset * offset).toFixed(2)}px`);
        node.style.setProperty("--mc-focus", Math.max(0, 1 - Math.abs(distance)).toFixed(3));
      });
    };
    paint();
    emblaApi.on("scroll", paint);
    emblaApi.on("reInit", paint);
    return () => { emblaApi.off("scroll", paint); emblaApi.off("reInit", paint); };
  }, [emblaApi, visible, snapOffset]);


  const move = (index: number) => {
    const next = TIER_ORDER[Math.min(Math.max(index, 0), TIER_ORDER.length - 1)];
    if (next) onSelect(next);
  };

  const moveFocus = (index: number) => {
    focusPending.current = true;
    move(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(selectedIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(selectedIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(TIER_ORDER.length - 1);
    }
  };

  const curve = EDGE_DROP / Math.pow(0.5 - 0.5 / visible, 2);
  const arcDrop = curve * 0.25;
  const arcHeight = Math.ceil(arcDrop) + 12;
  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex < TIER_ORDER.length - 1;

  return (
    <div className="mc-track-zone" ref={groupRef} data-fade-left={canPrev || undefined} data-fade-right={canNext || undefined}>
      <button type="button" className="mc-arrow mc-arrow--prev" aria-label="查看上一个等级" disabled={!canPrev} onClick={() => move(selectedIndex - 1)}>
        <ChevronLeft size={20} aria-hidden="true" />
      </button>
      <div className="mc-track-shell" style={{ "--mc-visible": visible, "--mc-arc-drop": `${arcDrop}px` } as CSSProperties}>
        <svg className="mc-arc" viewBox={`0 0 1000 ${arcHeight}`} preserveAspectRatio="none" aria-hidden="true" style={{ height: arcHeight }}>
          <defs>
            <linearGradient id="mc-arc-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.12 }} />
              <stop offset="0.5" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.75 }} />
              <stop offset="1" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.12 }} />
            </linearGradient>
          </defs>
          <path className="mc-arc-edge" d={`M0 0 Q500 ${2 * arcDrop} 1000 0`} stroke="url(#mc-arc-grad)" />
        </svg>
        <div className="mc-track" ref={viewportRef} role="radiogroup" aria-label="选择要查看的会员等级" onKeyDown={onKeyDown}>
          <div className="mc-track-slides">
            {[0, 1].map((pad) => <div key={`ghost-start-${pad}`} className="mc-node mc-node--ghost" aria-hidden="true" />)}
            {TIER_ORDER.map((tier) => (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={tier === selected}
                tabIndex={tier === selected ? 0 : -1}
                className="mc-node"
                data-tier={tier}
                data-current={tier === actual || undefined}
                onClick={() => onSelect(tier)}
              >
                <span className="mc-node-dot" aria-hidden="true" />
                <span className="mc-node-label">{TIER_SHORT[tier]}</span>
                <span className="mc-node-current" aria-hidden={tier !== actual}>{tier === actual ? "当前" : "\u00a0"}</span>
                {tier === "BLACK_GOLD" ? <span className="mc-node-chip sr-only">累计</span> : null}
              </button>
            ))}
            {[0, 1].map((pad) => <div key={`ghost-end-${pad}`} className="mc-node mc-node--ghost" aria-hidden="true" />)}
          </div>
        </div>
      </div>
      <button type="button" className="mc-arrow mc-arrow--next" aria-label="查看下一个等级" disabled={!canNext} onClick={() => move(selectedIndex + 1)}>
        <ChevronRight size={20} aria-hidden="true" />
      </button>
      {actual ? (
        <button type="button" className="mc-return" style={selected === actual ? { visibility: "hidden" } : undefined} disabled={selected === actual} aria-hidden={selected === actual} tabIndex={selected === actual ? -1 : 0} onClick={() => { focusPending.current = true; onSelect(actual); }}>
          返回当前等级
        </button>
      ) : null}
    </div>
  );
}
