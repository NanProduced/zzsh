// Source: https://platejs.org/r/link-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: scoped ../ui primitives, cn from @/lib/utils; no AI/suggestion/comment.
import * as React from 'react';

import {
  useLinkToolbarButton,
  useLinkToolbarButtonState,
} from '@platejs/link/react';
import { Link } from 'lucide-react';

import { ToolbarButton } from './toolbar';

export function LinkToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const state = useLinkToolbarButtonState();
  const { props: buttonProps } = useLinkToolbarButton(state);

  return (
    <ToolbarButton {...props} {...buttonProps} data-plate-focus tooltip="Link" aria-label="链接">
      <Link />
    </ToolbarButton>
  );
}
