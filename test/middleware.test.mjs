import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const ENV_KEYS = ["OSTR_AUTH", "OSTR_SERVICE_URL", "OSTR_SITE_ORIGIN", "ROOT_URL", "OSTR_TIMEOUT"];

const realFetch = globalThis.fetch;
const realWarn = console.warn;
let calls;
let warnings;
let instance = 0;

// A fresh module copy per call, so module-level state (the auth warning) starts clean
async function load() {
  instance += 1;
  return import(`../middleware.js?instance=${instance}`);
}

function mockFetch(...responders) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: new URL(url), init });
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    return responder(init);
  };
}

function rendered(body = "<html>rendered</html>", init = {}) {
  return () => new Response(body, {
    status: init.status || 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-prerender-id": "abc", ...init.headers },
  });
}

function bot(path = "/", init = {}) {
  return new Request(`https://example.com${path}`, {
    method: init.method || "GET",
    headers: { "user-agent": GOOGLEBOT, ...init.headers },
  });
}

const isNext = (res) => res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  calls = [];
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSTR_AUTH = "Basic dXNlcjpwYXNz";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

test("humans pass through without calling the renderer", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  const res = await middleware(new Request("https://example.com/", { headers: { "user-agent": BROWSER } }));
  assert.ok(isNext(res));
  assert.equal(calls.length, 0);
});

test("non-GET/HEAD requests pass through", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  const res = await middleware(bot("/", { method: "POST" }));
  assert.ok(isNext(res));
  assert.equal(calls.length, 0);
});

test("bots get the rendered page", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  const res = await middleware(bot("/pricing?plan=pro"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<html>rendered</html>");
  assert.equal(calls[0].url.origin, "https://render.ostr.io");
  assert.equal(calls[0].url.searchParams.get("url"), "https://example.com/pricing?plan=pro");
});

test("OSTR_SITE_ORIGIN replaces the request origin", async () => {
  process.env.OSTR_SITE_ORIGIN = "https://www.example.org";
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/a"));
  assert.equal(calls[0].url.searchParams.get("url"), "https://www.example.org/a");
});

test("ROOT_URL works when OSTR_SITE_ORIGIN is not set", async () => {
  process.env.ROOT_URL = "https://root.example.org";
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/a"));
  assert.equal(calls[0].url.searchParams.get("url"), "https://root.example.org/a");
});

test("1: only user-agent, accept, accept-language and authorization reach the renderer", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/", {
    headers: {
      accept: "text/html",
      "accept-language": "en",
      cookie: "session=secret",
      authorization: "Bearer visitor-token",
      "x-forwarded-for": "203.0.113.7",
      "x-vercel-ip-country": "SE",
      "x-real-ip": "203.0.113.7",
    },
  }));
  const sent = calls[0].init.headers;
  assert.deepEqual([...sent.keys()].sort(), ["accept", "accept-language", "authorization", "user-agent"]);
  assert.equal(sent.get("authorization"), "Basic dXNlcjpwYXNz");
  assert.equal(sent.get("user-agent"), GOOGLEBOT);
});

test("2: renderer response headers are filtered", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered("<html></html>", {
    headers: {
      "set-cookie": "ostr=1",
      "content-encoding": "gzip",
      "content-length": "13",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-ostrio-domain": "example.com",
      "x-prerender-status": "200",
      "x-middleware-rewrite": "https://evil.example/",
      "cache-control": "public, max-age=60",
    },
  }));
  const res = await middleware(bot("/"));
  for (const name of ["set-cookie", "content-encoding", "content-length", "connection", "transfer-encoding", "x-ostrio-domain", "x-prerender-status", "x-middleware-rewrite"]) {
    assert.equal(res.headers.get(name), null, name);
  }
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-prerender-id"), "abc");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
});

test("3: a renderer that does not answer in OSTR_TIMEOUT ms falls back to next()", async () => {
  process.env.OSTR_TIMEOUT = "30";
  const { default: middleware } = await load();
  mockFetch((init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }));
  const res = await middleware(bot("/"));
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(calls[0].init.signal.aborted);
  assert.ok(isNext(res));
  assert.equal(calls.length, 1, "a timeout is not retried");
});

