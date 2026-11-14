import { Clock3, Info, MessageSquare, ShoppingBag, Users, Webhook } from "lucide-react";

export type SceneGroup = "welcome" | "reception" | "orders" | "reminders" | "integration";
export type SceneStatus = "editable" | "builtin" | "policy";
export type FieldKey = "serviceMessage" | "complaintMessage";
export type Scene = {
  key: string;
  group: Exclude<SceneGroup, "integration">;
  label: string;
  when: string;
  sender: string;
  note: string;
  status: SceneStatus;
  field?: FieldKey;
  buckets?: readonly string[];
};

const DUE_BUCKETS = ["到期前 24 小时", "订单已到期", "超期 1 天", "超期 2 天", "超期 3 天"] as const;

export const SCENES: readonly Scene[] = [
  { key: "SERVICE_WELCOME", group: "welcome", label: "在线咨询欢迎消息", when: "新一轮在线咨询创建并完成建群后", sender: "洲洲助手（系统）", note: "只在新轮次开场发送；当前接待中的轮次沿用原消息。", status: "editable", field: "serviceMessage" },
  { key: "COMPLAINT_WELCOME", group: "welcome", label: "投诉入口欢迎消息", when: "从投诉入口发起新一轮咨询后", sender: "洲洲助手（系统）", note: "投诉使用独立持久线程；不另建工单或投诉群。", status: "editable", field: "complaintMessage" },
  { key: "QUEUE_NO_STAFF", group: "reception", label: "暂无可用客服", when: "用户已留言，自动派单没有合格候选", sender: "洲洲助手（系统）", note: "每轮最多一次；发送失败不会反复重试。", status: "builtin" },
  { key: "QUEUE_BUSY", group: "reception", label: "客服繁忙排队（已停用）", when: "历史上客服在线但均已满载时使用", sender: "洲洲助手（系统）", note: "业务不设客服接待硬上限，当前不会再触发；保留历史说明。", status: "builtin" },
  { key: "AGENT_GREETING", group: "reception", label: "客服接入问候", when: "自动分配或手动接入成功，客服成为本轮接待人", sender: "接待客服身份（系统代发）", note: "客服名称由服务端填入；不代表客服已手动输入首条回复。", status: "builtin" },
  { key: "TRANSFER_RECEIVED", group: "reception", label: "转交成功提示", when: "转交完成并确认新的接待客服后", sender: "洲洲助手（系统）", note: "只用于主动转交；新客服名称由服务端填入。", status: "builtin" },
  { key: "ORDER_WELCOME", group: "orders", label: "订单群欢迎", when: "付款后订单群准备就绪，且群内还没有更早的发言", sender: "洲洲助手（系统）", note: "群内已有沟通时跳过晚到的欢迎；每个订单阶段只发一次。", status: "builtin" },
  { key: "ORDER_OPENING", group: "orders", label: "开租确认", when: "订单进入开租核对阶段", sender: "洲洲助手（系统）", note: "引导核对账号与订单；通知本身不代表双方已确认。", status: "builtin" },
  { key: "ORDER_ENDING", group: "orders", label: "结束确认", when: "订单进入结束核对阶段", sender: "洲洲助手（系统）", note: "引导双方核对结束信息；不会自动结束订单。", status: "builtin" },
  { key: "ORDER_SETTLED", group: "orders", label: "结算完成", when: "平台确认订单已结算，且仍在结算后沟通窗口内", sender: "洲洲助手（系统）", note: "结算时间由订单填入；不代表退款已到账。", status: "builtin" },
  { key: "ORDER_CANCELLED", group: "orders", label: "订单已取消", when: "订单取消且订单群已就绪；每个订单只发一次", sender: "洲洲助手（系统）", note: "退款状态只对租客展示；不承诺渠道到账时间。", status: "builtin" },
  { key: "DUE_REMINDERS", group: "reminders", label: "租期到期提醒", when: "开租已确认、订单仍在租用，并到达对应提醒节点", sender: "洲洲助手（系统）", note: "到期时间由订单计算；进入结束或结算后停止提醒。", status: "builtin", buckets: DUE_BUCKETS },
  { key: "ESCALATION_WAIT", group: "reminders", label: "补派安抚", when: "部署显式开启首响补派后，订单仍在等待人工接待", sender: "洲洲群主助手（系统）", note: "是否发送取决于部署策略；本页只读，不提供启用开关。", status: "policy" },
];

export const scenarioCount = (scenes: readonly Scene[]) => scenes.reduce((total, scene) => total + (scene.buckets?.length ?? 1), 0);
const groupCount = (group: Scene["group"]) => scenarioCount(SCENES.filter((scene) => scene.group === group));
export const WELCOME_FIELDS = SCENES.filter((scene): scene is Scene & { field: FieldKey } => scene.group === "welcome" && Boolean(scene.field));

export const GROUPS: { id: SceneGroup; title: string; hint: string; description: string; icon: typeof Info }[] = [
  { id: "welcome", title: "咨询开场", hint: `${groupCount("welcome")} 条欢迎可编辑`, description: "只在新一轮咨询建群后发送；保存不重发历史。", icon: MessageSquare },
  { id: "reception", title: "接待通知", hint: `${groupCount("reception")} 条内置通知`, description: "排队、接入与转交由系统按接待状态触发。", icon: Users },
  { id: "orders", title: "订单通知", hint: `${groupCount("orders")} 条内置通知`, description: "建群、开租、结束、结算和取消通知。", icon: ShoppingBag },
  { id: "reminders", title: "到期与补派", hint: "到期提醒与接待补派", description: "五档到期提醒与补派安抚；时间由订单计算。", icon: Clock3 },
  { id: "integration", title: "阅读状态同步", hint: "云信消息接入", description: "将用户的阅读进度同步到客服会话。", icon: Webhook },
];

export const STATUS: Record<SceneStatus, { label: string; variant: "outline" | "secondary" | "warning" }> = {
  editable: { label: "可编辑", variant: "outline" },
  builtin: { label: "内置规则", variant: "secondary" },
  policy: { label: "按系统设置", variant: "warning" },
};

export const GROUP_FOOTER: Partial<Record<SceneGroup, string>> = {
  reception: "这些通知由系统按接待状态自动发送；客服接入问候使用接待客服身份，不代表客服已手动回复。",
  orders: "订单状态、金额、过账时间和到账判断由业务事实生成，不在此页编辑。",
  reminders: "到期时间由订单计算；补派安抚是否发送取决于部署策略，本页不提供开关。",
};
