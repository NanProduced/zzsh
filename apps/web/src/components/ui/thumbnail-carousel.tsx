"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue } from "motion/react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";

export type ThumbnailCarouselItem = {
  id: string;
  src: string;
  alt: string;
};

type ThumbnailCarouselProps = {
  items: ThumbnailCarouselItem[];
  index: number;
  onIndexChange: (index: number) => void;
  failedItemIds?: ReadonlySet<string>;
  onImageError?: (itemId: string) => void;
};

export function ThumbnailCarousel({
  items,
  index,
  onIndexChange,
  failedItemIds,
  onImageError,
}: ThumbnailCarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const thumbnailsRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [isDragging, setIsDragging] = useState(false);
  const activeIndex = items.length > 0 ? Math.min(Math.max(index, 0), items.length - 1) : 0;
  const selectIndex = (nextIndex: number) => onIndexChange(Math.max(0, Math.min(items.length - 1, nextIndex)));

  useEffect(() => {
    if (isDragging || !viewportRef.current) return;
    const width = viewportRef.current.offsetWidth || 1;
    const controls = animate(x, -activeIndex * width, {
      type: "spring",
      stiffness: 300,
      damping: 30,
    });
    return () => controls.stop();
  }, [activeIndex, isDragging, x]);

  useEffect(() => {
    if (items.length > 0 && index !== activeIndex) onIndexChange(activeIndex);
  }, [activeIndex, index, items.length, onIndexChange]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const syncPosition = () => x.set(-activeIndex * (viewport.offsetWidth || 1));
    const observer = new ResizeObserver(syncPosition);
    observer.observe(viewport);
    syncPosition();
    return () => observer.disconnect();
  }, [activeIndex, x]);

  useEffect(() => {
    const activeThumbnail = thumbnailsRef.current?.querySelector<HTMLElement>(`[data-thumbnail-index="${activeIndex}"]`);
    activeThumbnail?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div className="thumbnail-carousel">
      <div className="thumbnail-carousel-stage">
        <div ref={viewportRef} className="thumbnail-carousel-main" aria-live="polite">
          <motion.div
            className="thumbnail-carousel-track"
            drag="x"
            dragElastic={0.12}
            dragMomentum={false}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={(_, info) => {
              setIsDragging(false);
              const width = viewportRef.current?.offsetWidth || 1;
              const offset = info.offset.x;
              const velocity = info.velocity.x;
              let nextIndex = activeIndex;
              if (Math.abs(velocity) > 500) {
                nextIndex += velocity < 0 ? 1 : -1;
              } else if (Math.abs(offset) > width * 0.25) {
                nextIndex += offset < 0 ? 1 : -1;
              }
              selectIndex(nextIndex);
            }}
            style={{ x }}
          >
            {items.map((item, itemIndex) => {
              const failed = failedItemIds?.has(item.id) ?? false;
              return (
                <div key={item.id} className="thumbnail-carousel-slide" aria-hidden={itemIndex !== activeIndex}>
                  {failed ? (
                    <span className="thumbnail-carousel-fallback"><ImageOff size={24} aria-hidden="true" />图片暂不可用</span>
                  ) : (
                    <img
                      src={item.src}
                      alt={item.alt}
                      draggable={false}
                      loading={itemIndex === activeIndex ? "eager" : "lazy"}
                      onError={() => onImageError?.(item.id)}
                    />
                  )}
                </div>
              );
            })}
          </motion.div>
          <span className="thumbnail-carousel-count">{activeIndex + 1} / {items.length}</span>

          <button
            type="button"
            className="thumbnail-carousel-nav thumbnail-carousel-nav--previous"
            aria-label="上一张图片"
            disabled={activeIndex === 0}
            onClick={() => selectIndex(activeIndex - 1)}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="thumbnail-carousel-nav thumbnail-carousel-nav--next"
            aria-label="下一张图片"
            disabled={activeIndex === items.length - 1}
            onClick={() => selectIndex(activeIndex + 1)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {items.length > 1 ? (
        <div ref={thumbnailsRef} className="thumbnail-carousel-thumbnails" aria-label="选择公开展示图片">
          {items.map((item, itemIndex) => (
            <motion.button
              key={item.id}
              type="button"
              className="thumbnail-carousel-thumb"
              data-thumbnail-index={itemIndex}
              aria-label={`查看第${itemIndex + 1}张图片`}
              aria-pressed={itemIndex === activeIndex}
              onClick={() => selectIndex(itemIndex)}
              initial={false}
              animate={{ width: itemIndex === activeIndex ? 128 : 40 }}
              transition={{ duration: 0.24, ease: "easeOut" }}
            >
              <img src={item.src} alt="" draggable={false} loading="lazy" />
            </motion.button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
