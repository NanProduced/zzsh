import { BookOpen, Coins, Folder, Headphones, KeyRound, Megaphone, ScrollText, Shield, Store, Ticket } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HelpTreeNode } from "./docs/docs-help-api";

const groupIcons = {
  folder: { label: "文件夹", Icon: Folder },
  rental: { label: "租用", Icon: Ticket },
  publish: { label: "出租", Icon: Store },
  fees: { label: "费用", Icon: Coins },
  account: { label: "账号", Icon: KeyRound },
  "after-sale": { label: "客服", Icon: Headphones },
  membership: { label: "动态", Icon: Megaphone },
  agreement: { label: "协议", Icon: ScrollText },
  book: { label: "手册", Icon: BookOpen },
  shield: { label: "安全", Icon: Shield },
};
const groupIconOptions = [{ value: "", label: "默认图标" }, ...Object.entries(groupIcons).map(([value, { label }]) => ({ value, label }))];

export function groupIcon(key: string | null | undefined) {
  return key && Object.hasOwn(groupIcons, key) ? groupIcons[key as keyof typeof groupIcons].Icon : Folder;
}

export function HelpIconSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <label className="docs-move-field">
      <span>分组图标</span>
      <Select value={value} items={groupIconOptions} onValueChange={next => onChange(next ?? "")} disabled={disabled}>
        <SelectTrigger aria-label="分组图标"><SelectValue /></SelectTrigger>
        <SelectContent>{groupIconOptions.map(option => {
          const Icon = groupIcon(option.value);
          return <SelectItem key={option.value} value={option.value}><Icon size={15} aria-hidden="true" />{option.label}</SelectItem>;
        })}</SelectContent>
      </Select>
    </label>
  );
}

export const displayTitle = (node: HelpTreeNode): string => node.title || node.resourceKey?.slice("guide:".length) || "未命名文章";
