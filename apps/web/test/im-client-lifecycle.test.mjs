import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ImClientLifecycle,
  ImLifecycleSupersededError,
  markImDisposeFailure,
} from "../src/lib/im-client-lifecycle.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("reuses one client per identity and disposes it on close", async () => {
  const contexts = [];
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    contexts.push(context);
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  const [first, second] = await Promise.all([lifecycle.open(" customer-a "), lifecycle.open("customer-a")]);
  assert.strictEqual(first, second);
  assert.equal(contexts.length, 1);
  assert.deepEqual(lifecycle.getSnapshot().state, "ready");

  const events = [];
  const guarded = contexts[0].onCurrent((event) => events.push(event));
  guarded("connected");
  assert.deepEqual(events, ["connected"]);

  await lifecycle.close();
  guarded("stale");
  assert.deepEqual(events, ["connected"]);
  assert.deepEqual(disposed, ["customer-a"]);
  assert.equal(lifecycle.getSnapshot().state, "idle");
});

test("isolates callbacks and cleanup when switching identities", async () => {
  const contexts = [];
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    contexts.push(context);
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  await lifecycle.open("admin-a");
  const events = [];
  const oldCallback = contexts[0].onCurrent(() => events.push("old"));
  await lifecycle.open("admin-b");
  const newCallback = contexts[1].onCurrent(() => events.push("new"));

  oldCallback();
  newCallback();
  assert.deepEqual(events, ["new"]);
  assert.deepEqual(disposed, ["admin-a"]);

  await lifecycle.close();
  newCallback();
  assert.deepEqual(events, ["new"]);
  assert.deepEqual(disposed, ["admin-a", "admin-b"]);
});

test("disposes a late client when its opening generation is superseded", async () => {
  const gate = deferred();
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    if (context.identity === "late-client") {
      return gate.promise.then(() => ({
        client: { identity: context.identity },
        dispose: () => disposed.push(context.identity),
      }));
    }
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  const opening = lifecycle.open("late-client");
  await new Promise((resolve) => setImmediate(resolve));
  const currentOpening = lifecycle.open("current-client");
  gate.resolve();

  await assert.rejects(opening, (error) => error instanceof ImLifecycleSupersededError);
  const current = await currentOpening;
  assert.deepEqual(disposed, ["late-client"]);
  assert.equal(current.identity, "current-client");
  assert.equal(lifecycle.getSnapshot().identity, "current-client");
  await lifecycle.close();
  assert.deepEqual(disposed, ["late-client", "current-client"]);
});

test("close cancels an in-flight open and waits for its real disposal", async () => {
  const login = deferred();
  const disposed = [];
  let cancelled = false;
  const lifecycle = new ImClientLifecycle((context) => {
    const handle = {
      client: { identity: context.identity },
      dispose: () => { disposed.push("dispose"); },
    };
    context.onCancel?.(() => {
      cancelled = true;
      handle.dispose();
      login.reject(new ImLifecycleSupersededError());
    });
    return login.promise.then(() => handle);
  });
  const opening = lifecycle.open("slow-login");
  await new Promise((resolve) => setImmediate(resolve));
  await lifecycle.close();
  assert.equal(cancelled, true, "close must cancel the pending SDK login");
  assert.deepEqual(disposed, ["dispose"], "close must wait until the pending login has been disposed");
  await assert.rejects(opening, (error) => error instanceof ImLifecycleSupersededError);
});

test("close rejects when disposal fails and never reports an unproven handoff", async () => {
  let rejectPending;
  const lifecycle = new ImClientLifecycle((context) => {
    context.onCancel?.(() => {});
    return new Promise((_, reject) => { rejectPending = reject; });
  });
  const opening = lifecycle.open("cleanup-fails");
  await new Promise((resolve) => setImmediate(resolve));
  const closing = lifecycle.close();
  rejectPending(markImDisposeFailure(new Error("synthetic dispose failure")));
  await assert.rejects(opening, /synthetic dispose failure/);
  await assert.rejects(closing, /synthetic dispose failure/);
});

test("leaves no active client after factory failure and permits a clean retry", async () => {
  let attempts = 0;
  const disposed = [];
  const lifecycle = new ImClientLifecycle((context) => {
    attempts += 1;
    if (attempts === 1) throw new Error("sdk init failed");
    return {
      client: { identity: context.identity },
      dispose: () => disposed.push(context.identity),
    };
  });

  await assert.rejects(lifecycle.open("retry-client"), /sdk init failed/);
  assert.equal(lifecycle.getSnapshot().state, "idle");
  await lifecycle.open("retry-client");
  assert.equal(lifecycle.getSnapshot().state, "ready");
  await lifecycle.close();
  assert.deepEqual(disposed, ["retry-client"]);
});


/* --- NIM Message Receipts Tests --- */

