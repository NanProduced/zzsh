"use client";
import { useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
export function HeroCarousel() {
  const [reduced, setReduced] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [current, setCurrent] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [visible,setVisible]=useState(true);
  useEffect(()=>{const update=()=>setVisible(!document.hidden);document.addEventListener("visibilitychange",update);return()=>document.removeEventListener("visibilitychange",update);},[]);
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
  useEffect(() => {
    if (!api || !autoPlaying) return;
    const timer = setInterval(() => api.scrollNext(), 5500);
    return () => clearInterval(timer);
  }, [api, autoPlaying]);
  const move = (direction: number) => {
    setPlaying(false);
    if (direction < 0) api?.scrollPrev(reduced); else api?.scrollNext(reduced);
  };
  const slides = [
    { title: <>未成年人<br/><span>禁止消费</span></>, text: "理性游戏 · 守护成长", button: "了解平台规则", href: "/help#protection", art:"sage.png", poster:"protection", agent:"sage", label:"未成年人保护" },
    { title: <>海量账号<br/><span>真实可靠</span></>, text: "洲洲商行 · 游戏账号服务", button: "浏览资源账号", href: "#delta-section", art:"d-wolf.jpg", poster:"accounts", agent:"d-wolf", label:"洲洲商行" },
    { title: <>账号交易<br/><span>即将上线</span></>, text: "打造属于您的游戏专属集市", button: "了解交易服务", href: "", art:"jett.png", poster:"market", agent:"jett", label:"账号交易预告" },
    { title: <>邀好友注册<br/><span>交易返现5%</span></>, text: "2元即可提现", button: "查看邀请活动", href: "", art:"ahri.png", poster:"invite", agent:"ahri", label:"邀请好友活动" },
  ];
  return <div className="hero-carousel" role="region" aria-roledescription="轮播" aria-label="平台指南轮播"
    tabIndex={0} data-current-slide={current + 1} data-autoplay={autoPlaying}
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
      {slides.map((slide, index) => <div key={index} className={`hero-slide hero-slide-${index}`}
        role="group" aria-roledescription="幻灯片" aria-label={`${slide.label}，${index + 1} / 4`}
        aria-hidden={index !== current} inert={index !== current}>
        <div className="hero-scene" aria-hidden="true"><img className="poster-sheet" src={`/art/poster-${slide.poster}.png`} alt="" onError={()=>setImageFailed(true)} ref={image=>{if(image?.complete&&image.naturalWidth===0&&!imageFailed)setImageFailed(true);}}/></div>
        <div className={`hero-character-shell agent-${slide.agent}`} aria-hidden="true">
          <img className="hero-character" src={`/art/agents/${slide.art}`} alt=""
            ref={(image) => { if (image?.complete && image.naturalWidth === 0) { image.style.visibility = "hidden"; if (!imageFailed) setImageFailed(true); } }}
            onError={(event) => { event.currentTarget.style.visibility = "hidden"; setImageFailed(true); }} />
        </div>
        <p className="sr-only">{slide.title}</p><p className="sr-only">{slide.text}</p>
        {slide.href && <a className="hero-poster-link" href={slide.href} aria-label={slide.button}/>}
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
