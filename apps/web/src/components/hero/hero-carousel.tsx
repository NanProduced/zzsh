"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
type DefaultSlide = { kind: "default"; title: ReactNode; text: string; button: string; href: string; poster: string; subtitle?: string; label: string };
type ApiSlide = { kind: "api"; id: string; title: string; description: string | null; linkUrl: string | null; label: string; mediaUrl: string };
type Slide = DefaultSlide | ApiSlide;
const DEFAULT_SLIDES: DefaultSlide[] = [
  { kind: "default", title: <>三角洲行动<br/><span>资源账号租赁</span></>, text: "按消耗计费 · 真人客服协助履约", button: "浏览三角洲资源账号", href: "#delta-section", poster:"delta", label:"三角洲资源账号租赁" },
  { kind: "default", title: <>未成年人<br/><span>禁止消费</span></>, text: "理性游戏 · 守护成长", button: "了解平台规则", href: "/help#protection", poster:"protection", label:"未成年人保护" },
  { kind: "default", title: <>海量账号<br/><span>真实可靠</span></>, text: "洲洲商行 · 游戏账号服务", button: "浏览资源账号", href: "#delta-section", poster:"accounts", subtitle:"洲洲商行 · 游戏账号服务", label:"洲洲商行" },
  { kind: "default", title: <>账号交易<br/><span>即将上线</span></>, text: "打造属于您的游戏专属集市", button: "了解交易服务", href: "", poster:"market", label:"账号交易预告" },
  { kind: "default", title: <>邀好友注册<br/><span>交易返现5%</span></>, text: "2元即可提现", button: "查看邀请活动", href: "", poster:"invite", label:"邀请好友活动" },
];
function parseApiSlide(value: unknown): ApiSlide | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl : "";
  if (!id || !title || !mediaUrl.startsWith("/api/content/media/")) return null;
  const description = typeof record.description === "string" && record.description.trim() ? record.description : null;
  const linkUrl = typeof record.linkUrl === "string" && record.linkUrl.startsWith("/") && !record.linkUrl.startsWith("//") ? record.linkUrl : null;
  const imageAlt = typeof record.imageAlt === "string" && record.imageAlt.trim() ? record.imageAlt.trim() : title;
  return { kind: "api", id, title, description, linkUrl, label: imageAlt, mediaUrl };
}
export function HeroCarousel() {
  const [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [current, setCurrent] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [visible,setVisible]=useState(true);
  const [apiSlides,setApiSlides]=useState<ApiSlide[]|null>(null);
  useEffect(()=>{const update=()=>setVisible(!document.hidden);document.addEventListener("visibilitychange",update);return()=>document.removeEventListener("visibilitychange",update);},[]);
  useEffect(()=>{
    const controller=new AbortController();
    (async()=>{
      try{
        const response=await fetch("/api/content/carousel?slot=HOME_HERO",{cache:"no-store",signal:controller.signal,headers:{accept:"application/json"}});
        if(!response.ok)return;
        const payload=await response.json() as {items?:unknown};
        const items=Array.isArray(payload.items)?payload.items.map(parseApiSlide).filter((slide):slide is ApiSlide=>slide!==null):[];
        if(items.length>0)setApiSlides(items);
      }catch{/* The default brand slides stay in place when the public carousel is unreachable. */}
    })();
    return()=>controller.abort();
  },[]);
  const [viewport, api] = useEmblaCarousel({ loop: true, duration: reduced ? 0 : 25, watchFocus: false });
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReduced(media.matches);
      if (media.matches) setPlaying(false);
    };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
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
  // Rebuild only when the slide set actually arrives/changes (never on first
  // mount): reInit alone preserves the old engine index (Embla reActivate keeps
  // selectedScrollSnap as startIndex), which can also be out of the new range.
  // Actually move the engine to the first slide, then mirror the engine's truth
  // into React so aria-hidden/inert/dots all point at the same slide.
  const slideSetMounted = useRef(false);
  useEffect(() => {
    if (!api) return;
    if (!slideSetMounted.current) {
      slideSetMounted.current = true;
      return;
    }
    api.reInit?.();
    api.scrollTo(0, true);
    setCurrent(api.selectedScrollSnap());
  }, [api, slides]);
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
      {slides.map((slide, index) => <div key={slide.kind === "api" ? slide.id : index} className={`hero-slide hero-slide-${index}`}
        role="group" aria-roledescription="幻灯片" aria-label={`${slide.label}，${index + 1} / ${slides.length}`}
        aria-hidden={index !== current} inert={index !== current}>
        <div className="hero-scene" aria-hidden="true"><img className="poster-sheet" src={slide.kind === "api" ? slide.mediaUrl : `/art/zhouzhou/poster-${slide.poster}.webp`} srcSet={slide.kind === "default" ? posterSrcSet(slide.poster) : undefined} sizes={slide.kind === "default" ? "(max-width: 599px) 92vw, (max-width: 1023px) 476px, 804px" : undefined} alt="" onError={()=>setImageFailed(true)} ref={image=>{if(image?.complete&&image.naturalWidth===0&&!imageFailed)setImageFailed(true);}}/></div>
        {slide.kind === "default" && slide.subtitle && <p className="poster-subtitle" aria-hidden="true">{slide.subtitle}</p>}
        {slide.kind === "api" && <div className="hero-copy"><h1>{slide.title}</h1>{slide.description && <p>{slide.description}</p>}</div>}
        <p className="sr-only">{slide.title}</p>{slide.kind === "default" && <p className="sr-only">{slide.text}</p>}
        {slide.kind === "api" && slide.description && <p className="sr-only">{slide.description}</p>}
        {((slide.kind === "default" && slide.href) || (slide.kind === "api" && slide.linkUrl)) && <a className="hero-poster-link" href={slide.kind === "api" ? slide.linkUrl! : slide.href} aria-label={slide.kind === "api" ? slide.title : slide.button}/>}
        {imageFailed && <span className="art-failed">装饰图片加载失败</span>}
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
