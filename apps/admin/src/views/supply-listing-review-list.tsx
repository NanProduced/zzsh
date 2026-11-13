import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { ListPagination, ListToolbar, ListToolbarSearch, ListToolbarEnumSelect } from "@/components/admin-list";
import { AccountCards, AccountFees, AccountIdentity, AccountResources, AccountTerms, KindHint, KindSelect, MoreFilters, QuickView, ReasonCell, RowActions, SavedViewsMenu, StatusBadge, TimeText, useSavedViews } from "./supply-accounts/account-list-parts";
import { KIND_LABELS, LOGIN_METHOD_OPTIONS, rowBaseFeeRows, rowTermsLines } from "./supply-accounts/account-list-model";
import { ACCOUNT_BUSINESS_STATES, supplyObjectLabel, type SupplyQueryKind, type SupplyWorkItem, type SupplyWorkPage, type SupplyWorkView } from "./supply-review/model";

export const views = [["all", "全部账号"], ["restricted", "运营限制"], ["orders", "有关联订单"]] as const;
export const activeView = (view: SupplyWorkView): SupplyWorkView => views.some(([value]) => value === view) ? view : "all";
export type Filter = {
    view: SupplyWorkView;
    kind: SupplyQueryKind;
    q: string;
    gameId: string;
    status: import("./supply-review/model").AccountBusinessState | "";
    eligibility: string;
    source: string;
    haffMin: string;
    haffMax: string;
    depositMin: string;
    depositMax: string;
    loginMethod: string;
    limit: string;
    cursor: string;
};

