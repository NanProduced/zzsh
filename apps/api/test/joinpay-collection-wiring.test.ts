// Offline composition only: opaque metadata is not formal admission, and no mounted handler is executed.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import * as payments from "../src/order/channel-payment-routes";
import type { ChannelPaymentReadOptions } from "../src/order/channel-payment-read";
import type { FormalCollectionAdmission } from "../src/order/joinpay-collection-profile";
import type { FormalCollectionSourceOptions } from "../src/order/joinpay-collection-source";
import { mountAuthHandlers, type AuthRuntimeOptions } from "../src/auth/auth-runtime";
import * as credit from "../src/credit/credit-guarantee-runtime";
import * as userSecurity from "../src/auth/user-security";
import * as adminSecurity from "../src/auth/admin-self-security-plugin";
import * as adminBff from "../src/bff/admin-bff";

const admission = () => Object.freeze({}) as FormalCollectionAdmission;
const unexpected = (): never => { throw Error("Unexpected IO or provider access"); };
const source = (value: FormalCollectionAdmission): FormalCollectionSourceOptions => ({ admission: value, profileFor: unexpected, keyFor: unexpected });
function assembly(value: FormalCollectionAdmission, executionValue = value): payments.ChannelPaymentCollectionAssembly {
  return { initial: { admission: value, profile: {} as never, wire: { tradeMerchantNo: "wiring_fixture", productName: "fixture", notifyUrl: "https://merchant.example.invalid/notify" } },
    execution: { formal: source(executionValue), profileFor: unexpected, keyFor: unexpected, fetch: async () => unexpected() },
    read: { formalAdmission: value, qrHostAllowlist: ["qr.example.invalid"] } };
}

test("collection read wiring defaults closed; read-only metadata survives without provider callbacks", () => {
  assert.deepEqual(payments.channelPaymentReadOptions(), { formalAdmission: undefined, formalWriteRouteReady: false });
  const value = admission(), read = { formalAdmission: value, qrHostAllowlist: ["qr.example.invalid"] };
  const result = payments.channelPaymentReadOptions({ read }, true);
  assert.equal(result.formalAdmission, value); assert.equal(result.qrHostAllowlist, read.qrHostAllowlist);
  assert.equal(result.formalWriteRouteReady, false);
  assert.equal(Object.hasOwn(result, "keyFor"), false); assert.equal(Object.hasOwn(result, "profileFor"), false);
  const complete = assembly(value);
  assert.equal(payments.channelPaymentReadOptions(complete).formalWriteRouteReady, false);
  assert.equal(payments.channelPaymentReadOptions(complete, true).formalWriteRouteReady, true);
  assert.equal(payments.channelPaymentReadOptions(assembly(value, admission()), true).formalWriteRouteReady, false);
  assert.equal(payments.channelPaymentReadOptions({ ...complete, initial: { ...complete.initial, wire: undefined } }, true).formalWriteRouteReady, false);
  assert.equal(payments.channelPaymentReadOptions({ ...complete, initial: { ...complete.initial, profile: undefined } }, true).formalWriteRouteReady, false);
});

type ModuleLoader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const loader = require("node:module") as ModuleLoader;
function mockAuthImports(t: TestContext): string[] {
  const loaded: string[] = [], original = loader._load;
  const plugin = () => ({ id: "wiring-fixture", endpoints: {} });
  const modules: Record<string, object> = {
    "better-auth": { betterAuth: () => ({ api: {}, handler: async () => new Response(null, { status: 404 }) }) },
    "@better-auth/drizzle-adapter": { drizzleAdapter: () => ({}) },
    "better-auth/node": { toNodeHandler: () => unexpected },
    "better-auth/plugins": { bearer: plugin, phoneNumber: plugin, twoFactor: plugin, username: plugin },
    "better-auth/api": { APIError: Error, createAuthEndpoint: (...args: unknown[]) => args.at(-1), createAuthMiddleware: (handler: unknown) => handler },
    "better-auth/cookies": { setSessionCookie: unexpected },
    "better-auth/crypto": { hashPassword: unexpected, verifyPassword: unexpected },
  };
  t.mock.method(loader, "_load", function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (Object.hasOwn(modules, request)) { loaded.push(request); return modules[request]; }
    return original.call(this, request, parent, isMain);
  });
  return loaded;
}

