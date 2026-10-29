"use client";
import { useEffect, useState, type ReactNode } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePublicContent } from "../content/public-content-provider";
type DefaultSlide = { kind: "default"; id: string; title: ReactNode; text: string; button: string; href: string; poster: string; subtitle?: string; label: string };
type ApiSlide = Omit<DefaultSlide, "kind"> & { kind: "api"; mobileLabel: string; mediaUrl: string; mobileMediaUrl: string | null };
type Slide = DefaultSlide | ApiSlide;
const DEFAULT_SLIDES: DefaultSlide[] = [
  { kind: "default", id: "delta", title: <>三角洲行动<br/><span>资源账号租赁</span></>, text: "按消耗计费 · 真人客服协助履约", button: "浏览三角洲资源账号", href: "#delta-section", poster:"delta", label:"三角洲资源账号租赁" },
  { kind: "default", id: "protection", title: <>未成年人<br/><span>禁止消费</span></>, text: "理性游戏 · 守护成长", button: "了解平台规则", href: "/help#protection", poster:"protection", label:"未成年人保护" },
  { kind: "default", id: "accounts", title: <>海量账号<br/><span>真实可靠</span></>, text: "洲洲商行 · 游戏账号服务", button: "浏览资源账号", href: "#delta-section", poster:"accounts", subtitle:"洲洲商行 · 游戏账号服务", label:"洲洲商行" },
];
export function HeroCarousel() {
  const [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [current, setCurrent] = useState(0);
  const [imageFailed, setImageFailed] = useState<Record<string, boolean>>({});
  const [mobileFailed, setMobileFailed] = useState<Record<string, boolean>>({});
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [visible,setVisible]=useState(true);
  const [apiSlides,setApiSlides]=useState<Slide[]|null>(null);
  const [narrow, setNarrow] = useState(false);
  const { resource } = usePublicContent("placement:HOME_HERO");
  useEffect(()=>{const update=()=>setVisible(!document.hidden);document.addEventListener("visibilitychange",update);return()=>document.removeEventListener("visibilitychange",update);},[]);
  useEffect(()=>{
    const payload = resource?.payload;
    if (payload?.kind !== "carousel") { setApiSlides(null); return; }
    const items: Slide[] = DEFAULT_SLIDES.map(slide => {
      const binding = payload.slides.find(value => value.id === slide.id);
      const mediaUrl = binding?.mediaId ? resource?.media.find(value => value.id === binding.mediaId)?.url : null;
      if (!mediaUrl) return slide;
      const mobileMediaUrl = binding?.mobileMediaId ? resource?.media.find(value => value.id === binding.mobileMediaId)?.url ?? null : null;
      return { ...slide, kind: "api", mediaUrl, mobileMediaUrl, mobileLabel: slide.label };
    });
    setApiSlides(items.some(slide => slide.kind === "api") ? items : null);
  },[resource]);
  const [viewport, api] = useEmblaCarousel({ loop: true, duration: reduced ? 0 : 25, watchFocus: false });
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const mobile = matchMedia("(max-width: 599px)");
    const update = () => {
      setReduced(media.matches);
      setNarrow(mobile.matches);
      if (media.matches) setPlaying(false);
    };
    update(); media.addEventListener("change", update); mobile.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); mobile.removeEventListener("change", update); };
  }, []);
  useEffect(() => {
    if (!api) return;
    const select = () => setCurrent(api.selectedScrollSnap());
    const stop = () => setPlaying(false);
    api.on("select", select); api.on("pointerDown", stop); select();
    return () => { api.off("select", select); api.off("pointerDown", stop); };
  }, [api]);
  const autoPlaying = playing && !reduced && !hovered && !focused && visible;
  const slides: Slide[] = apiSlides ?? DEFAULT_SLIDES;
  // 位置、数量和顺序固定，换图不重置用户当前查看的幻灯片。
  useEffect(() => {
    if (!api || !autoPlaying) return;
    const timer = setInterval(() => api.scrollNext(), 5500);
    return () => clearInterval(timer);
  }, [api, autoPlaying]);
  const move = (direction: number) => {
    setPlaying(false);
    if (direction < 0) api?.scrollPrev(reduced); else api?.scrollNext(reduced);
  };
  const posterSrcSet = (poster: string) => `/art/zhouzhou/poster-${poster}@810.webp 810w, /art/zhouzhou/poster-${poster}@1215.webp 1215w, /art/zhouzhou/poster-${poster}.webp 1900w`;
  return <div className="hero-carousel" role="region" aria-roledescription="轮播" aria-label="平台指南轮播"
    tabIndex={0} data-current-slide={current + 1} data-autoplay={autoPlaying} data-source={apiSlides ? "api" : "default"}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => { setFocused(true); setPlaying(false); }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1);
      }
    }}>
    <div className="hero-viewport" ref={viewport}><div className="hero-track">
      {slides.map((slide, index) => <div key={slide.id} className={`hero-slide hero-slide-${index}`}
        role="group" aria-roledescription="幻灯片" aria-label={`${slide.kind === "api" && narrow && slide.mobileMediaUrl && !mobileFailed[slide.id] ? slide.mobileLabel : slide.label}，${index + 1} / ${slides.length}`}
        aria-hidden={index !== current} inert={index !== current}>
        <div className="hero-scene" aria-hidden="true"><picture>
          {slide.kind === "api" && !imageFailed[slide.mediaUrl] && slide.mobileMediaUrl && !mobileFailed[slide.id] ? <source media="(max-width: 599px)" srcSet={slide.mobileMediaUrl} /> : null}
          <img className="poster-sheet" src={slide.kind === "api" && !imageFailed[slide.mediaUrl] ? slide.mediaUrl : `/art/zhouzhou/poster-${slide.poster}.webp`} srcSet={slide.kind === "default" || imageFailed[slide.kind === "api" ? slide.mediaUrl : ""] ? posterSrcSet(slide.poster) : undefined} sizes={slide.kind === "default" || imageFailed[slide.kind === "api" ? slide.mediaUrl : ""] ? "(max-width: 599px) 92vw, (max-width: 1023px) 476px, 804px" : undefined} alt="" onError={() => {
            if (slide.kind === "api" && slide.mobileMediaUrl && !mobileFailed[slide.id] && window.matchMedia("(max-width: 599px)").matches) setMobileFailed(value => ({ ...value, [slide.id]: true }));
            else if (slide.kind === "api") setImageFailed(value => ({ ...value, [slide.mediaUrl]: true }));
          }} />
        </picture></div>
        {slide.subtitle && <p className="poster-subtitle" aria-hidden="true">{slide.subtitle}</p>}
        <p className="sr-only">{slide.title}</p><p className="sr-only">{slide.text}</p>
        <a className="hero-poster-link" href={slide.href} aria-label={slide.button}/>
      </div>)}
    </div></div>
    <button className="carousel-arrow carousel-prev" aria-label="上一张幻灯片" onClick={()=>move(-1)}><ChevronLeft size={18} aria-hidden="true"/></button>
    <button className="carousel-arrow carousel-next" aria-label="下一张幻灯片" onClick={()=>move(1)}><ChevronRight size={18} aria-hidden="true"/></button>
    <div className="carousel-controls" aria-label="轮播控制">
      {slides.map((_, index) => <button key={index} className="slide-index" aria-label={`切换到幻灯片 ${index + 1}`}
        aria-current={index === current ? "true" : undefined}
        onClick={() => { setPlaying(false); api?.scrollTo(index, reduced); }}><span /></button>)}
    </div>
  </div>;
}
