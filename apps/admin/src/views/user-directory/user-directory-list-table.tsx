import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ListTable,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/admin-list';
import { Hint } from './user-directory-shared';

/** 表头排序：即时应用并回第 1 页，只使用已生效条件。 */
export function SortHeader({ label, column, sort, onSort, hint }: { label: string; column: string; sort: string; onSort: (next: string) => void; hint?: string }) {
  const active = sort.startsWith(`${column}_`);
  const ascending = active && sort.endsWith('_asc');
  return (
    <TableHead aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={`ud-sort-header ${active ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label={`按${label}排序`}
        onClick={() => onSort(`${column}_${ascending ? 'desc' : 'asc'}`)}
      >
        {label}
        <span className="ud-sort-indicator" aria-hidden>{active ? (ascending ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />) : <ArrowUpDownIcon size={12} />}</span>
      </Button>
      {hint ? <Hint label={`${label}口径`}>{hint}</Hint> : null}
    </TableHead>
  );
}

const TABLE_HEADERS = ['用户', '账号与实名', '会员与礼遇', '信用', '可用余额', '当前业务', '注册时间', '操作'];
export function UserListSkeleton() {
  return (
    <ListTable className="ud-table-wrap ud-user-table" loading aria-label="用户列表加载中">
      <Table className="admin-list-table">
        <TableHeader><TableRow>{TABLE_HEADERS.map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
        <TableBody aria-hidden="true">{Array.from({ length: 8 }, (_, row) => (
          <TableRow key={row}>{TABLE_HEADERS.map((label, column) => <TableCell key={label}>
            {column === 0 ? <div className="flex gap-3"><Skeleton className="size-9 shrink-0" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div> : <Skeleton className="h-4 w-3/4" />}
          </TableCell>)}</TableRow>
        ))}</TableBody>
      </Table>
    </ListTable>
  );
}

/** 合并业务列的三个小排序：租入、出租、上架各自独立。 */
export function BusinessSortHeader({ sort, onSort }: { sort: string; onSort: (next: string) => void }) {
  const columns: [string, string][] = [['renter_current', '租入'], ['owner_current', '出租'], ['published', '上架']];
  const active = columns.find(([column]) => sort.startsWith(`${column}_`));
  const ascending = Boolean(active && sort.endsWith('_asc'));
  return (
    <TableHead aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <div className="ud-business-head">
        <span className="text-xs font-medium">当前业务</span>
        <div className="ud-business-head-pills">
          {columns.map(([column, label]) => {
            const on = sort.startsWith(`${column}_`);
            const up = on && sort.endsWith('_asc');
            return (
              <Button
                key={column}
                type="button"
                variant={on ? 'secondary' : 'ghost'}
                size="xs"
                className={`ud-sort-header h-6 px-1 text-xs ${on ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                aria-label={`按${label}排序`}
                onClick={() => onSort(`${column}_${up ? 'desc' : 'asc'}`)}
              >
                {label}
                <span className="ud-sort-indicator ml-0.5" aria-hidden>{on ? (up ? <ArrowUpIcon size={11} /> : <ArrowDownIcon size={11} />) : <ArrowUpDownIcon size={11} />}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </TableHead>
  );
}

/** 窄屏复用同一组表头排序，当前排序保持可见。 */
export function MobileSortRow({ sort, onSort, localFiling = false }: { sort: string; onSort: (next: string) => void; localFiling?: boolean }) {
  const columns: [string, string][] = [['registered', localFiling ? '本地建档时间' : '注册时间'], ['balance', '可用余额'], ['credit', '信用'], ['renter_current', '租入'], ['owner_current', '出租'], ['published', '上架']];
  return (
    <div className="ud-mobile-sorts" role="group" aria-label="排序">
      {columns.map(([column, label]) => {
        const on = sort.startsWith(`${column}_`);
        const up = on && sort.endsWith('_asc');
        return (
          <Button key={column} type="button" variant="ghost" size="xs" className="ud-sort-header" aria-label={`按${label}排序`} onClick={() => onSort(`${column}_${up ? 'desc' : 'asc'}`)}>
            {label}
            <span className="ud-sort-indicator" aria-hidden>{on ? (up ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />) : <ArrowUpDownIcon size={12} />}</span>
          </Button>
        );
      })}
    </div>
  );
}
