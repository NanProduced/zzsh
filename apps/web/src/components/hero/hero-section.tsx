import { ServiceNavStack } from "./service-nav-stack";
import { HeroCarousel } from "./hero-carousel";
import { PersonalTaskPanel } from "./personal-task-panel";
export function HeroSection() {
  return <section className="portal-width hero-section" aria-label="平台服务与指南">
    <div className="hero-grid">
      <div className="hero-services"><ServiceNavStack /></div>
      <div className="hero-main"><HeroCarousel /></div>
      <div className="hero-personal"><PersonalTaskPanel /></div>
    </div>
  </section>;
}
