"use client";
import { ServiceShell } from "./layout/service-shell";
export { AccountWorkspace, PublishForm } from "./supply-workspaces";

export function HelpPage() {
  return <ServiceShell title="帮助中心" description="了解租号、费用与上架要求。"><div className="help-page-content">
    <article id="rental-guide"><h2>租号流程</h2><p>选号并确认条件，付款后由真人客服在每单独立群协助履约。双方确认交付后起租。</p></article>
    <article id="billing-guide"><h2>费用与租期</h2><p>按哈夫币及指定物资消耗计费。资源费用与押金分别列明，每日消耗档位用于推算租期。</p><p>新单实际消耗价值达到本单计费总额70%时正常结算；低于门槛时，平台收取完整消耗下的全部平台利润，号主按实际消耗结算。最终费用以下单确认为准。</p></article>
    <article id="publish-guide"><h2>发布须知</h2><p>准备账号资源说明与公开截图。号主申报、资料审核不等于登录验号。</p><p>当前可查看上架表单，暂不接受在线提交。</p></article>
    <article id="protection"><h2>未成年人禁止消费</h2><p>理性游戏，守护成长。</p></article>
  </div></ServiceShell>;
}
