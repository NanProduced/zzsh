import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("actual price editor keeps v2/multi-tier read-only in either row order and still saves v1", async () => {
  const browser = new Window({url:"http://127.0.0.1:3101/workspace/supply/rules"});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:browser.getComputedStyle.bind(browser)});
  Object.defineProperty(globalThis,"navigator",{value:browser.navigator,configurable:true});
  const originalFetch = globalThis.fetch;
  const {createRoot} = await import("react-dom/client");
  const vite = await createServer({configFile:false,root:fileURLToPath(new URL("..",import.meta.url)),plugins:[react()],optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,watch:null}});
  let root;
  try {
    const {SupplyRulesView} = await vite.ssrLoadModule("/src/views/supply-rules-view.tsx");
    for (const variant of ["v2", "v2-reversed", "multi-tier-v1", "v1", "v1-missing-tier"]) {
      const readonly = !["v1","v1-missing-tier"].includes(variant);
      const game={id:"game",name:"Fixture",code:"delta",catalogRevision:"1"};
      const priceLines=["STANDARD","VIP","SVIP","DISCOUNT_USER"].flatMap((customerTier,i)=>[
        {priceVersionId:"price",customerTier,itemId:"haff",pricingKind:"HAFF_RATIO",unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null},
        {priceVersionId:"price",customerTier,itemId:"round",pricingKind:"FIXED_UNIT",unitQuantity:"60",buyerUnitAmount:["10","8","7","8"][i],ownerUnitAmount:"4"},
      ]);
      const fixture={game,release:null,priceVersions:[{id:"price",mode:"SPREAD",status:"DRAFT",revision:"2",haffRule:{schema:variant.startsWith("v2")?"haff-ratio-v2":"haff-ratio-v1"},commissionRate:null,roundingPolicy:"HALF_UP_CENT_V1",sealedAt:null}],priceLines:readonly?priceLines:priceLines.slice(0,2),termVersions:[],termOptions:[],agreementVersions:[],items:[{id:"haff",name:"Haff",unit:"HAFF_BASE",enabled:true},{id:"round",name:"Rounds",unit:"ROUND",enabled:true}]};
      if (variant==="v2-reversed") fixture.priceLines.reverse();
      if (variant==="v1-missing-tier") fixture.priceLines=fixture.priceLines.map(({customerTier: _tier,...line})=>line);
      const writes=[];
      globalThis.fetch=async(input,init={})=>{const url=new URL(String(input),browser.location.href);if(init.method && init.method!=="GET")writes.push({path:url.pathname,body:JSON.parse(init.body)});return Response.json(url.pathname.endsWith("/supply/games")?{games:[game]}:fixture);};
      const el=document.createElement("div");document.body.append(el);root=createRoot(el);
      await act(async()=>root.render(createElement(SupplyRulesView,{snapshot:{authenticated:true,security:{isBoss:true},permissions:["supply.rules.edit","supply.quote.internal.read"]},onDirtyChange:()=>{}})));
      const priceSection=[...el.querySelectorAll("section")].find(s=>s.querySelector("h3")?.textContent==="价格版本");
      assert.ok(priceSection);
      if (readonly) {
        assert.match(priceSection.textContent,/仅支持只读查看/);
        assert.equal(priceSection.querySelector("form"),null);
        assert.equal([...el.querySelectorAll("button")].some(b=>["保存价格草稿","演算"].includes(b.textContent)),false);
        const rows=[...priceSection.querySelectorAll("tbody tr")].map(row=>[...row.querySelectorAll("td")].map(cell=>cell.textContent));
        assert.equal(rows.length,8);
        assert.deepEqual(Object.fromEntries(rows.filter(r=>r[0]==="Rounds").map(r=>[r[1],r[4]])),{STANDARD:"10",VIP:"8",SVIP:"7",DISCOUNT_USER:"8"});
        await act(async()=>priceSection.dispatchEvent(new browser.Event("submit",{bubbles:true,cancelable:true})));
        assert.deepEqual(writes,[],"read-only price never issues a mutation or preview");
      } else {
        const save=[...priceSection.querySelectorAll("button")].find(b=>b.textContent==="保存价格草稿");assert.ok(save);
        await act(async()=>save.closest("form").dispatchEvent(new browser.Event("submit",{bubbles:true,cancelable:true})));
        assert.equal(writes.length,1);
        assert.match(writes[0].path,/price-drafts\/price$/);
        assert.equal(writes[0].body.lines.length,2);
        assert.equal(writes[0].body.lines.find(l=>l.itemId==="round").buyerUnitAmount,"10");
      }
      await act(async()=>root.unmount());root=null;el.remove();
    }
  } finally {
    if(root)await act(async()=>root.unmount());
    globalThis.fetch=originalFetch;
    await vite.close();await browser.happyDOM.abort();
  }
});
