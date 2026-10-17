"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AccountCard } from "@/components/delta/account-card";
import { toListingCard, type ListingCardData } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";

type LookupState = { status: "idle" | "loading" | "unavailable" | "conflict" | "invalid" | "error" } | { status: "ready"; card: ListingCardData };
export function ExactAccountLookup({ gameId, initialNumber = "" }: { gameId: string | null; initialNumber?: string }) {
  const [number, setNumber] = useState(initialNumber);
  const [state, setState] = useState<LookupState>({ status: "idle" });
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; request.current?.abort(); setNumber(initialNumber); setState({ status: "idle" });
    return () => { generation.current++; request.current?.abort(); };
  }, [gameId, initialNumber]);
  async function lookup(event: FormEvent) {
    event.preventDefault(); if (!number.trim()) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const epoch = ++generation.current; setState({ status: "loading" });
    try {
      const listing = await supplyApi.lookupListing(number.trim(), gameId, controller.signal);
      if (!controller.signal.aborted && generation.current === epoch) setState({ status: "ready", card: toListingCard(listing) });
    } catch (error) {
      if (controller.signal.aborted || generation.current !== epoch) return;
      setState({ status: error instanceof SupplyRequestError && [401,403,404].includes(error.status) ? "unavailable" : error instanceof SupplyRequestError && error.status === 409 ? "conflict" : error instanceof SupplyRequestError && error.status === 400 ? "invalid" : "error" });
    }
  }
  return <section className="market-number-lookup" aria-label="按完整账号编号查找">
    <form onSubmit={lookup} aria-busy={state.status === "loading"}>
      <label htmlFor="exact-account-number">完整账号编号</label>
      <input id="exact-account-number" name="number" value={number} maxLength={128} autoComplete="off" placeholder="保留编号中的前导零" aria-describedby="exact-account-number-help" aria-invalid={state.status === "invalid"}
        onChange={event => { generation.current++; request.current?.abort(); setNumber(event.target.value); setState({ status: "idle" }); }} />
      <button type="submit" className="button secondary" disabled={!number.trim() || state.status === "loading"}>{state.status === "loading" ? "正在查找…" : "精确查找编号"}</button>
    </form>
    <p id="exact-account-number-help">下方市场只列当前可租账号；已租、待付款占用或普通下架的公开资料，可用完整编号查找。可查看不代表可新租。</p>
    {state.status === "invalid" ? <p role="alert">编号格式未被接受，请核对完整编号后重试。</p> : null}
    {state.status === "unavailable" ? <p role="status">未找到可公开查看的账号，请核对完整编号。</p> : null}
    {state.status === "conflict" ? <p role="status">该编号暂无法唯一核定，请核对游戏与完整编号。</p> : null}
    {state.status === "error" ? <p role="alert">编号查找未完成，请检查连接后重试；这不代表账号不存在。</p> : null}
    {state.status === "ready" ? <div className="market-number-result" aria-label="精确编号结果"><AccountCard data={state.card} /></div> : null}
  </section>;
}
