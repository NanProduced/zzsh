import type { Dispatch, SetStateAction } from "react";
import { ArrowUp, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/plate/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/plate/ui/tooltip";
import { DOC_COMMENT_MAX, docTime, type DocComment } from "./docs-model";

export type ComposerProps = {
  label: string;
  placeholder: string;
  value: string;
  sendLabel: string;
  sending: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
};

export function CommentComposer({ label, placeholder, value, sendLabel, sending, disabled, onChange, onSend }: ComposerProps) {
  return (
    <div className="docs-comment-composer">
      <span className="docs-comment-avatar" aria-hidden="true">我</span>
      <div className="docs-comment-input">
        <textarea className="docs-discussion-textarea" aria-label={label} placeholder={placeholder} rows={1}
          maxLength={DOC_COMMENT_MAX} value={value} readOnly={sending} onChange={(event) => onChange(event.target.value)} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" size="icon-xs" variant="ghost" className="docs-comment-send" aria-label={sendLabel}
              loading={sending} disabled={disabled || !value.trim()} onClick={onSend}>
              <ArrowUp size={14} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{sendLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function DocsComment({
  comment, currentAdminId, editing, setEditing, replyBusy, submitEdit, confirmDelete, setConfirmDelete, canComment, submitDelete,
}: {
  comment: DocComment;
  currentAdminId: string;
  editing: { commentId: string; body: string } | null;
  setEditing: Dispatch<SetStateAction<{ commentId: string; body: string } | null>>;
  replyBusy: string | null;
  submitEdit: () => void;
  confirmDelete: string | null;
  setConfirmDelete: Dispatch<SetStateAction<string | null>>;
  canComment: boolean;
  submitDelete: (commentId: string) => void;
}) {
    if (comment.deletedAt) {
      return <li key={comment.id} className="docs-comment docs-comment-deleted" data-deleted="true">该回复已删除</li>;
    }
    const own = comment.authorAdminId === currentAdminId;
    const author = own ? "我" : "管理员";
    if (editing?.commentId === comment.id) {
      return (
        <li key={comment.id} className="docs-comment">
          <textarea
            className="docs-discussion-textarea"
            aria-label="编辑回复"
            maxLength={DOC_COMMENT_MAX}
            value={editing.body}
            readOnly={replyBusy === comment.id}
            onChange={(event) => setEditing({ commentId: comment.id, body: event.target.value })}
          />
          <div className="docs-comment-actions">
            <Button type="button" size="xs" loading={replyBusy === comment.id} disabled={!editing.body.trim()} onClick={() => void submitEdit()}>保存</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
          </div>
        </li>
      );
    }
    return (
      <li key={comment.id} className="docs-comment" data-own={own ? "true" : undefined}>
        <span className="docs-comment-avatar" aria-hidden="true">{author.slice(0, 1)}</span>
        <div className="docs-comment-meta">
          <span className="docs-comment-author">{author}</span>
          <time dateTime={comment.createdAt}>{docTime(comment.createdAt)}</time>
          {comment.editedAt ? <span className="docs-comment-edited">已编辑</span> : null}
          {own && canComment ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="icon-xs" variant="ghost" className="docs-comment-more" aria-label="留言操作">
                  <MoreHorizontal size={14} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="docs-overlay">
                <DropdownMenuItem onSelect={() => { setEditing({ commentId: comment.id, body: comment.body }); setConfirmDelete(null); }}>
                  <Pencil size={13} aria-hidden="true" />编辑
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { setConfirmDelete(comment.id); setEditing(null); }}>
                  <Trash2 size={13} aria-hidden="true" />删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <p className="docs-comment-body">{comment.body}</p>
        {own && canComment && confirmDelete === comment.id ? (
          <div className="docs-comment-actions">
            <Button type="button" size="xs" variant="danger" loading={replyBusy === comment.id} onClick={() => void submitDelete(comment.id)}>确认删除</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
          </div>
        ) : null}
      </li>
    );
}
