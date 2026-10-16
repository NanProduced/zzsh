// 帮助模块文档级快捷键的共享作用域判断：只在背景正文响应，弹窗/菜单/列表/
// 浮层内的操作、已被处理的事件、输入控件与输入法组合一律放行。刻意保持为
// 小判断函数，不引入全局快捷键框架。

export function isEditableKeyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

const OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]";

export function isOverlayKeyTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null;
}

export function isBackgroundKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (isEditableKeyTarget(event.target)) return false;
  if (isOverlayKeyTarget(event.target)) return false;
  return true;
}
