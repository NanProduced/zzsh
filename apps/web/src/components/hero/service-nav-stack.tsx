import Link from "next/link";
import { Gamepad2, Upload, Zap, Shield, ArrowUpRight } from "lucide-react";
import { ContactPopover } from "../support/contact-popover";

export function ServiceNavStack() {
  return (
    <nav className="od3-service-stack" aria-label="服务类目">
      <Link href="/accounts" className="od3-item od3-primary-card">
        <span className="od3-corner-bracket" />
        <span className="od3-hud-meta">ID//ZZSH-01</span>
        <span className="od3-icon-badge"><Gamepad2 size={18} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">租账号</span>
            <span className="od3-telemetry">查看号源</span>
          </span>
          <span className="od3-desc">按游戏与资源挑选账号</span>
        </span>
        <ArrowUpRight className="od3-arrow" />
      </Link>
      <Link href="/publish" className="od3-item">
        <span className="od3-corner-bracket" />
        <span className="od3-hud-meta">ID//ZZSH-02</span>
        <span className="od3-icon-badge"><Upload size={18} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">上架出租</span>
          </span>
          <span className="od3-desc">填写资源与出租条件</span>
        </span>
        <ArrowUpRight className="od3-arrow" />
      </Link>
      <Link href="/publish?mode=fast" className="od3-item">
        <span className="od3-corner-bracket" />
        <span className="od3-hud-meta">ID//ZZSH-03</span>
        <span className="od3-icon-badge"><Zap size={18} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">极速出租</span>
          </span>
          <span className="od3-desc">固定极速比例上架</span>
        </span>
        <ArrowUpRight className="od3-arrow" />
      </Link>
      <ContactPopover kind="escort" className="od3-item">
        <span className="od3-corner-bracket" />
        <span className="od3-hud-meta">SEC//COMMS-04</span>
        <span className="od3-icon-badge"><Shield size={18} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">护航代肝</span>
          </span>
          <span className="od3-desc">微信咨询 · 了解服务安排</span>
        </span>
        <span className="od3-signal-bar">▂▄▆█</span>
      </ContactPopover>
    </nav>
  );
}
