import { ServiceShell } from "@/components/layout/service-shell";
import { SupportLanding } from "@/components/support/support-landing";
import "@/components/layout/functional-shell.css";

export default function Page() {
  return <ServiceShell title="联系客服" description="选择咨询类型后开始站内咨询；登录账号会自动保留记录。"><SupportLanding /></ServiceShell>;
}
