import { useEffect, useRef, useState } from 'react';
import { EyeIcon, ShieldAlertIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { AdminApiError } from '../../api';
import { type UserDirectoryBff, type User, type UserNotePage, type SensitiveProfile } from './user-directory-data';
import { Message, errorText, time, useDirectoryRequest } from './user-directory-shared';

type Write = { path: string; body?: Record<string, unknown>; method: 'POST' | 'DELETE'; key: string };
type UserIntent = Write & { subject: string; userId: string; adminId: string; phase: 'unknown' | 'readback'; receipt?: Record<string, unknown> };
const userCommands = new Map<string, UserIntent>();
const userCommandFlights = new Map<string, string>();
const userCommandListeners = new Set<(subject: string) => void>();
const invalidUserCommands = new Set<string>();
const commandStorageKey = (subject: string) => `zzsh.admin.user-command.${encodeURIComponent(subject)}`;
const notifyCommand = (subject: string) => { for (const listener of userCommandListeners) listener(subject); };
const sameCommand = (a: Write, b: Write) => a.key === b.key && a.path === b.path && a.method === b.method && JSON.stringify(a.body) === JSON.stringify(b.body);
const commandId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

function userCommandKind(command: Write, userId: string): 'risk' | 'create' | 'delete' {
  const prefix = encodeURIComponent(userId), body = command.body;
  if (!commandId(userId) || !commandId(command.key)) throw new Error('原操作记录无效，请保留记录并联系管理员核对。');
  if (command.path === `${prefix}/risk-flag` && command.method === 'POST' && body && Object.keys(body).length === 2
    && typeof body.flagged === 'boolean' && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0) return 'risk';
  if (command.path === `${prefix}/notes` && command.method === 'POST' && body && Object.keys(body).length === 1
    && typeof body.text === 'string' && Array.from(body.text.trim()).length >= 2 && Array.from(body.text).length <= 1000) return 'create';
  const noteId = command.path.startsWith(`${prefix}/notes/`) ? command.path.slice(`${prefix}/notes/`.length) : '';
  if (command.method === 'DELETE' && commandId(noteId) && command.body === undefined) return 'delete';
  throw new Error('本页不支持这项操作，尚未提交。');
}

function restoreUserCommand(subject: string, userId: string): UserIntent | undefined {
  const memory = userCommands.get(subject);
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(commandStorageKey(subject));
    if (!raw) { invalidUserCommands.delete(subject); return; }
    const intent = JSON.parse(raw) as UserIntent;
    if (!intent || intent.subject !== subject || intent.userId !== userId || !commandId(intent.adminId) || JSON.parse(subject)[0] !== intent.adminId
      || !['unknown', 'readback'].includes(intent.phase) || typeof intent.path !== 'string' || typeof intent.key !== 'string') throw new Error();
    userCommandKind(intent, userId);
    if (intent.phase === 'readback' && (!intent.receipt || typeof intent.receipt !== 'object' || Array.isArray(intent.receipt))) throw new Error();
    invalidUserCommands.delete(subject); userCommands.set(subject, intent); return intent;
  } catch { invalidUserCommands.add(subject); return; }
}

function rememberUserCommand(intent: UserIntent): boolean {
  const current = userCommands.get(intent.subject);
  if (current && (!sameCommand(current, intent) || current.phase === 'readback' && intent.phase === 'unknown')) return false;
  // An accepted receipt must survive an unmount even when updating session storage fails.
  if (intent.phase === 'readback') userCommands.set(intent.subject, intent);
  try {
    sessionStorage.setItem(commandStorageKey(intent.subject), JSON.stringify(intent));
    userCommands.set(intent.subject, intent); notifyCommand(intent.subject); return true;
  } catch { notifyCommand(intent.subject); return false; }
}

