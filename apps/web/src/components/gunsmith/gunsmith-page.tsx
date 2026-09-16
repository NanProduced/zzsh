"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard, Crosshair, ImageOff, RotateCw } from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { modeLabelText } from "@/lib/gunsmith-mode";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import type { PublicFirearm, PublicGunsmithCode, PublicGunsmithGame, PublicGunsmithPage, PublicGunsmithCodesPage } from "@/lib/supply-types";
import "./gunsmith.css";

type LoadState<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null };
type AppendState = { status: "idle" | "loading" | "error"; cursor: string | null };

function messageFor(error: unknown): string {
  if (error instanceof SupplyRequestError && error.status === 404) return "该游戏或目录暂不可用。";
  return "目录加载失败，请稍后重试。";
}

function mediaUrl(mediaId: string): string {
  return `/api/supply/media/${encodeURIComponent(mediaId)}/content`;
}

async function copyText(value: string): Promise<boolean> {
  let textarea: HTMLTextAreaElement | null = null;
  try {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Use the native fallback when clipboard permission is unavailable.
      }
    }
    textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

function FirearmImage({ firearm }: { firearm: PublicFirearm }) {
  const [failed, setFailed] = useState(false);
  if (!firearm.mediaId || failed) return <div className="gunsmith-image-fallback" aria-label="暂无可展示图片"><ImageOff size={22} /><span>暂无公开图片</span></div>;
  return <img src={mediaUrl(firearm.mediaId)} alt={`${firearm.name}图片`} loading="lazy" onError={() => setFailed(true)} />;
}

function ModeLabel({ mode }: { mode: PublicGunsmithCode["modeCode"] }) {
  return <span className="gunsmith-mode">{modeLabelText(mode)}</span>;
}

function CodeCard({ item, copied, copyFailed, onCopy }: { item: PublicGunsmithCode; copied: boolean; copyFailed: boolean; onCopy: (value: string, id: string) => void }) {
  return <article className="gunsmith-code-card">
    <div className="gunsmith-code-meta"><ModeLabel mode={item.modeCode} />{item.note ? <span>{item.note}</span> : null}</div>
    <pre className="gunsmith-code-value" tabIndex={0}>{item.code}</pre>
    <button type="button" className="button secondary gunsmith-copy" onClick={() => onCopy(item.code, item.id)}><span aria-hidden="true">{copied ? <Check size={15} /> : <Clipboard size={15} />}</span>{copied ? "已复制" : "复制改枪码"}</button>
    {copyFailed ? <p className="gunsmith-copy-error" role="alert">复制失败，请手动选中上方代码复制。</p> : null}
  </article>;
}

