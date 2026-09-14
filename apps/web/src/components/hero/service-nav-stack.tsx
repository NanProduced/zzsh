import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ContactPopover } from "../support/contact-popover";

export function ServiceNavStack() {
  return (
    <nav className="od3-service-stack" aria-label="服务类目">
      <Link href="/accounts" className="od3-item">
        <span className="od3-icon-badge"><img className="service-relief-icon" src="/images/service-icons/rent.webp" width={44} height={44} alt="" draggable={false} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">租账号</span>
          </span>
          <span className="od3-desc"><span>海量账号</span>{" "}<span>真实可靠</span></span>
        </span>
        <ChevronRight className="od3-arrow" aria-hidden="true" />
      </Link>
      <Link href="/publish" className="od3-item">
        <span className="od3-icon-badge"><img className="service-relief-icon" src="/images/service-icons/publish.webp" width={44} height={44} alt="" draggable={false} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">上架出租</span>
          </span>
          <span className="od3-desc"><span>洲洲护航</span>{" "}<span>安全交易</span></span>
        </span>
        <ChevronRight className="od3-arrow" aria-hidden="true" />
      </Link>
      <Link href="/publish?mode=fast" className="od3-item">
        <span className="od3-icon-badge"><img className="service-relief-icon" src="/images/service-icons/fast.webp" width={44} height={44} alt="" draggable={false} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">极速出租</span>
          </span>
          <span className="od3-desc"><span>加速比例</span>{" "}<span>快速上架</span></span>
        </span>
        <ChevronRight className="od3-arrow" aria-hidden="true" />
      </Link>
      <ContactPopover kind="escort" className="od3-item">
        <span className="od3-icon-badge"><img className="service-relief-icon" src="/images/service-icons/escort.webp" width={44} height={44} alt="" draggable={false} /></span>
        <span className="od3-text">
          <span className="od3-title-row">
            <span className="od3-title">护航代肝</span>
          </span>
          <span className="od3-desc"><span>自营俱乐部</span>{" "}<span>专业服务</span></span>
        </span>
        <ChevronRight className="od3-arrow" aria-hidden="true" />
      </ContactPopover>
    </nav>
  );
}
