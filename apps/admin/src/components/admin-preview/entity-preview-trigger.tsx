import * as React from 'react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EntityPreviewTriggerProps {
  trigger: React.ReactElement;
  content: React.ReactNode;
  touchLabel?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  enableTouchButton?: boolean;
}

/**
 * 统一实体预览触发容器：
 * 1. 桌面端：HoverCard 鼠标 hover / 键盘 focus 触发（Trigger 配置 260ms 打开延迟、180ms 关闭延迟，安全移入卡片点击，Esc 关闭）；
 * 2. 触摸端 / 无 hover：提供显式信息预览按钮，点击弹出同一份 Popover 内容，与直接点击下钻链接隔离。
 */
export function EntityPreviewTrigger({
  trigger,
  content,
  touchLabel = '预览对象信息',
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset = 0,
  className,
  enableTouchButton = true,
}: EntityPreviewTriggerProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 group/preview', className)}>
      <HoverCard>
        <HoverCardTrigger delay={260} closeDelay={180} render={trigger} />
        <HoverCardContent
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          className="w-auto p-3 bg-popover border border-border shadow-xl rounded-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </HoverCardContent>
      </HoverCard>

      {enableTouchButton && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={touchLabel}
                onClick={(e) => e.stopPropagation()}
                className="size-5 p-0 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 cursor-pointer sm:opacity-0 sm:group-hover/preview:opacity-80 sm:focus-visible:opacity-100 transition-opacity"
              >
                <Info className="size-3" aria-hidden="true" />
              </Button>
            }
          />
          <PopoverContent
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            className="w-auto p-3 bg-popover border border-border shadow-xl rounded-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {content}
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}