test("auth rejects CONTROLLED plus formal assembly before DB, preflight or dynamic auth imports", async t => {
  let databaseAccess = 0, preflights = 0, imports = 0;
  t.mock.method(credit, "preflightCreditGuarantee", async () => { preflights++; throw Error("Unexpected preflight"); });
  const original = loader._load;
  t.mock.method(loader, "_load", function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request.startsWith("better-auth") || request.startsWith("@better-auth")) { imports++; throw Error("Unexpected dynamic import"); }
    return original.call(this, request, parent, isMain);
  });
  const options = Object.defineProperty({ localControlledPayments: {}, joinpayCollection: {} }, "pool", {
    get() { databaseAccess++; throw Error("Unexpected database access"); },
  }) as AuthRuntimeOptions;
  await assert.rejects(mountAuthHandlers({} as INestApplication, options), { name: "ConfigurationError", message: "Controlled and formal collection assemblies are exclusive" });
  assert.equal(databaseAccess, 0); assert.equal(preflights, 0); assert.equal(imports, 0);
});

test("actual auth mount opens write readiness only for matching initial, executor and notification admissions", async t => {
  const imported = mockAuthImports(t), stop = Error("PAYMENT_MOUNT_CAPTURED");
  t.mock.method(credit, "preflightCreditGuarantee", async () => {});
  t.mock.method(userSecurity, "buildUserSecurityPlugin", async () => ({ id: "wiring-user" }) as never);
  t.mock.method(adminSecurity, "buildAdminSelfSecurityPlugin", async () => ({ id: "wiring-admin" }) as never);
  const mounts: { collection?: payments.ChannelPaymentCollectionAssembly; read?: ChannelPaymentReadOptions }[] = [];
  const bffReads: ChannelPaymentReadOptions[] = [];
  t.mock.method(adminBff, "mountAdminBffHandlers", (_app: Parameters<typeof adminBff.mountAdminBffHandlers>[0], options: Parameters<typeof adminBff.mountAdminBffHandlers>[1]) => {
    bffReads.push(options.order!.channelPaymentReadOptions!);
  });
  t.mock.method(payments, "mountChannelPayments", (_app: INestApplication, _security: Parameters<typeof payments.mountChannelPayments>[1], collection?: payments.ChannelPaymentCollectionAssembly, read?: ChannelPaymentReadOptions) => {
    mounts.push({ collection, read }); throw stop;
  });
  const pool = { query: unexpected, connect: unexpected } as unknown as Pool;
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use() {} }) }) } as unknown as INestApplication;
  const base: AuthRuntimeOptions = { pool, apiOrigin: "https://api.example.invalid", userOrigin: "https://user.example.invalid", adminOrigin: "https://admin.example.invalid",
    userSecret: "SYNTHETIC_USER_WIRING_ONLY_".repeat(2), adminSecret: "SYNTHETIC_ADMIN_WIRING_ONLY_".repeat(2), secureCookies: false, testOperationsEnabled: false, orderHoldSeconds: 300,
    mediaStorage: { available: false, kind: "unavailable", read: async () => unexpected(), write: async () => unexpected() } };
  for (const scenario of ["default", "missing", "different", "matching"] as const) {
    const value = admission(), routes = scenario === "default" ? undefined : assembly(value);
    const notifications = scenario === "default" || scenario === "missing" ? undefined : source(scenario === "matching" ? value : admission());
    await assert.rejects(mountAuthHandlers(app, { ...base, joinpayCollection: scenario === "default" ? undefined : { routes, notifications } }), error => error === stop);
    const current = mounts.at(-1)!;
    assert.equal(current.collection, routes); assert.equal(current.read!.formalAdmission, scenario === "default" ? undefined : value);
    assert.equal(current.read!.formalWriteRouteReady, scenario === "matching");
    assert.equal(bffReads.at(-1), current.read);
  }
  assert.equal(mounts.length, 4); assert(imported.includes("better-auth"));
});
