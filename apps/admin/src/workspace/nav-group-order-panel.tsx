import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, RotateCcwIcon } from "lucide-react";

import type { WorkspaceMenuItem } from "./nav-config.ts";
import { NAV_FIXED_FIRST_GROUP_ID, NAV_FIXED_LAST_GROUP_ID, NAV_GROUP_DEFAULT_ORDER } from "./nav-config.ts";
import {
  NAV_GROUP_ORDER_EVENT,
  clearNavGroupOrder,
  movableNavGroupIds,
  moveVisibleNavGroup,
  notifyNavGroupOrderChanged,
  orderNavGroups,
  readNavGroupOrder,
  splitNavGroups,
  writeNavGroupOrder,
  type NavGroup,
} from "./nav-group-order.ts";
import "./nav-group-order.css";

export type NavGroupOrderController = {
  order: string[];
  error: boolean;
  lastMoved: string | null;
  move: (id: string, delta: -1 | 1) => void;
  reset: () => void;
};

/** 侧栏编辑态与设置页面板共用同一份状态：本地写入后广播，另一处立即跟上。 */
export function useNavGroupOrder(adminUserId: string, items: readonly WorkspaceMenuItem[]): NavGroupOrderController {
  const [order, setOrder] = useState<string[]>(() => readNavGroupOrder(adminUserId));
  const [error, setError] = useState(false);
  const [lastMoved, setLastMoved] = useState<string | null>(null);
  const visibleIds = movableNavGroupIds(items);

  useEffect(() => {
    setOrder(readNavGroupOrder(adminUserId));
    setError(false);
    setLastMoved(null);
  }, [adminUserId]);

  useEffect(() => {
    const sync = () => {
      setOrder(readNavGroupOrder(adminUserId));
      setError(false);
    };
    window.addEventListener(NAV_GROUP_ORDER_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NAV_GROUP_ORDER_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [adminUserId]);

  useEffect(() => {
    if (!lastMoved) return;
    const timer = window.setTimeout(() => setLastMoved(null), 360);
    return () => window.clearTimeout(timer);
  }, [lastMoved, order]);

  const move = (id: string, delta: -1 | 1) => {
    const next = moveVisibleNavGroup(order, visibleIds, id, delta);
    if (next.length === order.length && next.every((value, index) => value === order[index])) return;
    setOrder(next);
    setError(!writeNavGroupOrder(adminUserId, next));
    setLastMoved(id);
    notifyNavGroupOrderChanged();
  };

  const reset = () => {
    clearNavGroupOrder(adminUserId);
    setOrder([...NAV_GROUP_DEFAULT_ORDER]);
    setError(false);
    setLastMoved(null);
    notifyNavGroupOrderChanged();
  };

  return { order, error, lastMoved, move, reset };
}

function groupIsFixed(group: NavGroup): boolean {
  return group.id === NAV_FIXED_FIRST_GROUP_ID || group.id === NAV_FIXED_LAST_GROUP_ID;
}

function pageLabels(group: NavGroup): string {
  const labels = group.items.filter((item) => !item.isTitle).map((item) => item.label);
  return labels.join(" · ") || "—";
}

function MoveButtons({
  label,
  upDisabled,
  downDisabled,
  onMove,
  className,
  buttonClassName,
}: {
  label: string;
  upDisabled: boolean;
  downDisabled: boolean;
  onMove: (delta: -1 | 1) => void;
  className: string;
  buttonClassName: string;
}) {
  return (
    <div className={className}>
      <button type="button" className={buttonClassName} disabled={upDisabled} onClick={() => onMove(-1)} aria-label={`将「${label}」上移`}>
        <ArrowUpIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" className={buttonClassName} disabled={downDisabled} onClick={() => onMove(1)} aria-label={`将「${label}」下移`}>
        <ArrowDownIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** 侧栏内的就地编辑态：参照物就是导航本身，菜单项只作变淡预览，不产生任何跳转或焦点。 */
export function NavGroupEditor({
  controller,
  items,
  onDone,
}: {
  controller: NavGroupOrderController;
  items: readonly WorkspaceMenuItem[];
  onDone: () => void;
}) {
  const groups = splitNavGroups(orderNavGroups(items, controller.order));
  const movable = movableNavGroupIds(items);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { doneRef.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onDone(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDone]);

  return (
    <div className="nav-group-editor" role="group" aria-label="编辑侧栏分组顺序">
      <div className="nav-group-editor__bar">
        <span className="nav-group-editor__title">编辑侧栏顺序</span>
        <div className="nav-group-editor__actions">
          <button type="button" className="nav-group-editor__action" onClick={controller.reset}>恢复默认</button>
          <button ref={doneRef} type="button" className="nav-group-editor__action nav-group-editor__action--primary" onClick={onDone}>
            <CheckIcon className="size-3" aria-hidden="true" />
            完成
          </button>
        </div>
      </div>
      <div className="nav-group-editor__list">
        {groups.map((group) => {
          const fixed = groupIsFixed(group);
          const position = movable.indexOf(group.id);
          return (
            <div
              key={group.id}
              className={`nav-group-editor__row${fixed ? " nav-group-editor__row--fixed" : ""}`}
              data-moved={controller.lastMoved === group.id ? "true" : undefined}
            >
              <div className="nav-group-editor__label">
                <span className="nav-group-editor__name">{group.label || "其他"}</span>
                <span className="nav-group-editor__items">{pageLabels(group)}</span>
              </div>
              {fixed
                ? <span className="nav-group-editor__fixed">固定</span>
                : <span className="nav-group-editor__index">{position + 1}</span>}
              {fixed
                ? <span />
                : <MoveButtons
                    label={group.label}
                    upDisabled={position <= 0}
                    downDisabled={position >= movable.length - 1}
                    onMove={(delta) => controller.move(group.id, delta)}
                    className="nav-group-editor__moves"
                    buttonClassName="nav-group-editor__move"
                  />}
            </div>
          );
        })}
      </div>
      <p className="nav-group-editor__hint">调整即时生效。按 Esc 结束编辑；顺序只保存在当前浏览器，按当前管理账号区分。</p>
      {controller.error ? <p className="nav-group-editor__hint">当前浏览器无法保存偏好，本次调整只在此页面有效。</p> : null}
    </div>
  );
}

/** 设置 → 外观与偏好里的等价面板：折叠态、移动端与键盘场景的稳定入口。 */
export function NavGroupOrderPanel({
  adminUserId,
  items,
}: {
  adminUserId: string;
  items: readonly WorkspaceMenuItem[];
}) {
  const controller = useNavGroupOrder(adminUserId, items);
  const groups = splitNavGroups(orderNavGroups(items, controller.order));
  const movable = movableNavGroupIds(items);
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-xl border border-border bg-surface-raised/40 p-4 sm:p-5" aria-labelledby="nav-group-panel-title">
      <div className="nav-group-panel__head">
        <div>
          <h2 id="nav-group-panel-title" className="nav-group-panel__title">侧栏分组顺序</h2>
          <p className="nav-group-panel__desc">
            调整左侧导航的分组先后。「工作区」固定在最前，「个人」固定在最后；只显示当前账号有权访问的分组。
          </p>
        </div>
        <button
          type="button"
          className="nav-group-panel__toggle"
          aria-expanded={open}
          aria-controls={open ? "nav-group-order-list" : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{open ? "收起" : "展开"}</span>
          <ChevronDownIcon className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <>
          <div id="nav-group-order-list" className="nav-group-panel__list">
            {groups.filter((group) => !groupIsFixed(group)).map((group) => {
              const position = movable.indexOf(group.id);
              return (
                <div key={group.id} className="nav-group-panel__row">
                  <div>
                    <span className="nav-group-panel__name">{group.label || "其他"}</span>
                    <span className="nav-group-panel__meta">{pageLabels(group)}</span>
                  </div>
                  <span className="nav-group-panel__index">{position + 1}</span>
                  <MoveButtons
                    label={group.label || "其他"}
                    upDisabled={position <= 0}
                    downDisabled={position >= movable.length - 1}
                    onMove={(delta) => controller.move(group.id, delta)}
                    className="nav-group-panel__moves"
                    buttonClassName="nav-group-panel__move"
                  />
                </div>
              );
            })}
          </div>
          <div className="nav-group-panel__foot">
            <p className="nav-group-panel__scope">
              保存范围：<strong>仅当前浏览器</strong>，按管理账号分别保存；换设备或换浏览器不会跟随。
              与主题偏好不同，主题在同一浏览器的多个账号间共用。页面搜索始终按默认顺序列出分组，不受这里影响。
            </p>
            <button type="button" className="nav-group-panel__reset" onClick={controller.reset}>
              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
              恢复侧栏默认顺序
            </button>
          </div>
        </>
      ) : (
        <p className="nav-group-panel__summary">可调整 {movable.length} 个分组 · 当前顺序仅保存在当前浏览器</p>
      )}
      {controller.error ? <p className="nav-group-panel__notice">当前浏览器无法保存偏好，本次调整只在此页面有效。</p> : null}
    </section>
  );
}
