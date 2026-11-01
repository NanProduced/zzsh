"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import Lightbox, { ImageSlide, isImageSlide, useLightboxProps, type Slide, type SlideImage } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import "yet-another-react-lightbox/styles.css";
import type { MediaPreviewItem } from "./message-media";
import { IMAGE_DISPLAY_WIDTH, IMAGE_DISPLAY_WIDTH_CSS, VIDEO_DISPLAY_WIDTH_CSS, imageDisplaySize, type MediaDimensions } from "./media-display";

const PLUGINS = [Zoom, Video, Fullscreen];

/**
 * Render the default image slide without its natural-size measurement.
 * YARL otherwise treats a 64px source as 64px when bounding zoom drag, even
 * though the display projection shows it at 720px; panning then clamps to 0.
 * Source width/height stay in the message metadata; only this display box is
 * projected.
 */
function ProjectedImageSlide({ slide, offset, rect }: { slide: SlideImage; offset: number; rect: { width: number; height: number } }) {
  const { render, carousel } = useLightboxProps();
  return <ImageSlide slide={slide} offset={offset} rect={rect} imageFit={carousel.imageFit} imageProps={carousel.imageProps} render={render} />;
}

/** Read the real media dimensions when the message did not carry them. */
function useMediaDimensions(item: MediaPreviewItem): MediaDimensions | null {
  const [dimensions, setDimensions] = useState<MediaDimensions | null>(() =>
    item.width && item.height ? { width: item.width, height: item.height } : null,
  );
  useEffect(() => {
    if (item.width && item.height) {
      setDimensions({ width: item.width, height: item.height });
      return;
    }
    setDimensions(null);
    let cancelled = false;
    const accept = (width: number, height: number) => {
      if (!cancelled && width > 0 && height > 0) setDimensions({ width, height });
    };
    if (item.kind === "image") {
      const image = new Image();
      image.onload = () => accept(image.naturalWidth, image.naturalHeight);
      image.src = item.url;
      return () => { cancelled = true; image.onload = null; image.onerror = null; };
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => accept(video.videoWidth, video.videoHeight);
    video.src = item.url;
    return () => {
      cancelled = true;
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [item.kind, item.url, item.width, item.height]);
  return dimensions;
}

function releaseVideoElement(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

export default function MediaLightbox({ item, sizeLabel, onClose, returnFocus }: {
  item: MediaPreviewItem;
  sizeLabel?: string | null;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const dimensions = useMediaDimensions(item);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  const imageSize = dimensions ? imageDisplaySize(dimensions) : null;
  const kindLabel = item.kind === "image" ? "图片" : "视频";
  const sizeText = sizeLabel ? ` · ${sizeLabel}` : "";
  const sourceText = dimensions ? `源尺寸 ${dimensions.width}×${dimensions.height}${sizeText}` : "正在读取源尺寸";

  useEffect(() => {
    setVideoFailed(false);
    return () => {
      releaseVideoElement(videoRef.current);
      videoRef.current = null;
    };
  }, [item.url, attempt]);

  useEffect(() => {
    if (item.kind !== "video") return;
    let frame = 0;
    let animation = 0;
    let cancelled = false;
    let timer = 0;
    let video: HTMLVideoElement | null = null;
    const onError = (event: Event) => {
      const target = event.target;
      if ((target instanceof HTMLVideoElement || target instanceof HTMLSourceElement) && slideRef.current?.contains(target)) setVideoFailed(true);
    };
    const attach = () => {
      if (cancelled) return;
      const node = slideRef.current?.querySelector<HTMLVideoElement>("video");
      if (!node) {
        if (frame++ < 120) animation = requestAnimationFrame(attach);
        return;
      }
      video = node;
      videoRef.current = node;
      node.addEventListener("error", onError);
      if (node.error) setVideoFailed(true);
      timer = window.setTimeout(() => {
        if (node.networkState === 3 && node.readyState === 0) setVideoFailed(true);
      }, 700);
    };
    document.addEventListener("error", onError, true);
    animation = requestAnimationFrame(attach);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animation);
      document.removeEventListener("error", onError, true);
      video?.removeEventListener("error", onError);
      if (timer) window.clearTimeout(timer);
    };
  }, [item.kind, item.url, attempt]);

  const retry = () => {
    setVideoFailed(false);
    setAttempt((value) => value + 1);
  };

  const slide: Slide = item.kind === "image"
    ? {
        type: "image",
        src: item.url,
        alt: item.name,
        ...(imageSize ? { width: imageSize.width, height: imageSize.height } : {}),
      }
    : {
        type: "video",
        sources: [{ src: item.url, type: item.mimeType || "video/mp4" }],
        controls: true,
        playsInline: true,
        preload: "metadata",
      };

  const slideStyle = {
    "--message-lightbox-video-width": VIDEO_DISPLAY_WIDTH_CSS,
  } as CSSProperties;

  return <Lightbox
    key={`${item.url}:${attempt}`}
    open
    close={onClose}
    index={0}
    slides={[slide]}
    plugins={PLUGINS}
    className="message-lightbox"
    carousel={{
      finite: true,
      padding: 24,
      spacing: 0,
      preload: 0,
      imageFit: "contain",
      imageProps: () => {
        if (!dimensions || dimensions.width >= IMAGE_DISPLAY_WIDTH) return {};
        return { style: { width: IMAGE_DISPLAY_WIDTH_CSS, height: "auto" } };
      },
    }}
    toolbar={{ buttons: ["zoom", "fullscreen", "close"] }}
    controller={{ closeOnBackdropClick: true, closeOnEscape: true, aria: true }}
    zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true, doubleClickMaxStops: 2 }}
    video={{ controls: true, playsInline: true, preload: "metadata" }}
    fullscreen={{ auto: false }}
    labels={{
      Close: "关闭",
      "Zoom in": "放大",
      "Zoom out": "缩小",
      "Enter Fullscreen": "全屏",
      "Exit Fullscreen": "退出全屏",
      Previous: "上一张",
      Next: "下一张",
      Slide: "媒体",
      Carousel: "媒体列表",
      Lightbox: "媒体预览",
      "Photo gallery": "媒体预览",
      "{index} of {total}": "{index} / {total}",
    }}
    render={{
      slide: ({ slide, offset, rect }) => isImageSlide(slide)
        ? <ProjectedImageSlide slide={slide} offset={offset} rect={rect} />
        : null,
      slideContainer: ({ children }) => <div ref={slideRef} className="message-lightbox-slide" style={slideStyle}>{children}</div>,
      slideHeader: () => <div className="message-lightbox-meta">
        <strong title={item.name}>{item.name}</strong>
        <small>{kindLabel} · {sourceText}</small>
      </div>,
      controls: () => videoFailed
        ? <div className="message-lightbox-error" role="alert">
            <span>视频加载失败，可能已过期</span>
            <button type="button" onClick={retry}>重新加载</button>
          </div>
        : null,
      iconError: () => <button type="button" className="message-lightbox-error-button" onClick={retry}>
        图片加载失败，可能已过期。点击重新加载
      </button>,
    }}
    on={{
      exiting: () => releaseVideoElement(videoRef.current),
      exited: () => {
        if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
      },
    }}
  />;
}