function forgetUserCommand(intent: UserIntent): boolean {
  const current = userCommands.get(intent.subject);
  if (!current || !sameCommand(current, intent)) return false;
  try {
    const raw = sessionStorage.getItem(commandStorageKey(intent.subject));
    if (raw && !sameCommand(JSON.parse(raw) as Write, intent)) return false;
    sessionStorage.removeItem(commandStorageKey(intent.subject));
    userCommands.delete(intent.subject); invalidUserCommands.delete(intent.subject); notifyCommand(intent.subject); return true;
  } catch { return false; }
}

function userCommandReceipt(intent: UserIntent, response: Record<string, unknown>): Record<string, unknown> {
  const kind = userCommandKind(intent, intent.userId);
  if (response.userId !== intent.userId) throw new Error('操作回执暂时无法核对，请保留原请求。');
  if (kind === 'risk' && response.flagged === intent.body!.flagged && typeof response.changed === 'boolean' && Number.isSafeInteger(response.revision)
    && Number(response.revision) === Number(intent.body!.expectedRevision) + (response.changed ? 1 : 0)) {
    return { userId: intent.userId, flagged: response.flagged, changed: response.changed, revision: response.revision };
  }
  if (kind === 'create' && commandId(response.noteId) && response.created === true) return { userId: intent.userId, noteId: response.noteId, created: true };
  if (kind === 'delete' && response.noteId === intent.path.split('/').at(-1) && response.deleted === true) return { userId: intent.userId, noteId: response.noteId, deleted: true };
  throw new Error('操作回执暂时无法核对，请保留原请求。');
}

async function readUserCommand(adapter: UserDirectoryBff, intent: UserIntent): Promise<void> {
  const receipt = userCommandReceipt(intent, intent.receipt ?? {});
  if (userCommandKind(intent, intent.userId) === 'risk') {
    const fresh = await adapter.detail(intent.userId, new AbortController().signal);
    if (fresh.id !== intent.userId || typeof fresh.riskFlag !== 'boolean' || !Number.isSafeInteger(fresh.riskRevision) || Number(fresh.riskRevision) < Number(receipt.revision)
      || fresh.riskRevision === receipt.revision && fresh.riskFlag !== receipt.flagged) throw new Error('标记记录尚未更新，请稍后重新读取。');
    return; // The original receipt proves this command even if a later operation changed the flag again.
  }
  const note = await adapter.note(intent.userId, String(receipt.noteId), new AbortController().signal);
  if (note.id !== receipt.noteId || note.userId !== intent.userId || typeof note.deleted !== 'boolean') throw new Error('备注回读暂时无法核对。');
  if (receipt.deleted === true) {
    if (!note.deleted) throw new Error('备注记录尚未确认，请稍后重新读取。');
  } else {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(intent.body!.text)));
    const expected = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (note.author?.id !== intent.adminId || note.bodyDigest !== expected || !note.deleted && note.text !== intent.body!.text) throw new Error('备注记录尚未确认，请稍后重新读取。');
  }
}

