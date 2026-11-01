import assert from "node:assert/strict";
import {test,after} from "node:test";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Window} from "happy-dom";
import {act,createElement,useRef,useState} from "react";
import {createServer} from "vite";
import react from "@vitejs/plugin-react";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const browser=new Window({url:"http://127.0.0.1:4311"});
Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,getComputedStyle:browser.getComputedStyle.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,"navigator",{value:browser.navigator,configurable:true});
globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
const {createRoot}=await import("react-dom/client");
const vite=await createServer({root:repo,configFile:false,plugins:[react()],resolve:{alias:{"@":path.join(repo,"apps/admin/src")}},server:{middlewareMode:true,hmr:false,ws:false}});
const {MediaMessage}=await vite.ssrLoadModule("/packages/ui/src/message-media.tsx");
const model=await vite.ssrLoadModule("/apps/admin/src/views/im-support-management-model.ts");
const {SupportMessageBody}=await vite.ssrLoadModule("/apps/admin/src/views/im-support-message-body.tsx");
after(async()=>{await vite.close();await browser.happyDOM.abort();});

test("preview chunk loading and failure keep the workspace, isolate Escape and can retry",async t=>{
 const chunks=[],uncaught=[],caught=[];let parentEscapes=0,closed=0;
 globalThis.__mediaPreviewChunkLoad=()=>new Promise((resolve,reject)=>chunks.push({resolve,reject}));
 const faulty=await createServer({root:repo,configFile:false,plugins:[{name:"media-chunk-fault",enforce:"pre",transform(code,id){if(id.replaceAll("\\","/").endsWith("/packages/ui/src/message-media.tsx"))return code.replace('import("./media-lightbox")','globalThis.__mediaPreviewChunkLoad()');}},react()],resolve:{alias:{"@":path.join(repo,"apps/admin/src")}},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false}});
 const {MediaPreview}=await faulty.ssrLoadModule("/packages/ui/src/message-media.tsx");
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host,{onUncaughtError:error=>uncaught.push(error),onCaughtError:error=>caught.push(error)});
 t.after(async()=>{await act(async()=>root.unmount());host.remove();await faulty.close();delete globalThis.__mediaPreviewChunkLoad;});
 const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,35));});
 function Harness(){const[open,setOpen]=useState(false),trigger=useRef(null);return createElement("section",{onKeyDown:event=>{if(event.key==="Escape")parentEscapes++;}},
  createElement("p",null,"聊天仍在"),createElement("textarea",{defaultValue:"待发送草稿"}),
  createElement("button",{ref:trigger,onClick:()=>setOpen(true)},"打开图片"),
  createElement(MediaPreview,{item:open?{kind:"image",url:"https://example.test/picture.png",name:"图片"}:null,returnFocus:trigger.current,onClose:()=>{closed++;setOpen(false);}}));}
 await act(async()=>root.render(createElement(Harness)));const trigger=host.querySelector("button");trigger.focus();
 await act(async()=>trigger.click());await settle();
 assert.ok(host.querySelector("dialog.message-lightbox-loading[open]"));
 assert.ok([...host.querySelectorAll("button")].some(b=>b.textContent==="关闭预览"));
 await act(async()=>trigger.dispatchEvent(new browser.KeyboardEvent("keydown",{key:"Escape",bubbles:true})));await settle();
 assert.equal(closed,1);assert.equal(parentEscapes,0);assert.equal(document.activeElement,trigger);
 await act(async()=>chunks[0].resolve({default:()=>null}));
 await act(async()=>trigger.click());await settle();
 await act(async()=>chunks[1].reject(new Error("PREVIEW_CHUNK_UNAVAILABLE")));await settle();
 assert.equal(uncaught.length,0);assert.equal(caught.length,1);
 assert.match(host.textContent,/聊天仍在|预览组件加载失败/);assert.equal(host.querySelector("textarea").value,"待发送草稿");
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="重新加载").click());await settle();
 assert.equal(chunks.length,3,"retry starts a fresh lazy attempt");
 await act(async()=>chunks[2].resolve({default:()=>createElement("div",{className:"recovered-viewer"},"查看器已就绪")}));await settle();
 assert.ok(host.querySelector(".recovered-viewer"));assert.equal(host.querySelector(".message-lightbox-loading"),null);
 assert.equal(host.querySelector("textarea").value,"待发送草稿");assert.equal(uncaught.length,0);
});
async function mount(t,element){const host=document.createElement("div");document.body.append(host);const root=createRoot(host);await act(async()=>root.render(element));t.after(async()=>{await act(async()=>root.unmount());host.remove();});return host;}
const video={mediaId:"media-video",kind:"video",name:"review.mp4",mimeType:"video/mp4",size:2048,durationMs:2000,url:"https://example.test/review.mp4"};