export function SupplyListingList({ viewport, reloadList, filter, positions, identity, setStack, setQuick, setFilter, onQueryChange, mobile, filtersOpen, setFiltersOpen, submitSearch, resetFilters, draftKind, setDraftKind, draftQ, setDraftQ, listBusy, savedViews, page, applyFilter, queryError, setQueryError, listNotice, listError, broaderMatch, viewRow, rowOwnerTarget, open, quick, stack, quickRow, openFull, can, quickOrigin }: {
  viewport: RefObject<HTMLDivElement | null>;
  quickOrigin: RefObject<HTMLElement | null>;
  reloadList: () => void;
  filter: Filter;
  positions: { delete(key: string): boolean };
  identity: string;
  setStack: Dispatch<SetStateAction<string[]>>;
  setQuick: Dispatch<SetStateAction<string | null>>;
  setFilter: Dispatch<SetStateAction<Filter>>;
  onQueryChange: (query: Record<string, string>) => void;
  mobile: boolean;
  filtersOpen: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  submitSearch: (event: FormEvent) => void;
  resetFilters: () => void;
  draftKind: SupplyQueryKind;
  setDraftKind: Dispatch<SetStateAction<SupplyQueryKind>>;
  draftQ: string;
  setDraftQ: Dispatch<SetStateAction<string>>;
  listBusy: boolean;
  savedViews: ReturnType<typeof useSavedViews>;
  page: SupplyWorkPage | undefined;
  applyFilter: (patch: Partial<Filter>) => void;
  queryError: string | undefined;
  setQueryError: Dispatch<SetStateAction<string | undefined>>;
  listNotice: string | undefined;
  listError: string | undefined;
  broaderMatch: boolean | undefined;
  viewRow: (row: SupplyWorkItem, trigger?: HTMLElement) => void;
  rowOwnerTarget: (row: SupplyWorkItem) => void;
  open: (id: string, title: string, context: string) => void;
  quick: string | null;
  stack: string[];
  quickRow: SupplyWorkItem | undefined;
  openFull: (row: SupplyWorkItem, context: string) => void;
  can: (permission: string) => boolean;
}) {
    const emptyState = <div className="p-8 text-center"><h2 className="text-base font-semibold">当前范围没有匹配账号</h2><p className="mt-1 text-muted-foreground">查询与视图已保留；不代表范围外或全平台没有账号。{filter.view === "restricted" ? "已解除的账号不再匹配运营限制视图，可返回全部账号核对剩余问题。" : ""}</p>{broaderMatch ? <p className="wf-hint">同一线索在“全部账号”视图下有匹配，被当前“{views.find(v => v[0] === filter.view)?.[1]}”视图条件过滤；可切换视图核对。</p> : null}</div>;
        return <div className="sa-page text-sm" ref={viewport}><header className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h1 id="supply-work-title" tabIndex={-1} className="text-2xl leading-9 font-semibold outline-none">出租账号</h1><p className="mt-0.5 text-muted-foreground">管理出租账号资料、上架审核与接单条件</p></div><div className="text-right"><Button variant="outline" size="lg" onClick={reloadList}><RefreshCw size={15}/>刷新列表</Button><p className="mt-2 text-xs text-muted-foreground">仅展示当前授权范围</p></div></header>
 <Tabs value={filter.view} onValueChange={value => { const v = value as SupplyWorkView; positions.delete(identity); setStack([]); setQuick(null); setFilter({ ...filter, view: v, cursor: "" }); onQueryChange({ view: v }); }} className="mb-4"><TabsList aria-label="出租账号工作视图" className="overflow-x-auto gap-5 [&>button]:shrink-0 [&>button]:whitespace-nowrap [&>button]:px-1">{views.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList></Tabs>
 <ListToolbar noValidate className="sa-search" onSubmit={submitSearch} onReset={resetFilters}>
   <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:min-w-[380px]">
     <KindSelect kind={draftKind} onKind={setDraftKind}/>
     <ListToolbarSearch value={draftQ} onChange={setDraftQ} ariaLabel="业务线索" placeholder={draftKind === "owner" ? "输入号主用户 ID 或旧平台 ID 查找" : "输入" + KIND_LABELS[draftKind] + "查找"} />
     <Button type="submit" size="lg" className="px-4" disabled={listBusy}>查找</Button>
     <SavedViewsMenu saved={savedViews} current={{ view: filter.view, kind: draftKind, q: draftQ.trim(), gameId: filter.gameId, status: filter.status, eligibility: filter.eligibility }} onLoad={v => { positions.delete(identity); setStack([]); setDraftKind(v.kind); setDraftQ(v.q); setFilter({ ...filter, view: activeView(v.view), kind: v.kind, q: v.q, gameId: v.gameId, status: v.status ?? "", eligibility: v.eligibility ?? "", cursor: "" }); }}/>
     {draftQ && <Button variant="ghost" type="button" size="lg" className="text-xs text-muted-foreground" onClick={() => { positions.delete(identity); setDraftQ(""); setStack([]); setFilter({ ...filter, q: "", cursor: "" }); setQueryError(undefined); }}>清除线索</Button>}
   </div>
   <Collapsible open={!mobile || filtersOpen} onOpenChange={setFiltersOpen} className="w-full"><CollapsibleTrigger render={<Button type="button" variant="outline" className="md:hidden"/>}>筛选{[filter.gameId,filter.status,filter.eligibility,filter.source,filter.loginMethod,filter.haffMin||filter.haffMax,filter.depositMin||filter.depositMax].filter(Boolean).length ? "（"+[filter.gameId,filter.status,filter.eligibility,filter.source,filter.loginMethod,filter.haffMin||filter.haffMax,filter.depositMin||filter.depositMax].filter(Boolean).length+"）" : ""}</CollapsibleTrigger><CollapsibleContent className="pt-3 md:pt-0"><div className="flex flex-wrap items-center gap-2">
     {page?.games?.length ? <ListToolbarEnumSelect label="游戏" value={filter.gameId} onChange={gameId => applyFilter({ gameId })} options={page.games.map(g => [g.id, g.name] as [string, string])} allLabel="当前范围全部游戏" /> : null}
     <ListToolbarEnumSelect label="账号状态" value={filter.status} onChange={status => applyFilter({ status: status as Filter["status"], eligibility: "" })} options={ACCOUNT_BUSINESS_STATES.map(state => [state.value, state.label] as [string, string])} allLabel="全部状态" />
     <ListToolbarEnumSelect label="账号来源" value={filter.source} onChange={source => applyFilter({ source })} options={[["NEW", "新平台"], ["LEGACY", "旧平台迁入"]]} allLabel="全部来源" />
     <MoreFilters values={filter} loginOptions={page?.filterOptions?.loginMethods?.length ? page.filterOptions.loginMethods : LOGIN_METHOD_OPTIONS} onChange={patch => applyFilter(patch)} />
     <Button type="button" variant="ghost" size="lg" className="text-xs text-muted-foreground" disabled={listBusy} onClick={resetFilters}>重置筛选</Button>
   </div></CollapsibleContent></Collapsible>
 </ListToolbar>
 {filter.eligibility ? <p className="mt-2 text-xs text-muted-foreground" role="status">沿用旧接单资格条件：{filter.eligibility === "ELIGIBLE" ? "可接新单" : filter.eligibility === "BLOCKED" ? "不可接新单" : "资格待核"}<Button type="button" variant="link" size="xs" className="ml-2 px-0" onClick={() => applyFilter({ eligibility: "" })}>清除旧资格条件</Button></p> : null}
 <KindHint q={draftQ} kind={draftKind} onKind={setDraftKind}/>
 {savedViews.notice && <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-400">{savedViews.notice} <Button variant="link" type="button" className="underline" onClick={savedViews.dismiss}>知道了</Button></p>}
 {queryError && <p role="alert" className="mt-1 text-xs text-destructive">{queryError}</p>}{filter.kind === "nickname" && filter.q && <p className="mt-1 text-xs text-muted-foreground">昵称可能重名，请按编号核对主体。</p>}
 <div className="mt-3">
   {listNotice ? <p role="status" className="mb-2 text-xs text-muted-foreground">{listNotice}</p> : null}
   {listError ? (
     <Alert variant="destructive">
       <TriangleAlert aria-hidden />
       <AlertTitle>本次列表未读到</AlertTitle>
       <AlertDescription>{listError}</AlertDescription>
       <AlertAction><Button onClick={reloadList}>重试</Button><Button onClick={() => { positions.delete(identity); setStack([]); setFilter({ ...filter, cursor: "" }); }}>回首页重读</Button></AlertAction>
     </Alert>
   ) : listBusy ? (
     <div className="space-y-2 py-2" aria-busy="true">
       <p className="sr-only">正在读取出租账号…</p>
       {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full"/>)}
     </div>
   ) : (
     <>
       <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
         <Table className="sa-table w-full min-w-[1040px] text-sm">
           <TableHeader>
             <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
               <TableHead className="min-w-[240px] px-3 py-2 text-xs font-normal text-muted-foreground">账号 / 号主</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">核心资源</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">出租条件</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground" title="哈夫币租金与物资预付组成资源费，押金另列；租客实际费用以本人报价为准">基础报价</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">业务状态</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">更新时间</TableHead>
               <TableHead className="w-24 px-3 py-2 text-xs font-normal text-muted-foreground">操作</TableHead>
             </TableRow>
           </TableHeader>
           <TableBody>
             {page?.items.map(row => {
               const label = supplyObjectLabel(row);
               const context = filter.view === "orders" ? "orders" : "situation";
               const terms = rowTermsLines(row), fees = rowBaseFeeRows(row);
               return (
                 <TableRow
                   key={row.id}
                   id={"supply-open-" + row.id}
                   tabIndex={0}
                   aria-label={"快速查看 " + label}
                   onClick={e => viewRow(row, e.currentTarget)}
                   onKeyDown={e => {
                     if (e.target !== e.currentTarget) return;
                     if (e.key === "Enter" || e.key === " ") {
                       e.preventDefault();
                       viewRow(row, e.currentTarget);
                     }
                   }}
                   className={"cursor-pointer border-b border-border align-middle outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:shadow-[inset_3px_0_0_var(--ring)] " + (quick === row.id ? "bg-muted/60 " : "")}
                 >
                   <TableCell className="max-w-[300px] px-3 py-2.5 whitespace-normal"><AccountIdentity row={row} onOpenOwner={rowOwnerTarget}/></TableCell>
                   <TableCell className="max-w-[310px] px-3 py-3 whitespace-normal text-xs"><AccountResources row={row}/></TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal text-xs text-muted-foreground">
                     <AccountTerms row={row}/>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal text-xs tabular-nums">
                     <AccountFees row={row}/>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal">
                     <StatusBadge facts={row.facts} reviewState={row.reviewState}/>
                     <div className="mt-1 text-xs"><ReasonCell facts={row.facts} onMore={() => viewRow(row)}/></div>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 text-muted-foreground">
                     {row.accountUpdatedAt ? <TimeText iso={row.accountUpdatedAt} label="账号更新时间"/> : <span className="text-xs">未提供</span>}
                   </TableCell>
                   <TableCell className="w-24 px-2 py-2">
                     <RowActions row={row} onFull={() => open(row.id, label, context)}/>
                   </TableCell>
                 </TableRow>
               );
             })}
             {!page?.items.length && (
               <TableRow>
                 <TableCell colSpan={7}>{emptyState}</TableCell>
               </TableRow>
             )}
           </TableBody>
         </Table>
       </div>
       <div className="md:hidden">
         {page?.items.length ? <AccountCards items={page.items} onView={viewRow} onOpenOwner={rowOwnerTarget}/> : emptyState}
       </div>
     </>
   )}
 </div>
 <footer className="mt-3">
   <ListPagination mode="cursor" onFirst={() => { positions.delete(identity); setStack([]); setFilter({ ...filter, cursor: "" }); }} page={stack.length + 1} total={page?.total ?? undefined} pageSize={Number(filter.limit)} loadedCount={page?.items.length ?? 0} loading={listBusy} pageSizeOptions={[5, 20, 50]} itemLabel="个账号"
     hasPrevious={stack.length > 0} hasNext={Boolean(page?.nextCursor)}
     onPageSizeChange={v => { positions.delete(identity); setStack([]); setFilter({ ...filter, limit: String(v), cursor: "" }); }}
     onPrevious={() => { positions.delete(identity); const prior = [...stack], cursor = prior.pop()!; setStack(prior); setFilter({ ...filter, cursor }); }}
     onNext={() => { positions.delete(identity); setStack([...stack, filter.cursor]); setFilter({ ...filter, cursor: page!.nextCursor! }); }}/>
 </footer>
 {quickRow && (
   <QuickView
     row={quickRow}
     canRead={can("supply.review.read")}
     onClose={() => {
       setQuick(null);
       requestAnimationFrame(() => (quickOrigin.current?.isConnected ? quickOrigin.current : document.getElementById("supply-work-title"))?.focus());
     }}
     onOpenFull={context => openFull(quickRow, context)}
   />
 )}

 {/* 批量下架/退还保证金与单账号上/下架、退款都没有正式合同，不提供假处置入口。 */}
</div>;
}