/** A lost response retains the exact command until the administrator retries it. */
export function useUserCommand(adapter: UserDirectoryBff, userId: string, kind: 'risk' | 'notes', done: () => void) {
  const subject = JSON.stringify([adapter.snapshot.adminUserId, adapter.snapshot.session.id, userId]);
  const enabled = adapter.snapshot.security.status === 'ACTIVE' && !adapter.snapshot.security.passwordChangeRequired && !adapter.snapshot.session.locked;
  const [pending, setPending] = useState<UserIntent | undefined>(() => restoreUserCommand(subject, userId));
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState({ subject, text: '' });
  const [acceptedSubject, setAcceptedSubject] = useState<string>();
  const [storageBlocked, setStorageBlocked] = useState(invalidUserCommands.has(subject));
  const view = useRef({ subject, enabled, mounted: true });
  const stateSubject = useRef(subject);
  view.current.subject = subject; view.current.enabled = enabled;
  const current = (intent: UserIntent) => view.current.mounted && view.current.subject === intent.subject && view.current.enabled;
  useEffect(() => { view.current.mounted = true; return () => { view.current.mounted = false; }; }, []);
  useEffect(() => {
    const sync = (changedSubject: string) => {
      if (changedSubject !== subject || view.current.subject !== subject || !view.current.mounted) return;
      const saved = restoreUserCommand(subject, userId); setPending(saved); setWorking(userCommandFlights.has(subject)); setStorageBlocked(invalidUserCommands.has(subject));
    };
    stateSubject.current = subject; sync(subject); setAcceptedSubject(undefined); setNotice({ subject, text: '' }); userCommandListeners.add(sync);
    return () => { userCommandListeners.delete(sync); };
  }, [subject, enabled, userId]);
  const activePending = pending?.subject === subject ? pending : undefined;
  const owned = activePending && (kind === 'risk' ? userCommandKind(activePending, userId) === 'risk' : userCommandKind(activePending, userId) !== 'risk');
  const busy = working && stateSubject.current === subject || userCommandFlights.has(subject) || !enabled;
  const blocked = storageBlocked && stateSubject.current === subject || !!activePending && !owned;
  const setMessage = (text: string) => setNotice({ subject, text });
  async function submit(command: Write) {
    if (busy || !view.current.enabled || view.current.subject !== subject || !view.current.mounted) return;
    const saved = restoreUserCommand(subject, userId);
    if (invalidUserCommands.has(subject)) { setStorageBlocked(true); setMessage('浏览器中的待核对记录无法读取，尚未提交新操作。'); return; }
    if (saved && !sameCommand(saved, command)) { setPending(saved); setMessage('上一笔用户操作尚未确认，请先核对。'); return; }
    const intent: UserIntent = saved ?? { ...command, ...(command.body ? { body: { ...command.body } } : {}), subject, userId, adminId: adapter.snapshot.adminUserId, phase: 'unknown' };
    const rechecking = !!saved;
    try {
      if ((userCommandKind(intent, userId) === 'risk') !== (kind === 'risk')) throw new Error('请先在对应操作入口核对上一笔请求。');
    } catch (error) { setMessage((error as Error).message); return; }
    if (!saved && !rememberUserCommand(intent)) { setMessage('浏览器无法保存原操作，尚未提交。请检查站点存储。'); return; }
    userCommandFlights.set(subject, intent.key); notifyCommand(subject); setPending(intent); setAcceptedSubject(undefined); setMessage('');
    try {
      if (intent.phase === 'unknown') {
        const response = await adapter.userCommand(intent.path, intent.body, intent.method, intent.key, new AbortController().signal);
        const receipt = userCommandReceipt(intent, response);
        intent.phase = 'readback'; intent.receipt = receipt;
        rememberUserCommand(intent);
      }
      if (!current(intent)) return;
      await readUserCommand(adapter, intent);
      if (!forgetUserCommand(intent)) throw new Error('记录已核对，但浏览器暂时无法清除待核对标记，请稍后重新读取。');
      if (current(intent)) { setPending(undefined); setAcceptedSubject(subject); setMessage('已保存'); done(); }
    } catch (failure) {
      const unknown = !(failure instanceof AdminApiError) || failure.status === 0 || failure.status >= 500 || [401, 408, 423].includes(failure.status);
      const retain = intent.phase === 'readback' || unknown || rechecking;
      if (!retain) forgetUserCommand(intent);
      if (current(intent)) {
        setPending(restoreUserCommand(subject, userId));
        setMessage(intent.phase === 'readback' ? `操作已受理，请重新读取记录。${errorText(failure)}` : retain ? '结果尚未确认，请核对原操作。' : errorText(failure));
      }
    } finally {
      if (userCommandFlights.get(subject) === intent.key) userCommandFlights.delete(subject);
      notifyCommand(subject); if (current(intent)) setWorking(false);
    }
  }
  return { pending: owned ? activePending : undefined, busy, blocked, message: blocked ? '上一笔用户操作尚未确认，请先完成核对。' : (notice.subject === subject ? notice.text : '') || (activePending ? activePending.phase === 'readback' ? '操作已受理，请重新读取记录。' : '上一笔操作结果待确认，请核对原操作。' : ''), accepted: acceptedSubject === subject, submit,
    reset() { if (!restoreUserCommand(subject, userId) && !busy) { setAcceptedSubject(undefined); setMessage(''); } } };
}

