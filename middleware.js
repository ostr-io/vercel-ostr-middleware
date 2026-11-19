import { next } from "@vercel/functions";

/**
 * Vercel Routing Middleware — bot traffic → ostr.io prerendering CDN.
 *
 * Drop this file at your project root. Vercel picks it up automatically.
 * Works with any framework (Astro, Next.js, SvelteKit, plain static).
 *
 * Human traffic passes through unchanged. Bot traffic is proxied to
 * ostr.io which returns a fully rendered snapshot. Graceful fallback
 * to origin if ostr.io is unavailable.
 *
 * Env vars (set in Vercel dashboard):
 *   OSTR_SERVICE_URL  — default: https://render.ostr.io
 *   OSTR_AUTH         — Basic <base64 user:password> from ostr.io dashboard
 *   OSTR_SITE_ORIGIN  — canonical origin (e.g. https://example.com)
 *                        required when preview URLs differ from registered domain
 *
 * Bot list sourced from veliovgroup/spiderable-middleware.
 */

const BOT_AGENTS = [
  // Search engines
  "googlebot", "adsbot-google", "apis-google", "mediapartners-google",
  "google-safety", "feedfetcher-google", "google-site-verification",
  "google-inspectiontool", "bingbot", "yandexbot", "baiduspider",
  "applebot", "duckduckbot", "seznambot", "naver", "ecosia",
  // Social
  "facebookexternalhit", "facebookcatalog", "facebookbot",
  "meta-externalagent", "twitterbot", "linkedinbot", "whatsapp",
  "slackbot", "pinterest", "pinterestbot", "tiktok", "bytespider",
  "discordbot", "telegrambot",
  // SEO tools
  "semrushbot", "ahrefsbot", "rogerbot", "dotbot", "chrome-lighthouse",
  // AI bots
  "gptbot", "chatgpt", "oai-searchbot", "claudebot",
  "perplexitybot", "amazonbot", "anthropic-ai", "ccbot",
  // Other
  "embedly", "quora link preview", "showyoubot", "outbrain",
  "vkshare", "w3c_validator", "redditbot", "flipboard",
  "tumblr", "bitlybot", "skypeuripreview", "qwantify",
];

const BOT_RE = new RegExp(BOT_AGENTS.join("|"), "i");

const STATIC_EXT = /\.(js|css|xml|png|jpg|jpeg|gif|pdf|txt|ico|rss|zip|mp3|mp4|webp|avif|svg|woff2?|ttf|eot|map|json|webmanifest)$/i;

const OSTRIO_HOST_RE = /(?:^|\.)ostr\.io$/i;

// Visitor request headers passed on to the renderer, everything else is dropped
const FORWARD_HEADERS = ["user-agent", "accept", "accept-language"];

// Renderer response headers that must not reach the crawler. Same list as
// `ignoredHeaders` in spiderable-middleware: hop-by-hop headers, headers
// that describe the renderer's own connection or cache, and cookies.
// fetch() already decompressed the body, so content-encoding and
// content-length would describe bytes that no longer exist.
const IGNORED_HEADERS = new Set(["age", "alt-svc", "cache-status", "cf-connecting-ip", "cf-ipcountry", "cf-cache-status", "cf-ray", "cf-request-id", "cnection", "cneonction", "connection", "content-encoding", "content-length", "date", "etag", "expect-ct", "expires", "keep-alive", "last-modified", "link", "nel", "nncoection", "pragma", "proxy-authenticate", "proxy-authorization", "proxy-connection", "server", "set-cookie", "status", "te", "trailer", "transfer-encoding", "report-to", "upgrade", "vary", "via", "www-authenticate", "x-accel-buffering", "x-accel-charset", "x-accel-expires", "x-accel-limit-rate", "x-accel-redirect", "x-ostrio-domain", "x-powered-by", "x-preprender-status", "x-prerender-status", "x-real-ip", "x-runtime"]);

function filterResponseHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const key = name.toLowerCase();
    // x-middleware-* headers are Vercel routing instructions, never take them from upstream
    if (IGNORED_HEADERS.has(key) || key.startsWith("x-middleware-")) continue;
    headers.append(name, value);
  }
  return headers;
}

// Edge Functions must start responding within 25 s, so the default leaves
// room for the next() fallback after a timeout
const DEFAULT_TIMEOUT_MS = 20000;

function readTimeout() {
  const ms = Number.parseInt(process.env.OSTR_TIMEOUT || "", 10);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

// One deadline covers both attempts. A network error before any response
// (a stale keep-alive socket, a DNS blip) gets one retry. A timeout does
// not: the time budget is already spent.
async function fetchRenderer(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw err;
      return await fetch(url, { ...init, signal: controller.signal });
    }
  } finally {
    // The renderer answered (or failed), stop the clock so the body can stream
    clearTimeout(timer);
  }
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // Only intercept GET/HEAD for HTML pages
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (STATIC_EXT.test(url.pathname)) return next();
  // ACME challenges and other verification files must reach the app as is
  if (url.pathname.startsWith("/.well-known/")) return next();
  // A request for ostr.io itself would make the renderer call itself
  if (OSTRIO_HOST_RE.test(url.hostname)) return next();

  // BOT_RE is case-insensitive, keep the UA as sent so ostr.io sees the real value
  const ua = request.headers.get("user-agent") || "";
  const isBot = BOT_RE.test(ua);
  const hasEscapedFragment = url.searchParams.has("_escaped_fragment_");

  if (!isBot && !hasEscapedFragment) return next();

  // Proxy bot request to ostr.io
  const serviceURL = process.env.OSTR_SERVICE_URL || "https://render.ostr.io";
  const auth = process.env.OSTR_AUTH || "";

  // Use canonical origin — ostr.io only allows registered domains
  const canonicalOrigin = process.env.OSTR_SITE_ORIGIN || url.origin;
  let targetUrl = canonicalOrigin + url.pathname;
  if (url.search && url.search.length > 1) {
    const cleanParams = new URLSearchParams(url.searchParams);
    cleanParams.delete("_escaped_fragment_");
    const qs = cleanParams.toString();
    if (qs) targetUrl += "?" + qs;
  }

  const renderUrl = `${serviceURL}/?url=${encodeURIComponent(targetUrl)}&bot=${encodeURIComponent(ua)}`;

  try {
    // Send only what the renderer needs. Cookies, x-forwarded-* and
    // x-vercel-* headers belong to the visitor and stay on Vercel.
    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (auth) headers.set("Authorization", auth);

    const response = await fetchRenderer(renderUrl, { method: request.method, headers, redirect: "manual" }, readTimeout());

    if (response.ok || response.status === 301 || response.status === 302) {
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers: filterResponseHeaders(response.headers),
      });
    }

    console.warn(`[ostr-middleware] ostr.io returned ${response.status}, falling back to origin`);
    return next();
  } catch (err) {
    console.warn("[ostr-middleware] ostr.io fetch failed, falling back to origin:", err);
    return next();
  }
}

export const config = {
  // Skip framework internals and static assets
  matcher: ["/((?!_next/static|_astro|favicon\\.ico).*)"],
};
