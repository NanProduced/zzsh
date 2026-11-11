// Source: https://platejs.org/r/indent-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: scoped ../ui primitives, cn from @/lib/utils; no AI/suggestion/comment.
import * as React from 'react';

import { useIndentButton, useOutdentButton } from '@platejs/indent/react';
import { IndentIcon, OutdentIcon } from 'lucide-react';

import { ToolbarButton } from './toolbar';

export function IndentToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const { props: buttonProps } = useIndentButton();

  return (
    <ToolbarButton {...props} {...buttonProps} tooltip="Indent" aria-label="增加缩进">
      <IndentIcon />
    </ToolbarButton>
  );
}

export function OutdentToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const { props: buttonProps } = useOutdentButton();

  return (
    <ToolbarButton {...props} {...buttonProps} tooltip="Outdent" aria-label="减少缩进">
      <OutdentIcon />
    </ToolbarButton>
  );
}
