import assert from "node:assert/strict";
import test from "node:test";
import { createIp2RegionSearcher, formatIp2Region, isPrivateIp, maskSessionIp, normalizeSessionIp, parseSessionUserAgent, sessionRegion } from "../src/auth/admin-session-device";

function ipInt(ip: string): number { return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0) >>> 0; }

/** 构造最小 xdb v2：header + 向量索引 + 两个段 + 数据区。 */
function buildXdb(segments: Array<[string, string, string]>): Buffer {
  const vectorStart = 256, vectorSize = 256 * 256 * 8;
  const dataStart = vectorStart + vectorSize;
  const data = segments.map(([, , region]) => Buffer.from(region, "utf8"));
  const dataLen = data.reduce((n, b) => n + b.length, 0);
  const segStart = dataStart + dataLen;
  const buffer = Buffer.alloc(segStart + segments.length * 14);
  let ptr = dataStart;
  const dataPtrs = data.map((b) => { b.copy(buffer, ptr); const p = ptr; ptr += b.length; return p; });
  segments.forEach(([start, end], i) => {
    const p = segStart + i * 14;
    buffer.writeUInt32LE(ipInt(start), p); buffer.writeUInt32LE(ipInt(end), p + 4);
    buffer.writeUInt16LE(data[i]!.length, p + 8); buffer.writeUInt32LE(dataPtrs[i]!, p + 10);
    const s = ipInt(start), e = ipInt(end);
    for (let v = s >>> 16; v <= e >>> 16; v++) {
      const idx = vectorStart + ((v >>> 8) * 256 + (v & 0xff)) * 8;
      if (buffer.readUInt32LE(idx) === 0) buffer.writeUInt32LE(p, idx);
      buffer.writeUInt32LE(p, idx + 4);
    }
  });
  return buffer;
}

test("UA parser flags node/curl/empty as script clients and labels browsers in Chinese-friendly form", () => {
  for (const ua of ["node", "undici", "curl/8.4.0", "", null, "python-requests/2.31"]) assert.equal(parseSessionUserAgent(ua).isScript, true, String(ua));
  assert.match(parseSessionUserAgent("node").label, /^脚本\/非浏览器客户端/);
  const chrome = parseSessionUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
  assert.deepEqual([chrome.browser, chrome.os, chrome.deviceType, chrome.isScript], ["Chrome 141", "Windows 10/11", "desktop", false]);
  const edge = parseSessionUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0");
  assert.equal(edge.label, "Edge 141 · macOS");
  assert.equal(parseSessionUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1").deviceType, "mobile");
});

test("IP normalisation, masking and private detection", () => {
  assert.equal(normalizeSessionIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeSessionIp("not-an-ip"), null);
  assert.equal(maskSessionIp("203.0.113.9"), "203.0.*.*");
  assert.equal(maskSessionIp("2001:db8:1:2::5"), "2001:db8:****");
  assert(isPrivateIp("127.0.0.1") && isPrivateIp("192.168.1.2") && isPrivateIp("::1") && !isPrivateIp("8.8.8.8"));
  assert.equal(sessionRegion("127.0.0.1", undefined), "本机/内网");
  assert.equal(sessionRegion("8.8.8.8", undefined), null);
});

test("ip2region xdb v2 reader resolves segments and formats region text; bad files degrade to null", () => {
  const searcher = createIp2RegionSearcher(buildXdb([["1.0.0.0", "1.0.0.255", "中国|0|广东省|深圳市|电信"], ["1.0.1.0", "1.0.3.255", "美国|0|0|0|0"]]))!;
  assert.equal(searcher("1.0.0.7"), "中国|0|广东省|深圳市|电信");
  assert.equal(searcher("1.0.2.1"), "美国|0|0|0|0");
  assert.equal(searcher("9.9.9.9"), null);
  assert.equal(sessionRegion("1.0.0.7", searcher), "广东省 深圳市 · 电信");
  assert.equal(sessionRegion("1.0.2.1", searcher), "美国");
  assert.equal(formatIp2Region("0|0|0|0|0"), null);
  assert.equal(createIp2RegionSearcher(Buffer.alloc(10)), undefined);
});
