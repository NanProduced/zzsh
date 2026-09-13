"use client";
import { useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
// Owner-approved draft statistics; replace this source with the public backend response.
const DEMO_STATS = { visits: 12580, transactions: 150960, listings: 3086 };
export default function HomePage() {
  const [stats,setStats]=useState(DEMO_STATS);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)setStats(v=>({visits:v.visits+3,transactions:v.transactions+1,listings:v.listings}));},5000);return()=>clearInterval(timer);},[]);
  return <PortalHome stats={stats} statsAreDemo />;
}
