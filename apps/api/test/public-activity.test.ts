import { strict as assert } from "node:assert";
import { test } from "node:test";

import { handleContentPublicRoute } from "../src/content/content-routes";
import { readPublicActivity, type PublicActivityProviders } from "../src/content/public-activity";

const NOW = new Date("2026-10-16T04:00:00.000Z");
const now = () => NOW;

test("public activity: no providers means every metric is UNAVAILABLE, never zero", async () => {
  const result = await readPublicActivity({}, now);
  assert.equal(result.generatedAt, NOW.toISOString());
  for (const metric of [result.metrics.visits, result.metrics.transactions, result.metrics.listings]) {
    assert.equal(metric.state, "UNAVAILABLE");
    if (metric.state !== "UNAVAILABLE") throw new Error("unreachable");
    assert.equal(metric.reason, "NO_AUTHORITATIVE_SOURCE");
    assert.ok(!("value" in metric), "unavailable metric must not carry a value");
  }
  assert.equal(result.deals.state, "UNAVAILABLE");
  if (result.deals.state !== "UNAVAILABLE") throw new Error("unreachable");
  assert.equal(result.deals.reason, "NO_AUTHORITATIVE_SOURCE");
});

test("public activity: null readings stay SOURCE_UNKNOWN and never downgrade to zero", async () => {
  const providers: PublicActivityProviders = {
    completedTransactions: async () => null,
    currentListings: async () => null,
    visitsYesterday: async () => null,
    recentDeals: async () => null,
  };
  const result = await readPublicActivity(providers, now);
  const reasons = [result.metrics.visits, result.metrics.transactions, result.metrics.listings].map((metric) =>
    metric.state === "UNAVAILABLE" ? metric.reason : "UNEXPECTED",
  );
  assert.deepEqual(reasons, ["SOURCE_UNKNOWN", "SOURCE_UNKNOWN", "SOURCE_UNKNOWN"]);
  assert.equal(result.deals.state, "UNAVAILABLE");
  if (result.deals.state !== "UNAVAILABLE") throw new Error("unreachable");
  assert.equal(result.deals.reason, "SOURCE_UNKNOWN");
});

test("public activity: registered providers surface value, cutoff and scope verbatim", async () => {
  const providers: PublicActivityProviders = {
    completedTransactions: async () => ({ value: 128, asOf: "2026-10-15T16:00:00.000Z", scope: "orders.completed.official" }),
    currentListings: async () => ({ value: 41, asOf: "2026-10-16T03:59:00.000Z", scope: "supply.publicListings" }),
  };
  const result = await readPublicActivity(providers, now);
  assert.deepEqual(result.metrics.transactions, {
    state: "AVAILABLE",
    value: 128,
    asOf: "2026-10-15T16:00:00.000Z",
    scope: "orders.completed.official",
  });
  assert.deepEqual(result.metrics.listings, {
    state: "AVAILABLE",
    value: 41,
    asOf: "2026-10-16T03:59:00.000Z",
    scope: "supply.publicListings",
  });
  // Unregistered metrics stay unavailable alongside available ones.
  assert.equal(result.metrics.visits.state, "UNAVAILABLE");
  assert.equal(result.deals.state, "UNAVAILABLE");
});

test("public activity: invalid provider readings are rejected, not coerced", async () => {
  const providers: PublicActivityProviders = {
    completedTransactions: async () => ({ value: -1, asOf: "2026-10-15T16:00:00.000Z", scope: "x" }),
    currentListings: async () => ({ value: 1.5, asOf: "2026-10-16T00:00:00.000Z", scope: "y" }),
  };
  const result = await readPublicActivity(providers, now);
  assert.equal(result.metrics.transactions.state, "UNAVAILABLE");
  assert.equal(result.metrics.listings.state, "UNAVAILABLE");
});

test("public activity: deals are sanitized, capped and incomplete entries dropped", async () => {
  const providers: PublicActivityProviders = {
    recentDeals: async () => ({
      asOf: "2026-10-16T03:00:00.000Z",
      items: [
        { id: "d1", game: "三角洲行动", title: "满配账号", priceLabel: "¥12.00" },
        { id: "", game: "三角洲行动", title: "缺ID", priceLabel: "¥1.00" },
        { id: "d3", game: "三角洲行动", title: "超长".repeat(300), priceLabel: "¥2.00" },
        ...Array.from({ length: 25 }, (_, index) => ({ id: `bulk-${index}`, game: "g", title: `t${index}`, priceLabel: "¥1.00" })),
      ],
    }),
  };
  const result = await readPublicActivity(providers, now);
  assert.equal(result.deals.state, "AVAILABLE");
  if (result.deals.state !== "AVAILABLE") return;
  assert.equal(result.deals.items.length, 20);
  assert.equal(result.deals.items[0]!.id, "d1");
  assert.ok(result.deals.items.every((entry) => entry.id && entry.game && entry.title && entry.priceLabel));
  assert.equal(result.deals.asOf, "2026-10-16T03:00:00.000Z");
});

type MockResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  headersSent: boolean;
  setHeader: (name: string, value: string) => MockResponse;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; return response; },
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; response.headersSent = true; return response; },
  };
  return response;
}

async function callPublic(path: string, providers?: PublicActivityProviders): Promise<MockResponse> {
  const response = mockResponse();
  await handleContentPublicRoute(
    { method: "GET", url: path, headers: {} } as never,
    response as never,
    { publicActivity: providers } as never,
  );
  return response;
}

test("content public route serves /activity with provider-free honest payload", async () => {
  const response = await callPublic("/api/v1/content/activity");
  assert.equal(response.statusCode, 200);
  const body = response.body as { metrics: { transactions: { state: string } }; deals: { state: string } };
  assert.equal(body.metrics.transactions.state, "UNAVAILABLE");
  assert.equal(body.deals.state, "UNAVAILABLE");
});

test("content public route rejects query params on /activity and unknown paths", async () => {
  const withQuery = await callPublic("/api/v1/content/activity?debug=1");
  assert.equal(withQuery.statusCode, 400);
  const unknown = await callPublic("/api/v1/content/stats");
  assert.equal(unknown.statusCode, 404);
});
