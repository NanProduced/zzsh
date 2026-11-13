import type { Dispatch, RefObject, SetStateAction } from "react";
import { AlertTriangle, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { emptyUploadDialog, type UploadDialogState } from "./supply-media/upload-dialog";
import { OWNERSHIP_LABELS, REVIEWED_STATES, STATE_LABELS, type OwnershipFilter, type ReviewedState, type ReviewTab } from "./supply-media/model";
import { isUploadRecord, recordPhaseText, type WriteRecord } from "./supply-media/write-intent";

export function MediaReviewHeader({ headingRef, canUpload, pageItems, writeLocked, setUploadState, writeRecord, writeBusy, replayWrite, readbackAgain, runRecoveryCheck, setAbandonOpen, recoveryChecked, uploadMemory, storedProblem, acknowledgeStoredProblem, unresolvedNotice, notice, tab, setTab, reviewedState, setReviewedState, ownershipKind, setOwnershipKind }: {
  headingRef: RefObject<HTMLElement | null>;
  canUpload: boolean;
  pageItems: { length: number };
  writeLocked: boolean;
  setUploadState: Dispatch<SetStateAction<UploadDialogState>>;
  writeRecord: WriteRecord | null;
  writeBusy: boolean;
  replayWrite: () => void;
  readbackAgain: () => void;
  runRecoveryCheck: (record: WriteRecord) => void;
  setAbandonOpen: Dispatch<SetStateAction<boolean>>;
  recoveryChecked: boolean;
  uploadMemory: { current: { file: { size: number } } | null };
  storedProblem: "corrupt" | "foreign" | null;
  acknowledgeStoredProblem: () => void;
  unresolvedNotice: string | null;
  notice: string | null;
  tab: ReviewTab;
  setTab: Dispatch<SetStateAction<ReviewTab>>;
  reviewedState: ReviewedState;
  setReviewedState: Dispatch<SetStateAction<ReviewedState>>;
  ownershipKind: OwnershipFilter;
  setOwnershipKind: Dispatch<SetStateAction<OwnershipFilter>>;
}) {
  return (
      <section ref={headingRef} className="section-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/60">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl leading-8 font-semibold tracking-tight">素材审核</h1>
            </div>
            <p className="text-xs text-muted-foreground">审核决定与公开范围分开记录；公开需显式授权。</p>
          </div>
          {canUpload ? (
            <Button type="button" size="sm" variant={pageItems.length > 0 ? "outline" : "default"} className="h-9 gap-1.5 shadow-sm" onClick={() => setUploadState({ ...emptyUploadDialog(), open: true })} disabled={writeLocked}>
              <Upload className="size-4" /> 上传平台素材
            </Button>
          ) : null}
        </div>

        {writeRecord ? (
          <div className="mt-3 space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-2 text-xs font-medium"><AlertTriangle className="size-3.5 text-amber-500" />{recordPhaseText(writeRecord)}：{writeRecord.targetLabel}</p>
            <p className="text-xs text-muted-foreground">
              原命令与原幂等键已保留；本地记录不是授权依据，恢复仍由服务端校验。不能把当前状态恰好相同当作该命令成功，也不能把未查到记录解释为未执行。
            </p>
            <div className="flex flex-wrap gap-2">
              {writeRecord.phase !== "accepted_readback" ? (
                <Button type="button" size="sm" variant="secondary" disabled={writeBusy} onClick={() => void replayWrite()}>
                  <RefreshCw /> {isUploadRecord(writeRecord) && writeRecord.intent.status === "accepted" && !writeRecord.bytes.fingerprint ? "继续上传" : "按原请求重放"}
                </Button>
              ) : null}
              {writeRecord.phase === "accepted_readback" ? (
                <Button type="button" size="sm" variant="secondary" disabled={writeBusy} onClick={() => void readbackAgain()}>重新读取</Button>
              ) : null}
              {writeRecord.phase !== "accepted_readback" && writeRecord.recoverable ? (
                <Button type="button" size="sm" variant="secondary" disabled={writeBusy} onClick={() => void runRecoveryCheck(writeRecord)}>核对原结果</Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" disabled={writeBusy} onClick={() => setAbandonOpen(true)}>放弃恢复</Button>
            </div>
            {writeRecord.phase === "unknown" && !recoveryChecked ? <p className="text-xs text-muted-foreground">恢复检查中，完成前不允许发起新命令。</p> : null}
            {!isUploadRecord(writeRecord) && !writeRecord.recoverable ? <p className="text-xs text-muted-foreground">{writeRecord.recoverNote}</p> : null}
            {isUploadRecord(writeRecord) && !uploadMemory.current?.file.size ? <p className="text-xs text-muted-foreground">上传凭据或文件已失效（刷新后不保留），无法继续字节上传；上传未完成，不生成新上传冒充恢复。</p> : null}
          </div>
        ) : null}
        {storedProblem ? (
          <div className="mt-3 space-y-2 rounded border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium">本地恢复记录{storedProblem === "corrupt" ? "已损坏，无法解析或摘要不符" : "不属于当前身份"}，已阻止所有新命令。</p>
            <p className="text-xs text-muted-foreground">不能直接删除后重新提交；请先在列表核对相关对象当前状态，再显式确认清除。</p>
            <Button type="button" size="sm" variant="secondary" onClick={acknowledgeStoredProblem}>我已在列表核对，清除该记录</Button>
          </div>
        ) : null}
        {unresolvedNotice ? <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{unresolvedNotice}</p> : null}
        {notice ? <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">{notice}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as ReviewTab)} className="mr-2">
            <TabsList aria-label="审核任务">
              <TabsTrigger value="pending">待审核</TabsTrigger>
              <TabsTrigger value="reviewed">已审核</TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === "reviewed" ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              子状态
              <Select value={reviewedState} items={REVIEWED_STATES.map((value) => ({ value, label: STATE_LABELS[value] }))} onValueChange={(value) => setReviewedState(value as ReviewedState)}>
                <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REVIEWED_STATES.map((value) => <SelectItem key={value} value={value}>{STATE_LABELS[value]}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            归属
            <Select value={ownershipKind} items={[{ value: "PLATFORM_CATALOG", label: "平台目录素材" }, { value: "USER_SUPPLY", label: "用户供给图片与凭证" }]} onValueChange={(value) => setOwnershipKind(value as OwnershipFilter)}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PLATFORM_CATALOG">平台目录素材</SelectItem>
                <SelectItem value="USER_SUPPLY">用户供给图片与凭证</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <span className="text-xs text-muted-foreground">仅显示当前授权范围</span>
        </div>
      </section>
  );
}