export function UserRiskAction({ adapter, user, changed }: { adapter: UserDirectoryBff; user: User; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const action = useUserCommand(adapter, user.id, 'risk', changed);
  if (!adapter.has('user.risk.manage')) return null;
  return <>
    <Button variant="outline" size="sm" disabled={action.blocked} onClick={() => { action.reset(); setOpen(true); }}><ShieldAlertIcon size={14} />{user.riskFlag ? '取消高危标记' : '标记高危'}</Button>
    <Dialog open={open} onOpenChange={value => { if (!action.busy) setOpen(value); }}>
      <DialogContent><DialogHeader><DialogTitle>{user.riskFlag ? '取消高危标记' : '标记为高危用户'}</DialogTitle><DialogDescription>仅后台可见，不改变账号、信用或订单状态。</DialogDescription></DialogHeader>
        {action.message ? <Message kind={action.accepted ? 'success' : 'error'} title={action.message} /> : null}
        <div className="udv-actions"><Button variant="outline" disabled={action.busy} onClick={() => setOpen(false)}>关闭</Button>
          {!action.accepted ? <Button disabled={action.busy || action.blocked || !action.pending && user.riskRevision === undefined} onClick={() => void action.submit(action.pending ?? { path: `${encodeURIComponent(user.id)}/risk-flag`, body: { flagged: !user.riskFlag, expectedRevision: user.riskRevision }, method: 'POST', key: crypto.randomUUID() })}>{action.busy ? '处理中…' : action.pending?.phase === 'readback' ? '重新读取' : action.pending ? '核对原操作' : '确认'}</Button> : null}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function SensitiveIdentity({ adapter, user, active }: { adapter: UserDirectoryBff; user: User; active: boolean }) {
  const subject=`${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${user.id}`;
  const enabled=active&&!adapter.snapshot.session.locked&&adapter.snapshot.security.status==='ACTIVE';
  const [stored, setStored] = useState<{subject:string;data:SensitiveProfile}>();
  const profile=enabled&&stored?.subject===subject?stored.data:undefined;
  const setProfile=(data:SensitiveProfile|undefined)=>setStored(data?{subject,data}:undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  // Plaintext never survives a tab switch, hidden window, blur, or the short display interval.
  useEffect(() => {
    const clear = () => { controller.current?.abort(); setProfile(undefined); setBusy(false); };
    window.addEventListener('blur', clear); document.addEventListener('visibilitychange', clear);
    return () => { clear(); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', clear); };
  }, [subject]);
  useEffect(() => { if (!enabled) { controller.current?.abort(); setProfile(undefined); setBusy(false); setError(''); } }, [enabled,subject]);
  useEffect(() => { if (!profile) return; const timer = window.setTimeout(() => setProfile(undefined), 60_000); return () => window.clearTimeout(timer); }, [profile]);
  async function reveal() {
    if (profile) { setProfile(undefined); return; }
    setBusy(true); setError(''); const request = new AbortController(); controller.current = request;
    try { const result = await adapter.sensitiveProfile(user.id, request.signal); if (!request.signal.aborted) { if(result.userId!==user.id)throw new Error('资料所属用户不匹配'); setProfile(result); } }
    catch (failure) { if (!request.signal.aborted) setError(errorText(failure)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <section className="udv-identity" aria-label="实名资料">
    <div className="udv-heading"><h2>实名资料</h2>{adapter.has('user.identity.sensitive.read') ? <Button variant="outline" size="sm" disabled={busy || !enabled} onClick={() => void reveal()}><EyeIcon size={14} />{busy ? '读取中…' : profile ? '隐藏明文' : '查看明文'}</Button> : null}</div>
    {error ? <Message kind="error" title="资料读取失败">{error}</Message> : null}
    <dl className="udv-identity-fields"><div><dt>真实姓名</dt><dd>{profile?.realName ?? '暂无资料'}</dd></div><div><dt>身份证号</dt><dd>{profile?.identityNumber ?? '暂无资料'}</dd></div><div><dt>手机号</dt><dd>{profile?.phoneNumber ?? user.phoneMasked}</dd></div></dl>
    <p className="udv-muted">历史实名记录仅保留验证结果，姓名和证件资料暂未收录。</p>
  </section>;
}

export function UserNotes({ adapter, user, refreshNonce }: { adapter: UserDirectoryBff; user: User; refreshNonce: number }) {
  const [revision, setRevision] = useState(0);
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState<string>();
  const request = useDirectoryRequest(`${user.id}:notes:${refreshNonce}:${revision}:${cursor ?? ''}`, signal => adapter.notes(user.id, signal, cursor));
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const action = useUserCommand(adapter, user.id, 'notes', () => { setText(''); setConfirmDelete(undefined); setCursor(undefined); setRevision(value => value + 1); });
  const data: UserNotePage | undefined = request.result.state === 'ready' ? request.result.data : undefined;
  return <section className="udv-notes" aria-label="内部备注">
    <div className="udv-heading"><h2>内部备注</h2><span className="udv-muted">仅后台可见</span></div>
    {action.message ? <Message kind={action.accepted ? 'success' : 'error'} title={action.message} /> : null}
    {request.result.state === 'loading' ? <p role="status">正在读取备注…</p> : request.result.state === 'error' ? <Message kind="error" title="备注读取失败" retry={request.retry}>{errorText(request.result.error)}</Message> : data?.items?.length ? <ul className="udv-note-list">{data.items.map(note => <li key={note.id}>
      <div><strong>{note.author.displayName}</strong><time>{time(note.createdAt)}</time></div><p>{note.text}</p>
      {note.canDelete ? confirmDelete === note.id ? <span className="udv-actions"><Button variant="outline" size="sm" disabled={action.busy || action.blocked || !!action.pending} onClick={() => setConfirmDelete(undefined)}>取消</Button><Button variant="destructive" size="sm" disabled={action.busy || action.blocked || !!action.pending} onClick={() => { action.reset(); void action.submit({ path: `${encodeURIComponent(user.id)}/notes/${encodeURIComponent(note.id)}`, method: 'DELETE', key: crypto.randomUUID() }); }}>确认删除</Button></span> : <Button variant="ghost" size="sm" disabled={action.busy || action.blocked || !!action.pending} aria-label={`删除 ${note.author.displayName} 的备注`} onClick={() => { action.reset(); setConfirmDelete(note.id); }}><Trash2Icon size={14} />删除</Button> : null}
    </li>)}</ul> : <p className="udv-muted">暂无内部备注</p>}
    {data?.nextCursor || cursor ? <div className="udv-actions"><Button variant="outline" size="sm" disabled={!cursor || !!action.pending} onClick={() => setCursor(undefined)}>回到最新</Button><Button variant="outline" size="sm" disabled={!data?.nextCursor || !!action.pending} onClick={() => setCursor(data?.nextCursor ?? undefined)}>更早备注</Button></div> : null}
    {action.pending ? <Button variant="outline" disabled={action.busy} onClick={() => void action.submit(action.pending!)}>{action.pending.phase === 'readback' ? '重新读取' : '核对原操作'}</Button> : data?.capabilities?.canCreate ? <form className="udv-note-form" onSubmit={event => { event.preventDefault(); action.reset(); void action.submit({ path: `${encodeURIComponent(user.id)}/notes`, body: { text: text.trim() }, method: 'POST', key: crypto.randomUUID() }); }}><Field label="添加备注"><Textarea value={text} maxLength={1000} placeholder="记录处理情况，用户不可见" onChange={event => setText(event.target.value)} disabled={action.busy || action.blocked} /></Field><Button type="submit" disabled={action.busy || action.blocked || Array.from(text.trim()).length < 2}>{action.busy ? '保存中…' : '添加备注'}</Button></form> : null}
  </section>;
}
