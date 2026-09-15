import Link from "next/link";
const benefits = [
  { title: "按需选号", word: "选号", lines: ["浏览资源配置与租用条件", "选择适合自己的三角洲账号"], href: "/accounts", art: "select" },
  { title: "透明计费", word: "计费", lines: ["按资源消耗计费", "费用构成与租期规则清晰呈现"], href: "/help#billing-guide", art: "billing" },
  { title: "专人协助", word: "协助", lines: ["真人客服对接", "协助完成账号交付与租赁流程"], href: "/help#rental-guide", art: "service" },
];
export function ServiceBenefits() {
  return <nav className="portal-width service-benefits" aria-label="租赁服务介绍">
    {benefits.map(item => <Link className="service-benefit" href={item.href} key={item.art}>
      <span className="benefit-word" aria-hidden="true">{[...item.word].map((letter, index) => <span key={index}>{letter}</span>)}</span>
      <img className="benefit-art" src={`/art/zhouzhou/cta-${item.art}.webp`} alt="" width={140} height={140} aria-hidden="true" />
      <span className="benefit-copy"><strong>{item.title}</strong><span>{item.lines[0]}<br/>{item.lines[1]}</span></span>
    </Link>)}
  </nav>;
}
