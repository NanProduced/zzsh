// Source: https://platejs.org/r/editor.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: kept EditorContainer + Editor (interactive shell); editor-static /
// EditorView belong to the read surface (packages/ui PlateDocument) and are not
// assembled here. Removed ai/aiChat/comment/demo/fullWidth/select variants.
import * as React from 'react';

import type { VariantProps } from 'class-variance-authority';
import type { PlateContentProps } from 'platejs/react';

import { cva } from 'class-variance-authority';
import { PlateContainer, PlateContent } from 'platejs/react';

import { cn } from '@/lib/utils';

const editorContainerVariants = cva(
  'relative w-full cursor-text select-text overflow-y-auto caret-primary selection:bg-brand/25 focus-visible:outline-none [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-brand/25 [&_.slate-selection-area]:bg-brand/15',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'h-full',
        none: '',
      },
    },
  }
);

export function EditorContainer({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof editorContainerVariants>) {
  return (
    <PlateContainer
      className={cn(
        'ignore-click-outside/toolbar',
        editorContainerVariants({ variant }),
        className
      )}
      {...props}
    />
  );
}

const editorVariants = cva(
  cn(
    'group/editor',
    'relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words',
    'rounded-md ring-offset-background focus-visible:outline-none',
    '**:data-slate-placeholder:!top-1/2 **:data-slate-placeholder:-translate-y-1/2 placeholder:text-muted-foreground/80 **:data-slate-placeholder:text-muted-foreground/80 **:data-slate-placeholder:opacity-100!',
    '[&_strong]:font-bold'
  ),
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      disabled: {
        true: 'cursor-not-allowed opacity-50',
      },
      focused: {
        true: 'ring-2 ring-ring ring-offset-2',
      },
      variant: {
        default:
          'size-full px-16 pt-4 pb-72 text-base sm:px-[max(64px,calc(50%-350px))]',
        none: '',
      },
    },
  }
);

export type EditorProps = PlateContentProps &
  VariantProps<typeof editorVariants>;

export const Editor = ({
  className,
  disabled,
  focused,
  variant,
  ref,
  ...props
}: EditorProps & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <PlateContent
    ref={ref}
    className={cn(
      editorVariants({
        disabled,
        focused,
        variant,
      }),
      className
    )}
    disabled={disabled}
    disableDefaultStyles
    {...props}
  />
);

Editor.displayName = 'Editor';