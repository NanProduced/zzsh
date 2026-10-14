"use client";

import { useRef, type ReactNode, type RefObject } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import "./alert-dialog.css";

/**
 * 危险操作确认（Alert Dialog）。
 *
 * 来源与依赖结论：
 * - 交互基座使用项目已安装的 `@base-ui/react`（MIT，MUI）AlertDialog 原语。它在打开时强制
 *   `modal`、禁用外部点击关闭并渲染 `role="alertdialog"`，属于真正的 Alert Dialog 语义；
 *   普通 Dialog（如 action-feedback-dialog 的 Radix Dialog）没有这些约束，不改名冒充。
 * - ReUI（reui.io）的 Alert Dialog 文档在本环境网络策略下不可达，其来源与许可未闭合，
 *   因此不复制其代码；本组件按其文档化组织方式（标题/说明/后果清单/安全动作在前、
 *   危险动作在后）在既有 token 上自实现，依赖面保持在已安装包内，未新增依赖。
 * - 样式只补弹层排版与克制危险色，覆盖层复用全局 `.modal-overlay`，不复制既有对话框尺寸规则。
 *
 * 行为约定（对应注销确认要求）：
 * - 打开时默认焦点落在安全/取消动作（`initialFocus`），关闭后焦点还原到打开前的触发元素，
 *   触发元素已卸载时回落 Base UI 默认还原；调用方可用 `returnFocusRef` 指定还原目标。
 * - Escape 与取消按钮关闭弹窗；确认按钮只调用 `onConfirm`，由调用方在结果确定后关闭，
 *   组件不自作主张关闭，避免未知结果显示成功或丢失恢复责任。
 * - `busy` 期间确认不可再点，且 Escape/取消等关闭请求被忽略，保留提交互斥；调用方负责结束 busy。
 * - 危险确认用克制危险色（描边＋文字，非整块实心红），文字本身写明动作，颜色不单独承载语义。
 * - 动效仅做淡入与小幅位移，且受 `prefers-reduced-motion` 关闭（组件 CSS 内自带兜底）。
 */

export interface ConfirmAlertDialogProps {
  /** 受控打开状态。 */
  open: boolean;
  /** 关闭请求（取消、Escape、业务关闭）。`busy` 期间的关闭请求会被忽略。 */
  onOpenChange: (open: boolean) => void;
  /** 标题。危险操作须写明操作本身（如「确认注销账号？」），与退出登录等动作区分。 */
  title: ReactNode;
  /** 简短影响说明。必填：重要后果不折叠、不藏进气泡。 */
  description: ReactNode;
  /** 后果与未完成事项清单。有依据才写，不由组件推断业务事实。 */
  consequences?: ReactNode;
  /** 安全动作文案，默认「取消」。 */
  cancelLabel?: ReactNode;
  /** 危险确认文案。 */
  confirmLabel: ReactNode;
  /** 危险确认回调。结果未知时调用方不得关闭弹窗或重发。 */
  onConfirm: () => void;
  /** 提交进行中：确认禁用，关闭请求被忽略（互斥与恢复责任防线）。 */
  busy?: boolean;
  /** 额外禁用确认（如主体/资格核对未通过）。 */
  confirmDisabled?: boolean;
  /** 关闭后焦点还原目标；未给则还原到打开前的触发元素。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

export function ConfirmAlertDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  cancelLabel = "取消",
  confirmLabel,
  onConfirm,
  busy = false,
  confirmDisabled = false,
  returnFocusRef,
  className = "",
}: ConfirmAlertDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const requestClose = (next: boolean) => {
    if (!next && busy) return;
    onOpenChange(next);
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => requestClose(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-overlay ui-alert-dialog-backdrop" />
        <AlertDialog.Popup
          className={`ui-alert-dialog ${className}`.trim()}
          data-slot="alert-dialog-content"
          initialFocus={cancelRef}
          finalFocus={
            returnFocusRef
              ? () => (returnFocusRef.current?.isConnected ? returnFocusRef.current : true)
              : undefined
          }
        >
          <AlertDialog.Title className="ui-alert-dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="ui-alert-dialog-description">
            {description}
          </AlertDialog.Description>
          {consequences ? (
            <div className="ui-alert-dialog-consequences">{consequences}</div>
          ) : null}
          <div className="ui-alert-dialog-actions">
            <AlertDialog.Close
              ref={cancelRef}
              type="button"
              className="button secondary ui-alert-dialog-cancel"
              disabled={busy}
            >
              {cancelLabel}
            </AlertDialog.Close>
            <button
              type="button"
              className="button ui-alert-dialog-confirm"
              data-variant="danger"
              disabled={busy || confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