test("3: one network error before a response is retried", async () => {
  const { default: middleware } = await load();
  mockFetch(() => { throw new TypeError("fetch failed"); }, rendered());
  const res = await middleware(bot("/"));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("3: a second network error falls back to next()", async () => {
  const { default: middleware } = await load();
  mockFetch(() => { throw new TypeError("fetch failed"); });
  const res = await middleware(bot("/"));
  assert.ok(isNext(res));
  assert.equal(calls.length, 2);
});

test("4: HEAD goes upstream as HEAD and returns no body", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  const res = await middleware(bot("/", { method: "HEAD" }));
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test("5: the UA matches case-insensitively and is sent in its original case", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/", { headers: { "user-agent": "Mozilla/5.0 GPTBot/1.2" } }));
  assert.equal(calls[0].url.searchParams.get("bot"), "Mozilla/5.0 GPTBot/1.2");
});

test("6: requests for ostr.io hosts pass through", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  for (const host of ["ostr.io", "render.ostr.io", "OSTR.IO"]) {
    const res = await middleware(new Request(`https://${host}/`, { headers: { "user-agent": GOOGLEBOT } }));
    assert.ok(isNext(res), host);
  }
  assert.equal(calls.length, 0);
});

test("6: /.well-known/ is skipped only as a path prefix", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  assert.ok(isNext(await middleware(bot("/.well-known/acme-challenge/token"))));
  assert.equal(calls.length, 0);
  const res = await middleware(bot("/docs/.well-known/"));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("7: a non-empty _escaped_fragment_ is appended to the path", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/page/?_escaped_fragment_=/about&lang=en"));
  assert.equal(calls[0].url.searchParams.get("url"), "https://example.com/page/about?lang=en");
});

test("7: an empty _escaped_fragment_ renders the page itself, for any UA", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(new Request("https://example.com/page?_escaped_fragment_=", { headers: { "user-agent": BROWSER } }));
  assert.equal(calls[0].url.searchParams.get("url"), "https://example.com/page");
});

test("8: rendered 404 and 410 reach the crawler", async () => {
  const { default: middleware } = await load();
  for (const status of [404, 410]) {
    mockFetch(rendered("<html>gone</html>", { status }));
    const res = await middleware(bot("/missing"));
    assert.equal(res.status, status);
    assert.equal(await res.text(), "<html>gone</html>");
  }
});

test("8: redirects are passed through with Location, fetch does not follow them", async () => {
  const { default: middleware } = await load();
  for (const status of [301, 302, 307, 308]) {
    calls = [];
    mockFetch(() => new Response(null, { status, headers: { location: "https://example.com/new", "x-prerender-id": "abc" } }));
    const res = await middleware(bot("/old"));
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(res.status, status);
    assert.equal(res.headers.get("location"), "https://example.com/new");
  }
});

test("8: a 5xx the page declared is passed through", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered("<html>down</html>", { status: 503 }));
  const res = await middleware(bot("/"));
  assert.equal(res.status, 503);
});

test("8: a 5xx without ostr.io headers falls back to next()", async () => {
  const { default: middleware } = await load();
  mockFetch(() => new Response("Bad gateway", { status: 502, headers: { "content-type": "text/html" } }));
  assert.ok(isNext(await middleware(bot("/"))));
});

test("8: X-Prerender-Reason falls back to next()", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered("", { status: 404, headers: { "x-prerender-reason": "origin-unreachable" } }));
  assert.ok(isNext(await middleware(bot("/"))));
});

test("8: the renderer's own text/plain error falls back to next() and warns about auth", async () => {
  const { default: middleware } = await load();
  mockFetch(() => new Response("Unauthorized! [1001]", { status: 401, headers: { "content-type": "text/plain" } }));
  assert.ok(isNext(await middleware(bot("/"))));
  assert.ok(warnings.some((w) => w.includes("check OSTR_AUTH")));
});

test("9: canonical crawlers are detected, kept extras too", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  const uas = [
    "Mozilla/5.0 (compatible; bingbot/2.0)",
    "facebookexternalhit/1.1",
    "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
    "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
    "APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)",
    "facebookcatalog/1.0",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl)",
  ];
  for (const ua of uas) {
    await middleware(bot("/", { headers: { "user-agent": ua } }));
  }
  assert.equal(calls.length, uas.length);
});

test("9: static assets are skipped, xml and json stay prerenderable", async () => {
  const { default: middleware } = await load();
  mockFetch(rendered());
  for (const path of ["/app.js", "/font.woff", "/doc.DOCX", "/clip.webm", "/data.csv"]) {
    assert.ok(isNext(await middleware(bot(path))), path);
  }
  assert.equal(calls.length, 0);
  await middleware(bot("/sitemap.xml"));
  await middleware(bot("/schema.json"));
  assert.equal(calls.length, 2);
});

test("10: a ready Basic value is sent as is", async () => {
  process.env.OSTR_AUTH = "Basic abc123==";
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/"));
  assert.equal(calls[0].init.headers.get("authorization"), "Basic abc123==");
});

test("10: user:pass is base64-encoded", async () => {
  process.env.OSTR_AUTH = "user:pass";
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/"));
  assert.equal(calls[0].init.headers.get("authorization"), "Basic dXNlcjpwYXNz");
});

test("10: an empty OSTR_AUTH logs one warning", async () => {
  delete process.env.OSTR_AUTH;
  const { default: middleware } = await load();
  mockFetch(rendered());
  await middleware(bot("/"));
  await middleware(bot("/"));
  assert.equal(calls[0].init.headers.get("authorization"), null);
  assert.equal(warnings.filter((w) => w.includes("OSTR_AUTH is empty")).length, 1);
});

test("public contract: default export and config.matcher are unchanged", async () => {
  const mod = await load();
  assert.equal(typeof mod.default, "function");
  assert.deepEqual(mod.config, { matcher: ["/((?!_next/static|_astro|favicon\\.ico).*)"] });
});
