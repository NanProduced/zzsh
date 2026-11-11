// Source: https://platejs.org/r/list-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: the whitelist stores only disc/decimal/todo, so the split-button
// style menus (circle/square/alpha/roman) are removed; each family is a plain
// toggle. Todo is internal-only and gated by the caller.
import * as React from 'react';

import { ListStyleType, someList, toggleList } from '@platejs/list';
import {
  useIndentTodoToolBarButton,
  useIndentTodoToolBarButtonState,
} from '@platejs/list/react';
import { List, ListOrdered, ListTodoIcon } from 'lucide-react';
import { useEditorRef, useEditorSelector } from 'platejs/react';

import { ToolbarButton } from './toolbar';

export function BulletedListToolbarButton() {
  const editor = useEditorRef();

  const pressed = useEditorSelector(
    (editor) => someList(editor, [ListStyleType.Disc]),
    []
  );

  return (
    <ToolbarButton
      pressed={pressed}
      tooltip="无序列表"
      aria-label="无序列表"
      onClick={() => {
        toggleList(editor, { listStyleType: ListStyleType.Disc });
      }}
    >
      <List className="size-4" />
    </ToolbarButton>
  );
}

export function NumberedListToolbarButton() {
  const editor = useEditorRef();

  const pressed = useEditorSelector(
    (editor) => someList(editor, [ListStyleType.Decimal]),
    []
  );

  return (
    <ToolbarButton
      pressed={pressed}
      tooltip="有序列表"
      aria-label="有序列表"
      onClick={() => {
        toggleList(editor, { listStyleType: ListStyleType.Decimal });
      }}
    >
      <ListOrdered className="size-4" />
    </ToolbarButton>
  );
}

export function TodoListToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const state = useIndentTodoToolBarButtonState({ nodeType: 'todo' });
  const { props: buttonProps } = useIndentTodoToolBarButton(state);

  return (
    <ToolbarButton {...props} {...buttonProps} tooltip="待办列表" aria-label="待办列表">
      <ListTodoIcon />
    </ToolbarButton>
  );
}