test("patrol normalizes real media attachments and rejects unsafe URLs",()=>{
 const base={messageClientId:"a",messageServerId:"4301564702653153301",senderId:"account",createTime:1000,messageType:3,attachment:{name:"review.mp4",size:2048,duration:2000,url:video.url}};
 const first=model.parseAuditMessages({messages:[{...base,sender:{displayName:"客服甲",avatar:null,role:"ADMIN"}}]}).messages[0];assert.equal(first.media.kind,"video");assert.equal(first.media.durationMs,2000);assert.equal(first.sender.displayName,"客服甲");
 assert.equal(model.parseAuditMessages({messages:[{...base,attachment:undefined,media:video}]}).messages[0].media.url,video.url);
 const bad=model.parseAuditMessages({messages:[{...base,attachment:{...base.attachment,url:"javascript:bad"}}]}).messages[0];assert.equal(bad.media,undefined);assert.equal(bad.attachment,undefined);
 const revoked=model.parseAuditMessages({messages:[{...base,revoked:true}]}).messages[0];assert.equal(revoked.text,"");assert.equal(revoked.media,undefined);
});
test("patrol cursor uses API contract and merge preserves ascending 64-bit IDs and revocation",()=>{
 assert.equal(model.auditMessagesPath("viewer|2|9001","opaque"),"/im/messages?conversationId=viewer%7C2%7C9001&mode=patrol&cursor=opaque");
 const msg=id=>({messageClientId:"c"+id,messageServerId:id,senderId:"a",createTime:1000,messageType:0,text:"hello"});
 const page=model.parseAuditMessages({messages:[msg("10000000000000000000"),msg("9999999999999999999")]});assert.deepEqual(page.messages.map(m=>m.messageServerId),["9999999999999999999","10000000000000000000"]);
 const merged=model.mergeAuditMessages([{...page.messages[0],text:"",revoked:true}],page.messages);assert.equal(merged.length,2);assert.equal(merged[0].revoked,true);assert.equal(merged[0].text,"");
});
test("file is a single whole-card safe download outside a bubble",async t=>{
 const media={mediaId:"file",kind:"file",name:"账单.pdf",mimeType:"application/pdf",size:4096,url:"https://example.test/bill.pdf"};const host=await mount(t,createElement(SupportMessageBody,{message:{messageType:6,media}}));
 const card=host.querySelector("a.message-media-file");assert.ok(card);assert.equal(card.href,media.url);assert.equal(card.target,"_blank");assert.match(card.rel,/noopener/);assert.equal(card.download,media.name);assert.equal(card.closest('[data-slot="bubble"]'),null);assert.equal(card.querySelector("a"),null);assert.equal(card.querySelector("p"),null);
 assert.match(card.textContent,/点击下载/,"the single card states the download action");
 assert.equal(card.title,`下载 ${media.name}`);assert.equal(card.querySelector(".message-media-name").getAttribute("title"),media.name);
 card.addEventListener("click",e=>e.preventDefault());await act(async()=>card.click());assert.equal(host.querySelector('[role="status"]'),null,"opening a link never claims the download succeeded");
});
test("file caption and quote stay outside the attachment card",async t=>{
 const media={mediaId:"file",kind:"file",name:"合同扫描件.pdf",mimeType:"application/pdf",size:4096,url:"/api/im/media/file-1"};
 const host=await mount(t,createElement(SupportMessageBody,{message:{messageType:6,media,text:"请查收合同",reply:{messageId:"m-1",senderId:"user-1",text:"原消息"}}}));
 const card=host.querySelector("a.message-media-file");assert.ok(card);
 assert.equal(card.querySelector('[data-slot="bubble"]'),null);assert.equal(card.querySelector(".message-quoted"),null);
 assert.match(host.textContent,/请查收合同/);assert.ok(host.querySelector(".message-quoted"));
 const caption=host.querySelector(".message-media-caption-text");assert.ok(caption);assert.equal(caption.closest('[data-slot="bubble"]'),null,"the caption is unframed and independent");
});
test("support body forwards the image thumbnail with its full accessible name",async t=>{
 const host=await mount(t,createElement(SupportMessageBody,{message:{messageType:1},image:{url:"https://example.test/full.png",thumbnailUrl:"https://example.test/thumb.png",name:"截图.png"}}));
 const trigger=host.querySelector("button.im-wb-thumb");assert.ok(trigger);assert.equal(trigger.querySelector("img").getAttribute("src"),"https://example.test/thumb.png");
 assert.equal(trigger.querySelector("img").getAttribute("alt"),"截图.png");assert.match(trigger.getAttribute("aria-label"),/截图\.png/);
});
test("display projection enlarges small sources without rewriting source facts",async()=>{
 const display=await vite.ssrLoadModule("/packages/ui/src/media-display.ts");
 assert.deepEqual(display.imageDisplaySize({width:64,height:64}),{width:720,height:720});
 assert.deepEqual(display.imageDisplaySize({width:36,height:64}),{width:720,height:1280});
 assert.deepEqual(display.imageDisplaySize({width:64,height:512}),{width:720,height:5760});
 assert.deepEqual(display.imageDisplaySize({width:1600,height:900}),{width:1600,height:900});
 assert.match(display.IMAGE_DISPLAY_WIDTH_CSS,/clamp\(320px/);
 assert.match(display.VIDEO_DISPLAY_WIDTH_CSS,/clamp\(320px/);
});
test("video thumbnail failure degrades to a labeled entry",async t=>{
 const host=await mount(t,createElement(MediaMessage,{media:{...video,url:"https://example.test/expired.mp4"}}));
 const player=host.querySelector(".message-media-video-player");assert.ok(player);
 await act(async()=>player.dispatchEvent(new Event("error")));
 const failed=host.querySelector(".message-media-video-failed");assert.ok(failed);assert.match(failed.textContent,/视频加载失败/);
 assert.match(host.querySelector("button.message-media-video-open").getAttribute("aria-label"),/加载失败/);
 assert.ok(host.querySelector("button.message-media-video-open"),"the preview entry remains available");
});
test("message video is a thumbnail entry with millisecond duration and no inline controls",async t=>{
 const host=await mount(t,createElement(MediaMessage,{media:video}));const trigger=host.querySelector("button.message-media-video-open");
 assert.ok(trigger);assert.equal(trigger.querySelector("video").controls,false);
 assert.match(host.querySelector(".message-media-size").textContent,/0:02/);assert.doesNotMatch(host.querySelector(".message-media-size").textContent,/33:20/);
});


test("shared order card renders in admin and patrol, keeps caption separate and removes content on revoke",async t=>{
 const {encodeOrderReference}=await import("../../../packages/im-client/src/order-reference.ts");
 const text=encodeOrderReference({id:"order-card-1",title:"卡片订单",displayNo:"ZZ-CARD-1",party:"owner"},"请核对这笔订单");
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 const opened=[];
 await act(async()=>root.render(createElement(SupportMessageBody,{message:{messageType:0,text},onOpenOrder:id=>opened.push(id)})));
 const card=host.querySelector('[aria-label="关联订单卡片"]');assert.ok(card);assert.match(card.textContent,/出租订单/);assert.doesNotMatch(card.textContent,/请核对/);
 assert.equal(host.querySelector('.message-media-caption-text').textContent,"请核对这笔订单");
 await act(async()=>card.querySelector('button').click());assert.deepEqual(opened,["order-card-1"]);
 await act(async()=>root.render(createElement(SupportMessageBody,{message:{messageType:3,text,media:{mediaId:"m",kind:"video",name:"clip.mp4",mimeType:"video/mp4",size:123,url:"https://example.com/clip.mp4"}}})));
 assert.equal(host.querySelector('[aria-label="关联订单卡片"]'),null,"media caption is not a text order reference");assert.ok(host.querySelector('.message-media-video-open'));
 await act(async()=>root.render(createElement(SupportMessageBody,{message:{messageType:0,text,revoked:true}})));
 assert.equal(host.querySelector('[aria-label="关联订单卡片"]'),null);assert.equal(host.textContent,"消息已撤回");
});