import { createNimReceiptReporter, NimReceiptActionError } from "../../../packages/im-client/src/message-receipts.ts";
import { nimMessageView } from "../../../packages/im-client/src/nim-web-client.ts";

test("server history reuses SDK media validation and strips revoked or unsafe attachments",()=>{
  const raw={messageClientId:"file",messageType:6,attachment:{name:"fixture.txt",size:52,url:"https://nos.example/fixture.txt"}};
  assert.equal(nimMessageView(raw).media.kind,"file");assert.equal(nimMessageView(raw).media.mimeType,"text/plain");
  assert.equal(nimMessageView({...raw,attachment:{...raw.attachment,url:"javascript:alert(1)"}}).media,undefined);
  assert.equal(nimMessageView({...raw,revoked:true}).attachment,undefined);assert.equal(nimMessageView({...raw,revoked:true}).media,undefined);
});

function receiptStorage(){const data=new Map();return {data,get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
const receiptMessage={messageClientId:"client-1",messageServerId:"4301564702653153301",conversationId:"user|2|9001",senderId:"user",createTime:20,messageType:0};
const receiptAction={kind:"receipt",action:"sent",message:receiptMessage};
test("SDK success registration survives an offline reload, stays scoped, and accepts only a recorded acknowledgement",async()=>{
  const disk=receiptStorage(),statuses=[],bodies=[];let online=false;
  const options={endpoint:"/api/im/messages",scope:"app:user",storage:disk,status:s=>statuses.push(s),fetch:async(_,init)=>{bodies.push(JSON.parse(init.body));return Response.json(online?{recorded:true}:{recorded:false},{status:online?200:503});}};
  const first=createNimReceiptReporter(options);first.record(receiptAction);await first.flush();first.close();
  assert.equal(disk.length,1);assert.equal(statuses.at(-1).failed,true);assert.equal(statuses.at(-1).pending,1);
  assert.deepEqual(Object.keys(bodies[0].message).sort(),Object.keys(receiptMessage).sort());assert.doesNotMatch(JSON.stringify(bodies),/text|url|token|cookie/);
  const other=createNimReceiptReporter({...options,scope:"app:other"});await other.flush();assert.equal(bodies.length,1);other.close();
  online=true;const next=createNimReceiptReporter(options);try{await next.flush();assert.equal(disk.length,0);assert.equal(statuses.at(-1).pending,0);assert.deepEqual(bodies[1],receiptAction);}finally{next.close();}
});
test("a lost ACK can be replayed with the identical identity; a late old-client SDK result is stored without sending as the new actor",async()=>{
  const disk=receiptStorage(),sent=[];let calls=0;
  const report=createNimReceiptReporter({endpoint:"/api/im/messages",scope:"app:old",storage:disk,fetch:async(_,init)=>{sent.push(JSON.parse(init.body));if(++calls===1)throw new TypeError("ACK lost");return Response.json({recorded:true});}});
  report.record(receiptAction);await report.flush();await report.flush();report.close();assert.deepEqual(sent,[receiptAction,receiptAction]);assert.equal(disk.length,0);
  report.record({...receiptAction,message:{...receiptMessage,messageClientId:"late"}});await report.flush();assert.equal(sent.length,2);assert.equal(disk.length,1);
});
test("quota failure is visible; malformed saved state is retained; separate writers do not overwrite one another",async()=>{
  const disk=receiptStorage(),states=[];const opts={endpoint:"/api/im/messages",scope:"app:user",storage:disk,fetch:async()=>Response.json({},{status:503})};
  const a=createNimReceiptReporter(opts),b=createNimReceiptReporter(opts);a.record(receiptAction);b.record({...receiptAction,message:{...receiptMessage,messageClientId:"other",messageServerId:"2"}});a.close();b.close();assert.equal(disk.length,2);
  const key=[...disk.data.keys()][0];disk.setItem(key,"malformed");const bad=createNimReceiptReporter({...opts,status:s=>states.push(s)});bad.close();assert.equal(disk.getItem(key),"malformed");assert.equal(states.at(-1).failed,true);
  const full=createNimReceiptReporter({...opts,storage:{...disk,setItem(){throw Error("quota");}},status:s=>states.push(s)});full.record(receiptAction);assert.equal(states.at(-1).persistent,false);full.close();
});
test("revoke UNKNOWN is exposed and never retried by the reporter",async()=>{
  let calls=0;const reporter=createNimReceiptReporter({endpoint:"/api/im/messages",scope:"app:user",storage:receiptStorage(),fetch:async()=>{calls++;return Response.json({outcome:"UNKNOWN"},{status:503});}});
  try{await assert.rejects(reporter.revoke(receiptMessage),e=>e instanceof NimReceiptActionError&&e.unknown);await reporter.flush();assert.equal(calls,1);}finally{reporter.close();}
});
