// Source: https://platejs.org/r/slash-node.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: removed AI/equation/excalidraw/code-drawing/columns/date/footnote
// groups and imports. Menu items are filtered by the preset whitelist
// (BLOCK_TYPES in @zzsh/content/plate): notice has no headings/table/code/hr,
// legal has no code/callout/toggle and disc lists only, internal adds todo/toc.
// Images are intentionally absent: they need a mediaId/imageId from the media
// library (P1a), which the slash menu cannot mint. Chinese labels + keywords.
import * as React from 'react';

import type { PlateEditor, PlateElementProps } from 'platejs/react';

import {
  ChevronRightIcon,
  Code2,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  ListOrdered,
  MinusIcon,
  PilcrowIcon,
  Quote,
  Square,
  Table,
  TableOfContentsIcon,
} from 'lucide-react';
import { type TComboboxInputElement, KEYS } from 'platejs';
import { PlateElement, usePluginOption } from 'platejs/react';

import { BLOCK_TYPES, type PlatePreset } from '@zzsh/content/plate';

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from './inline-combobox';
import { insertBlock, insertInlineElement } from './transforms';

type Item = {
  icon: React.ReactNode;
  value: string;
  requires: string[];
  keywords?: string[];
  label: string;
  inline?: boolean;
};

const BASIC_ITEMS: Item[] = [
  { icon: <PilcrowIcon />, keywords: ['paragraph', 'text', 'duanluo'], label: '段落', value: KEYS.p, requires: ['p'] },
  { icon: <Heading2Icon />, keywords: ['subtitle', 'h2', 'biaoti'], label: '标题 2', value: KEYS.h2, requires: ['h2'] },
  { icon: <Heading3Icon />, keywords: ['subtitle', 'h3', 'biaoti'], label: '标题 3', value: KEYS.h3, requires: ['h3'] },
  { icon: <Heading4Icon />, keywords: ['subtitle', 'h4', 'biaoti'], label: '标题 4', value: KEYS.h4, requires: ['h4'] },
  { icon: <ListIcon />, keywords: ['unordered', 'ul', '-', 'wuxu'], label: '无序列表', value: KEYS.ul, requires: ['p'] },
  { icon: <ListOrdered />, keywords: ['ordered', 'ol', '1', 'youxu'], label: '有序列表', value: KEYS.ol, requires: ['p'] },
  { icon: <Square />, keywords: ['checklist', 'task', 'checkbox', '[]', 'daiban'], label: '待办列表', value: KEYS.listTodo, requires: ['p'] },
  { icon: <ChevronRightIcon />, keywords: ['collapsible', 'expandable', 'zhedie'], label: '折叠', value: KEYS.toggle, requires: ['toggle'] },
  { icon: <Code2 />, keywords: ['```', 'daima'], label: '代码块', value: KEYS.codeBlock, requires: ['code_block', 'code_line'] },
  { icon: <Table />, keywords: ['biaoge'], label: '表格', value: KEYS.table, requires: ['table', 'tr', 'td'] },
  { icon: <Quote />, keywords: ['citation', 'blockquote', 'quote', '>', 'yinyong'], label: '引用', value: KEYS.blockquote, requires: ['blockquote'] },
  { icon: <LightbulbIcon />, keywords: ['note', 'tishi'], label: '提示', value: KEYS.callout, requires: ['callout'] },
  { icon: <MinusIcon />, keywords: ['divider', 'hr', 'fenge'], label: '分割线', value: KEYS.hr, requires: ['hr'] },
];

const ADVANCED_ITEMS: Item[] = [
  { icon: <TableOfContentsIcon />, keywords: ['toc', 'mulu'], label: '目录', value: KEYS.toc, requires: ['toc'] },
];

const INLINE_ITEMS: Item[] = [
  { icon: <LinkIcon />, keywords: ['link', 'url', 'lianjie'], label: '链接', value: KEYS.link, requires: [], inline: true },
];

export function slashItemsFor(preset: PlatePreset, items: Item[]): Item[] {
  const blocks = new Set(BLOCK_TYPES[preset]);
  return items.filter((item) => {
    if (!item.requires.every((t) => blocks.has(t))) return false;
    if (item.value === KEYS.listTodo && preset !== 'internal') return false;
    // legal keeps source numbering as text: disc lists only.
    if (item.value === KEYS.ol && preset === 'legal') return false;
    return true;
  });
}

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const { editor, element } = props;
  const preset = usePluginOption({ key: KEYS.slashInput }, 'preset') as PlatePreset;

  const groups = React.useMemo(() => {
    const basic = slashItemsFor(preset, BASIC_ITEMS);
    const advanced = slashItemsFor(preset, ADVANCED_ITEMS);
    const inline = slashItemsFor(preset, INLINE_ITEMS);
    return [
      { group: '基础块', items: basic },
      { group: '高级块', items: advanced },
      { group: '行内', items: inline },
    ].filter(({ items }) => items.length > 0);
  }, [preset]);

  const onSelect = (editor: PlateEditor, item: Item) => {
    if (item.inline) insertInlineElement(editor, item.value);
    else insertBlock(editor, item.value, { upsert: true });
  };

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput />

        <InlineComboboxContent>
          <InlineComboboxEmpty>没有匹配的块</InlineComboboxEmpty>

          {groups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>

              {items.map((item) => (
                <InlineComboboxItem
                  key={item.value}
                  value={item.value}
                  onClick={() => onSelect(editor, item)}
                  label={item.label}
                  group={group}
                  keywords={item.keywords}
                >
                  <div className="mr-2 text-muted-foreground">{item.icon}</div>
                  {item.label}
                </InlineComboboxItem>
              ))}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}