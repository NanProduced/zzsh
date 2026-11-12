// Source: https://platejs.org/r/slash-node.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: removed AI/equation/excalidraw/code-drawing/columns/date/footnote
// groups and imports. Menu items are filtered by the preset whitelist
// (BLOCK_TYPES in @zzsh/content/plate): notice has no headings/table/code/hr,
// legal has no code/callout/toggle and disc lists only, internal adds todo/toc.
// The host can supply a document image picker. Chinese labels + keywords.
import * as React from 'react';

import type { PlateEditor, PlateElementProps } from 'platejs/react';

import {
  ChevronRightIcon,
  Code2,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  ImagePlus,
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
  desc: string;
  kbd?: string;
  inline?: boolean;
};

const HEADING_ITEMS: Item[] = [
  { icon: <Heading2Icon />, desc: '章节标题', kbd: '##', keywords: ['subtitle', 'h2', 'biaoti'], label: '标题 2', value: KEYS.h2, requires: ['h2'] },
  { icon: <Heading3Icon />, desc: '小节标题', kbd: '###', keywords: ['subtitle', 'h3', 'biaoti'], label: '标题 3', value: KEYS.h3, requires: ['h3'] },
  { icon: <Heading4Icon />, desc: '子小节标题', kbd: '####', keywords: ['subtitle', 'h4', 'biaoti'], label: '标题 4', value: KEYS.h4, requires: ['h4'] },
];

const LIST_ITEMS: Item[] = [
  { icon: <ListIcon />, desc: '无序符号列表', kbd: '-', keywords: ['unordered', 'ul', '-', 'wuxu'], label: '无序列表', value: KEYS.ul, requires: ['p'] },
  { icon: <ListOrdered />, desc: '自动编号列表', kbd: '1.', keywords: ['ordered', 'ol', '1', 'youxu'], label: '有序列表', value: KEYS.ol, requires: ['p'] },
  { icon: <Square />, desc: '可勾选的待办', kbd: '[]', keywords: ['checklist', 'task', 'checkbox', '[]', 'daiban'], label: '待办列表', value: KEYS.listTodo, requires: ['p'] },
];

const BASIC_ITEMS: Item[] = [
  { icon: <PilcrowIcon />, desc: '普通正文段落', keywords: ['paragraph', 'text', 'duanluo', '段落'], label: '文本', value: KEYS.p, requires: ['p'] },
  { icon: <Quote />, desc: '引用或摘录', kbd: '>', keywords: ['citation', 'blockquote', 'quote', '>', 'yinyong'], label: '引用', value: KEYS.blockquote, requires: ['blockquote'] },
  { icon: <LightbulbIcon />, desc: '提示或警告框', keywords: ['note', 'tishi'], label: '提示', value: KEYS.callout, requires: ['callout'] },
  { icon: <ChevronRightIcon />, desc: '可展开/收起的内容', keywords: ['collapsible', 'expandable', 'zhedie'], label: '折叠', value: KEYS.toggle, requires: ['toggle'] },
  { icon: <Code2 />, desc: '等宽代码片段', kbd: '```', keywords: ['```', 'daima'], label: '代码块', value: KEYS.codeBlock, requires: ['code_block', 'code_line'] },
  { icon: <Table />, desc: '行列结构化数据', keywords: ['biaoge'], label: '表格', value: KEYS.table, requires: ['table', 'tr', 'td'] },
  { icon: <MinusIcon />, desc: '视觉分隔线', kbd: '---', keywords: ['divider', 'hr', 'fenge'], label: '分割线', value: KEYS.hr, requires: ['hr'] },
];

const ADVANCED_ITEMS: Item[] = [
  { icon: <TableOfContentsIcon />, desc: '按标题生成页内目录', keywords: ['toc', 'mulu'], label: '目录', value: KEYS.toc, requires: ['toc'] },
];

const INLINE_ITEMS: Item[] = [
  { icon: <LinkIcon />, desc: '插入超链接', keywords: ['link', 'url', 'lianjie'], label: '链接', value: KEYS.link, requires: [], inline: true },
];

const IMAGE_ITEM: Item = { icon: <ImagePlus />, desc: '上传 PNG、JPEG 或 WebP', keywords: ['image', 'tupian'], label: '图片', value: KEYS.img, requires: ['img'] };

export const PlateImagePicker = React.createContext<((blockId: string) => void) | undefined>(undefined);

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
  const { editor, element, path } = props;
  const preset = usePluginOption({ key: KEYS.slashInput }, 'preset') as PlatePreset;
  const pickImage = React.useContext(PlateImagePicker);
  const blockId = editor.children[path[0]!]?.id;

  const groups = React.useMemo(() => {
    const basic = [BASIC_ITEMS[0]!, HEADING_ITEMS[0]!, ...(pickImage ? [IMAGE_ITEM] : []), ...HEADING_ITEMS.slice(1), ...LIST_ITEMS, BASIC_ITEMS[1]!];
    return [
      { group: '基本区块', items: slashItemsFor(preset, basic) },
      { group: '更多区块', items: slashItemsFor(preset, [...BASIC_ITEMS.slice(2), ...ADVANCED_ITEMS, ...INLINE_ITEMS]) },
    ].filter(({ items }) => items.length > 0);
  }, [pickImage, preset]);

  const onSelect = (editor: PlateEditor, item: Item) => {
    if (item.value === KEYS.img) {
      if (typeof blockId === 'string') pickImage?.(blockId);
    } else if (item.inline) insertInlineElement(editor, item.value);
    else insertBlock(editor, item.value, { upsert: true });
  };

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput className="plate-slash-input" placeholder="输入以搜索" aria-label="搜索区块" />

        <InlineComboboxContent className="plate-slash-menu">
          <InlineComboboxEmpty>没有匹配的块</InlineComboboxEmpty>

          {groups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel className="plate-slash-group-label">{group}</InlineComboboxGroupLabel>

              {items.map((item) => (
                <InlineComboboxItem
                  key={item.value}
                  value={item.value}
                  onClick={() => onSelect(editor, item)}
                  focusEditor={item.value !== KEYS.img}
                  label={item.label}
                  group={group}
                  keywords={[item.desc, ...(item.keywords ?? [])]}
                  className="plate-slash-item"
                >
                  <span className="plate-slash-row">
                    <span className="plate-slash-icon" aria-hidden="true">{item.icon}</span>
                    <span className="plate-slash-label">{item.label}</span>
                    {item.kbd ? <kbd className="plate-slash-kbd">{item.kbd}</kbd> : null}
                  </span>
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
