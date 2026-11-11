// Source: https://platejs.org/r/turn-into-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: items filtered by the preset whitelist (BLOCK_TYPES in
// @zzsh/content/plate); removed h1/h5/h6/code-drawing/columns; Chinese labels.
import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import type { TElement } from 'platejs';

import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import {
  CheckIcon,
  ChevronRightIcon,
  FileCodeIcon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
  SquareIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import { BLOCK_TYPES, type PlatePreset } from '@zzsh/content/plate';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { ToolbarButton, ToolbarMenuGroup } from './toolbar';
import { getBlockType, setBlockType } from './transforms';

const ALL_ITEMS = [
  { icon: <PilcrowIcon />, keywords: ['paragraph', 'text', 'duanluo'], label: '段落', value: KEYS.p, requires: ['p'] },
  { icon: <Heading2Icon />, keywords: ['subtitle', 'h2', 'biaoti'], label: '标题 2', value: KEYS.h2, requires: ['h2'] },
  { icon: <Heading3Icon />, keywords: ['subtitle', 'h3', 'biaoti'], label: '标题 3', value: KEYS.h3, requires: ['h3'] },
  { icon: <Heading4Icon />, keywords: ['subtitle', 'h4', 'biaoti'], label: '标题 4', value: KEYS.h4, requires: ['h4'] },
  { icon: <ListIcon />, keywords: ['unordered', 'ul', '-', 'wuxu'], label: '无序列表', value: KEYS.ul, requires: ['p'] },
  { icon: <ListOrderedIcon />, keywords: ['ordered', 'ol', '1', 'youxu'], label: '有序列表', value: KEYS.ol, requires: ['p'] },
  { icon: <SquareIcon />, keywords: ['checklist', 'task', 'checkbox', '[]', 'daiban'], label: '待办列表', value: KEYS.listTodo, requires: ['p'] },
  { icon: <ChevronRightIcon />, keywords: ['collapsible', 'expandable', 'zhedie'], label: '折叠', value: KEYS.toggle, requires: ['toggle'] },
  { icon: <FileCodeIcon />, keywords: ['```', 'daima'], label: '代码块', value: KEYS.codeBlock, requires: ['code_block', 'code_line'] },
  { icon: <QuoteIcon />, keywords: ['citation', 'blockquote', '>', 'yinyong'], label: '引用', value: KEYS.blockquote, requires: ['blockquote'] },
];

export function turnIntoItemsFor(preset: PlatePreset) {
  const blocks = new Set(BLOCK_TYPES[preset]);
  return ALL_ITEMS.filter((item) => {
    if (!item.requires.every((t) => blocks.has(t))) return false;
    if (item.value === KEYS.listTodo && preset !== 'internal') return false;
    // legal keeps source numbering as text: disc lists only.
    if (item.value === KEYS.ol && preset === 'legal') return false;
    return true;
  });
}

export function TurnIntoToolbarButton({
  preset,
  ...props
}: DropdownMenuProps & { preset: PlatePreset }) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const items = React.useMemo(() => turnIntoItemsFor(preset), [preset]);
  const value = useSelectionFragmentProp({
    defaultValue: KEYS.p,
    getProp: (node) => getBlockType(node as TElement),
  });
  const selectedItem = React.useMemo(
    () => (items.find((item) => item.value === (value ?? KEYS.p)) ?? items[0])!,
    [items, value]
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          className="min-w-[125px]"
          pressed={open}
          tooltip="转换类型"
          isDropdown
        >
          {selectedItem.label}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar min-w-0"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          editor.tf.focus();
        }}
        align="start"
      >
        <ToolbarMenuGroup
          value={value}
          onValueChange={(type) => {
            setBlockType(editor, type);
          }}
          label="转换类型"
        >
          {items.map(({ icon, label, value: itemValue }) => (
            <DropdownMenuRadioItem
              key={itemValue}
              className="min-w-[180px] pl-2 *:first:[span]:hidden"
              value={itemValue}
            >
              <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
                <DropdownMenuItemIndicator>
                  <CheckIcon />
                </DropdownMenuItemIndicator>
              </span>
              {icon}
              {label}
            </DropdownMenuRadioItem>
          ))}
        </ToolbarMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}