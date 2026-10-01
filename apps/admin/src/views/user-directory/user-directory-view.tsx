import { useLayoutEffect, useRef } from 'react';
import { type PageProps, type UserDirectoryData } from './user-directory-shared';
import { directoryAdapter } from './user-directory-data';
import { UserList } from './user-directory-list';
import { UserDetail } from './user-directory-detail';
import './user-directory.css';
function UserDirectorySurface({ adapter, props }: { adapter: UserDirectoryData; props: PageProps }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = ref.current?.closest('.workspace-page'); if (!container) return;
    const desired = adapter.scroll.get(props.tab.id) ?? 0;
    let restored = false;
    const restore = () => {
      if (container.scrollHeight - container.clientHeight < desired) return;
      container.scrollTop = desired; restored = true; observer.disconnect();
    };
    // The loading skeleton can be shorter than the saved scroll position; restore once content fits.
    const observer = new ResizeObserver(restore);
    observer.observe(ref.current!); restore();
    const record = () => { if (restored) adapter.scroll.set(props.tab.id, container.scrollTop); };
    container.addEventListener('scroll', record);
    return () => { observer.disconnect(); container.removeEventListener('scroll', record); };
  }, [adapter, props.tab.id]);
  return <div ref={ref} className="ud-directory-view">{props.tab.kind === 'users' ? <UserList {...props} adapter={adapter} /> : <UserDetail {...props} adapter={adapter} />}</div>;
}

export function UserDirectoryView(props:PageProps) {
  const {key,adapter}=directoryAdapter(props.snapshot);
  return <UserDirectorySurface key={`${key}:${props.tab.id}`} adapter={adapter} props={props}/>;
}

