// Source: https://platejs.org/r/more-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: the registry's kbd/superscript/subscript marks are outside the
// storage whitelist and were removed. What remains whitelisted for "more" is
// the color/backgroundColor marks (legal: red only; internal: full palette),
// so the menu carries those swatches and is hidden for other presets.
import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import { MoreHorizontalIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import { PALETTE, type PlatePreset } from '@zzsh/content/plate';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { ToolbarButton } from './toolbar';

const COLOR_LABELS: Record<string, string> = {
  red: '红色',
  orange: '橙色',
  green: '绿色',
  blue: '蓝色',
  gray: '灰色',
};

export function moreColorsFor(preset: PlatePreset): string[] {
  if (preset === 'legal') return ['red'];
  if (preset === 'internal') return [...PALETTE];
  return [];
}

export function MoreToolbarButton({
  preset,
  ...props
}: DropdownMenuProps & { preset: PlatePreset }) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);
  const colors = moreColorsFor(preset);

  if (colors.length === 0) return null;

  const applyColor = (mark: 'color' | 'backgroundColor', token: string) => {
    const active = editor.api.marks()?.[mark];
    if (active === token) editor.tf.removeMark(mark);
    else editor.tf.addMark(mark, token);
    editor.tf.focus();
  };

  const swatches = (mark: 'color' | 'backgroundColor') =>
    colors.map((token) => (
      <DropdownMenuItem
        key={`${mark}-${token}`}
        onSelect={() => applyColor(mark, token)}
      >
        <span
          className="size-3.5 rounded-full border border-border"
          style={{ background: `var(--plate-${token})` }}
          aria-hidden="true"
        />
        {COLOR_LABELS[token] ?? token}
      </DropdownMenuItem>
    ));

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip="更多" aria-label="更多">
          <MoreHorizontalIcon />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar flex max-h-[500px] min-w-[180px] flex-col overflow-y-auto"
        align="start"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs">文字颜色</DropdownMenuLabel>
          {swatches('color')}
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs">背景颜色</DropdownMenuLabel>
          {swatches('backgroundColor')}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}