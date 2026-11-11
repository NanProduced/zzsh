// Source: https://platejs.org/r/floating-toolbar-buttons.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: removed AI/comment/equation/suggestion buttons and imports.
// Kept mark/turn-into/link/list/indent/more, filtered by the preset whitelist:
// marks follow marksFor(preset), decimal lists skip legal, todo is internal
// only, indent/outdent show for list selections, more carries the whitelisted
// color marks (legal/internal) and hides elsewhere.
import {
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { ListStyleType, someList, someTodoList } from '@platejs/list';
import { KEYS } from 'platejs';
import { useEditorReadOnly, useEditorSelector } from 'platejs/react';

import type { PlatePreset } from '@zzsh/content/plate';

import { IndentToolbarButton, OutdentToolbarButton } from './indent-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import {
  BulletedListToolbarButton,
  NumberedListToolbarButton,
  TodoListToolbarButton,
} from './list-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { ToolbarGroup } from './toolbar';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FloatingToolbarButtons({
  preset,
  marks,
}: {
  preset: PlatePreset;
  marks: Set<string>;
}) {
  const readOnly = useEditorReadOnly();
  const inList = useEditorSelector(
    (editor) =>
      someList(editor, [ListStyleType.Disc, ListStyleType.Decimal]) ||
      someTodoList(editor),
    []
  );

  if (readOnly) return null;

  return (
    <>
      <ToolbarGroup>
        <TurnIntoToolbarButton preset={preset} />
      </ToolbarGroup>

      <ToolbarGroup>
        <MarkToolbarButton nodeType={KEYS.bold} tooltip="加粗 (⌘+B)" aria-label="加粗">
          <BoldIcon />
        </MarkToolbarButton>

        <MarkToolbarButton nodeType={KEYS.italic} tooltip="斜体 (⌘+I)" aria-label="斜体">
          <ItalicIcon />
        </MarkToolbarButton>

        {marks.has('underline') && (
          <MarkToolbarButton nodeType={KEYS.underline} tooltip="下划线 (⌘+U)" aria-label="下划线">
            <UnderlineIcon />
          </MarkToolbarButton>
        )}

        <MarkToolbarButton
          nodeType={KEYS.strikethrough}
          tooltip="删除线 (⌘+⇧+M)"
          aria-label="删除线"
        >
          <StrikethroughIcon />
        </MarkToolbarButton>

        {marks.has('code') && (
          <MarkToolbarButton nodeType={KEYS.code} tooltip="行内代码 (⌘+E)" aria-label="行内代码">
            <Code2Icon />
          </MarkToolbarButton>
        )}

        <LinkToolbarButton />
      </ToolbarGroup>

      <ToolbarGroup>
        <BulletedListToolbarButton />
        {preset !== 'legal' && <NumberedListToolbarButton />}
        {preset === 'internal' && <TodoListToolbarButton />}
      </ToolbarGroup>

      {inList && (
        <ToolbarGroup>
          <IndentToolbarButton />
          <OutdentToolbarButton />
        </ToolbarGroup>
      )}

      <ToolbarGroup>
        <MoreToolbarButton preset={preset} />
      </ToolbarGroup>
    </>
  );
}