export function GunsmithPage({ initialQuery = "" }: { initialQuery?: string }) {
  const [games, setGames] = useState<LoadState<PublicGunsmithGame[]>>({ status: "loading", data: null });
  const [gameId, setGameId] = useState("");
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState(initialQuery);
  const [classificationId, setClassificationId] = useState("");
  const [firearms, setFirearms] = useState<LoadState<PublicGunsmithPage>>({ status: "idle", data: null });
  const [firearmAppend, setFirearmAppend] = useState<AppendState>({ status: "idle", cursor: null });
  const [selectedId, setSelectedId] = useState("");
  const [codes, setCodes] = useState<LoadState<PublicGunsmithCodesPage>>({ status: "idle", data: null });
  const [codeAppend, setCodeAppend] = useState<AppendState>({ status: "idle", cursor: null });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const firearmRequestSeq = useRef(0);
  const firearmAbort = useRef<AbortController | null>(null);
  const firearmInFlight = useRef<string | null>(null);
  const codeRequestSeq = useRef(0);
  const codeAbort = useRef<AbortController | null>(null);
  const codeInFlight = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGames({ status: "loading", data: null });
    supplyApi.gunsmithGames(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setGames({ status: "ready", data: result.games });
      setGameId((current) => current && result.games.some((game) => game.id === current) ? current : result.games.find((game) => game.code === "delta")?.id ?? result.games[0]?.id ?? "");
    }).catch((error: unknown) => { if (!controller.signal.aborted) setGames({ status: "error", data: null }); });
    return () => controller.abort();
  }, [attempt]);

  const game = games.data?.find((entry) => entry.id === gameId) ?? null;
  const loadFirearms = useCallback((cursor?: string, append = false) => {
    if (!gameId) return () => undefined;
    const requestKey = `${gameId}|${search.trim()}|${classificationId}|${append ? cursor ?? "" : "first"}`;
    if (append && firearmInFlight.current === requestKey) return () => undefined;
    const seq = ++firearmRequestSeq.current;
    firearmAbort.current?.abort();
    const controller = new AbortController();
    firearmAbort.current = controller;
    firearmInFlight.current = requestKey;
    const params = new URLSearchParams({ limit: "12" });
    if (search.trim()) params.set("q", search.trim());
    if (classificationId) params.set("classificationId", classificationId);
    if (cursor) params.set("cursor", cursor);
    if (!append) {
      setFirearms({ status: "loading", data: null });
      setFirearmAppend({ status: "idle", cursor: null });
    } else {
      setFirearmAppend({ status: "loading", cursor: cursor ?? null });
    }
    supplyApi.gunsmithFirearms(gameId, params, controller.signal).then((result) => {
      if (controller.signal.aborted || seq !== firearmRequestSeq.current) return;
      if (append) {
        setFirearms((current) => {
          if (!current.data) return { status: "ready", data: result };
          const known = new Set(current.data.items.map((item) => item.id));
          return { status: "ready", data: { ...result, items: [...current.data.items, ...result.items.filter((item) => !known.has(item.id))] } };
        });
        setFirearmAppend({ status: "idle", cursor: null });
      } else {
        setFirearms({ status: "ready", data: result });
      }
    }).catch(() => {
      if (controller.signal.aborted || seq !== firearmRequestSeq.current) return;
      if (append) setFirearmAppend({ status: "error", cursor: cursor ?? null });
      else {
        setFirearms({ status: "error", data: null });
        setFirearmAppend({ status: "idle", cursor: null });
      }
    }).finally(() => {
      if (firearmAbort.current === controller) firearmAbort.current = null;
      if (firearmInFlight.current === requestKey) firearmInFlight.current = null;
    });
    return () => {
      controller.abort();
      if (firearmAbort.current === controller) {
        firearmAbort.current = null;
        firearmRequestSeq.current += 1;
      }
      if (firearmInFlight.current === requestKey) firearmInFlight.current = null;
    };
  }, [classificationId, gameId, search]);

  useEffect(() => loadFirearms(), [loadFirearms]);
  const firearmItems = firearms.data?.items ?? [];
  useEffect(() => {
    setSelectedId((current) => firearmItems.some((entry) => entry.id === current) ? current : firearmItems[0]?.id ?? "");
  }, [firearms.data?.items]);

  const selected = firearmItems.find((entry) => entry.id === selectedId) ?? null;
  const loadCodes = useCallback((cursor?: string, append = false) => {
    if (!selectedId) return () => undefined;
    const requestKey = `${selectedId}|${append ? cursor ?? "" : "first"}`;
    if (append && codeInFlight.current === requestKey) return () => undefined;
    const seq = ++codeRequestSeq.current;
    codeAbort.current?.abort();
    const controller = new AbortController();
    codeAbort.current = controller;
    codeInFlight.current = requestKey;
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    if (!append) {
      setCodes({ status: "loading", data: null });
      setCodeAppend({ status: "idle", cursor: null });
    } else {
      setCodeAppend({ status: "loading", cursor: cursor ?? null });
    }
    supplyApi.gunsmithCodes(selectedId, params, controller.signal).then((result) => {
      if (controller.signal.aborted || seq !== codeRequestSeq.current) return;
      if (append) {
        setCodes((current) => {
          if (!current.data) return { status: "ready", data: result };
          const known = new Set(current.data.items.map((item) => item.id));
          return { status: "ready", data: { ...result, items: [...current.data.items, ...result.items.filter((item) => !known.has(item.id))] } };
        });
        setCodeAppend({ status: "idle", cursor: null });
      } else {
        setCodes({ status: "ready", data: result });
      }
    }).catch(() => {
      if (controller.signal.aborted || seq !== codeRequestSeq.current) return;
      if (append) setCodeAppend({ status: "error", cursor: cursor ?? null });
      else setCodes({ status: "error", data: null });
    }).finally(() => {
      if (codeAbort.current === controller) codeAbort.current = null;
      if (codeInFlight.current === requestKey) codeInFlight.current = null;
    });
    return () => {
      controller.abort();
      if (codeAbort.current === controller) {
        codeAbort.current = null;
        codeRequestSeq.current += 1;
      }
      if (codeInFlight.current === requestKey) codeInFlight.current = null;
    };
  }, [selectedId]);

  useEffect(() => {
    setCopiedId(null);
    setCopyFailedId(null);
    if (!selectedId) {
      codeRequestSeq.current += 1;
      codeAbort.current?.abort();
      setCodes({ status: "idle", data: null });
      setCodeAppend({ status: "idle", cursor: null });
      return undefined;
    }
    return loadCodes();
  }, [loadCodes, selectedId]);

  useEffect(() => () => {
    firearmRequestSeq.current += 1;
    firearmAbort.current?.abort();
    codeRequestSeq.current += 1;
    codeAbort.current?.abort();
  }, []);

  const submitSearch = (value: string) => {
    setSearch(value.trim().slice(0, 120));
    setQuery(value);
  };
  const retry = () => setAttempt((value) => value + 1);
  const copy = async (value: string, id: string) => {
    setCopyFailedId(null);
    if (await copyText(value)) {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1600);
    } else {
      setCopiedId(null);
      setCopyFailedId(id);
    }
  };
  const classifications = firearms.data?.classifications ?? [];
  const selectedCodeItems = codes.data?.items ?? [];
  const gameUnavailable = games.status === "error" || (games.status === "ready" && !game);
  const breadcrumbs = game ? [{ label: "首页", href: "/" }, { label: game.name }, { label: "改枪码" }] : [{ label: "首页", href: "/" }, { label: "改枪码" }];

  return <ServiceShell surface="browse" contextLabel={null} breadcrumbs={breadcrumbs} title="三角洲改枪码" description="按枪械检索已人工整理的改枪码；复制后请在游戏内自行确认导入结果。" initialQuery={query} onSearch={submitSearch} backHref="/accounts" backLabel="返回账号列表" searchLabel="在改枪码目录中搜索" searchInputLabel="搜索枪械名称或改枪码" searchPlaceholder="搜索枪械名称或改枪码">
    <section className="gunsmith-toolbar" aria-label="改枪码筛选">
      <div className="gunsmith-tool-title"><Crosshair size={20} aria-hidden="true" /><div><h2>枪械目录</h2><p>按枪械名称、分类或别名查找可用改枪码。</p></div></div>
      <div className="gunsmith-filters">
        <label>游戏<select value={gameId} disabled={games.status !== "ready" || (games.data?.length ?? 0) < 2} onChange={(event) => setGameId(event.target.value)}>{(games.data ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <label>枪械搜索<input value={query} maxLength={120} placeholder="名称、别名或备注" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitSearch(event.currentTarget.value); }} /></label>
        <label>分类<select value={classificationId} onChange={(event) => setClassificationId(event.target.value)}><option value="">全部分类</option>{classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <button type="button" className="button secondary" onClick={() => submitSearch(query)}>搜索</button>
      </div>
    </section>

    {games.status === "loading" ? <section className="gunsmith-state" role="status">正在读取改枪码目录…</section> : gameUnavailable ? <section className="gunsmith-state" role="alert"><h2>{games.status === "error" ? "改枪码目录加载失败" : "暂无开放的改枪码目录"}</h2><p>{games.status === "error" ? messageFor(new Error()) : "目前没有可展示的目录，请稍后再来。"}</p><button type="button" className="button secondary" onClick={retry}><RotateCw size={15} />重试</button></section> : firearms.status === "loading" ? <section className="gunsmith-state" role="status">正在读取枪械…</section> : firearms.status === "error" ? <section className="gunsmith-state" role="alert"><h2>枪械列表加载失败</h2><p>请稍后重试。</p><button type="button" className="button secondary" onClick={() => loadFirearms()}><RotateCw size={15} />重试</button></section> :
      <div className="gunsmith-layout">
        <section className="gunsmith-firearms" aria-label="枪械列表">
          {firearmItems.length === 0 ? <div className="gunsmith-state"><h2>没有匹配的枪械</h2><p>可以清空搜索或切换分类。</p></div> : <div className="gunsmith-firearm-grid">{firearmItems.map((item) => <button type="button" key={item.id} className={`gunsmith-firearm-card${item.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(item.id)} aria-pressed={item.id === selectedId}><span className="gunsmith-card-image"><FirearmImage firearm={item} /></span><span className="gunsmith-card-copy"><strong>{item.name}</strong><small>{item.classificationName ?? "未分类"} · {item.codeCount} 个改枪码</small></span></button>)}</div>}
          {firearmAppend.status === "error" ? <div className="gunsmith-inline-error" role="alert"><span>加载更多枪械失败，已保留已加载内容。</span><button type="button" className="button secondary" onClick={() => void loadFirearms(firearmAppend.cursor ?? undefined, true)}>重试</button></div> : firearms.data?.nextCursor ? <button type="button" className="button secondary gunsmith-more" disabled={firearmAppend.status === "loading"} onClick={() => void loadFirearms(firearms.data!.nextCursor!, true)}>{firearmAppend.status === "loading" ? "正在加载…" : "加载更多枪械"}</button> : null}
        </section>
        <section className="gunsmith-detail" aria-label="改枪码详情">
          {selected ? <><div className="gunsmith-detail-heading"><div className="gunsmith-detail-image"><FirearmImage firearm={selected} /></div><div><p className="eyebrow">{selected.classificationName ?? "枪械"}</p><h2>{selected.name}</h2><p className="gunsmith-detail-code">{selected.code}</p></div></div>{codes.status === "loading" ? <p className="gunsmith-state">正在读取改枪码…</p> : codes.status === "error" ? <div className="gunsmith-state" role="alert"><p>改枪码加载失败，请稍后重试。</p><button type="button" className="button secondary" onClick={() => void loadCodes()}>重试</button></div> : <>{codeAppend.status === "error" ? <div className="gunsmith-inline-error" role="alert"><span>加载更多改枪码失败，已保留已加载内容。</span><button type="button" className="button secondary" onClick={() => void loadCodes(codeAppend.cursor ?? undefined, true)}>重试</button></div> : null}{selectedCodeItems.length > 0 ? <div className="gunsmith-code-list">{selectedCodeItems.map((item) => <CodeCard key={item.id} item={item} copied={copiedId === item.id} copyFailed={copyFailedId === item.id} onCopy={(value, id) => void copy(value, id)} />)}</div> : <p className="gunsmith-state">当前枪械暂无可公开展示的改枪码。</p>}{codes.data?.nextCursor ? <button type="button" className="button secondary gunsmith-more" disabled={codeAppend.status === "loading"} onClick={() => void loadCodes(codes.data!.nextCursor!, true)}>{codeAppend.status === "loading" ? "正在加载…" : "加载更多改枪码"}</button> : null}</>}<p className="gunsmith-disclaimer">改枪码是人工整理的原始文本，请在游戏内自行确认导入结果。</p></> : <div className="gunsmith-state"><Crosshair size={28} /><h2>选择一把枪械</h2><p>从左侧目录查看可用改枪码。</p></div>}
        </section>
      </div>}
  </ServiceShell>;
}
