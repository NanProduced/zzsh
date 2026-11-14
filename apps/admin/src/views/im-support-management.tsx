"use client";

/**
 * 客服管理入口：看板在 im-support-statistics.tsx，只读巡视在 im-support-management-patrol.tsx。
 * 本文件保留子页切换，并继续导出原来的入口组件与请求类型。
 */
import { useState } from "react";
import { SupportDashboard } from "./im-support-statistics";
export { SupportDashboard } from "./im-support-statistics";
import { SupportAssistantSettings } from "./im-support-settings";
import { SupportPatrol } from "./im-support-management-patrol";
export { SupportPatrol } from "./im-support-management-patrol";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

export type SupportManagementRequest = <T>(
  path: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST" | "PUT" | "DELETE",
) => Promise<T>;

/* ------------------------------ 入口 ------------------------------ */

export function SupportManagementPane({ active, request, canTakeover, canConfigure = false, canConfigureIntegration = false, currentAdminUserId, currentAdminName, onOpenConsultation, onOpenProfile, demo = false, onDirtyChange, onWriteLockChange }: {
  active: boolean;
  request: SupportManagementRequest;
  canTakeover?: boolean;
  canConfigure?: boolean;
  canConfigureIntegration?: boolean;
  onDirtyChange?: (dirty:boolean)=>void;
  onWriteLockChange?: (locked:boolean)=>void;
  currentAdminUserId?: string;
  currentAdminName?: string;
  onOpenConsultation?: () => void;
  onOpenProfile?: (userId: string) => void;
  demo?: boolean;
}) {
  const [page, setPage] = useState<"dashboard" | "patrol" | "settings">("dashboard");
  return <div className="im-wb-mgmt" data-page={page}>
    <Tabs value={page} onValueChange={(value) => setPage(value === "patrol" || value === "settings" ? value : "dashboard")} className="im-wb-mgmt-tabs">
      <div className="im-wb-mgmt-head"><TabsList aria-label="客服管理子页"><TabsTrigger value="dashboard">看板</TabsTrigger><TabsTrigger value="patrol">巡视</TabsTrigger><TabsTrigger value="settings">助手设置</TabsTrigger></TabsList>{demo ? <Badge variant="outline">本地演示数据</Badge> : null}</div>
      <TabsContent value="dashboard" className="im-wb-mgmt-content im-wb-mgmt-content--scroll"><SupportDashboard active={active && page === "dashboard"} request={request} demo={demo} /></TabsContent>
      <TabsContent value="patrol" className="im-wb-mgmt-content im-wb-mgmt-content--fill"><SupportPatrol active={active && page === "patrol"} request={request} canTakeover={canTakeover} currentAdminUserId={currentAdminUserId} currentAdminName={currentAdminName} onOpenConsultation={onOpenConsultation} onOpenProfile={onOpenProfile} /></TabsContent>
      <TabsContent value="settings" keepMounted className="im-wb-mgmt-content im-wb-mgmt-content--scroll"><SupportAssistantSettings active={active && page === "settings"} request={request} canConfigure={canConfigure} canConfigureIntegration={canConfigureIntegration} demo={demo} onDirtyChange={onDirtyChange} onWriteLockChange={onWriteLockChange}/></TabsContent>
    </Tabs>
  </div>;
}
