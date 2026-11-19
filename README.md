# vercel-ostr-middleware

Drop-in [Vercel Routing Middleware](https://vercel.com/docs/routing-middleware) that sends crawler requests to the [ostr.io](https://ostr.io) pre-rendering service. It is one file, configured with environment variables.

## What it does

| Request | Behavior |
|---------|----------|
| Human visitor | Passes through to your pages unchanged |
| Crawler (Googlebot, Bingbot, GPTBot and 250+ others) | Gets the page rendered by ostr.io |
| `?_escaped_fragment_=` (any visitor) | Gets the rendered page; a non-empty value is appended to the path |
| Static assets, `/.well-known/*`, non-GET/HEAD | Pass through unchanged |
| ostr.io unreachable, timed out, or reporting its own error | Falls back to your origin page |

The crawler list and the static-asset list match [spiderable-middleware](https://github.com/veliovgroup/spiderable-middleware) and the canonical lists in [ostrio-docs](https://github.com/ostr-io/ostrio-docs/tree/master/docs/prerendering/shared). `.xml` and `.json` are not treated as static, so crawlers get rendered sitemaps and JSON-LD.

## Setup

### 1. Copy `middleware.js` to your project root

```
your-project/
  middleware.js   <-- this file
  src/
  package.json
  ...
```

Vercel picks up `middleware.js` next to `package.json`. You can also point `vercel.json` at the file:

```json
{
  "proxy": { "entrypoint": "middleware.js" }
}
```

If your project uses no framework, add `"type": "module"` to `package.json` or rename the file to `middleware.mjs`.

### 2. Install the dependency

```bash
npm install @vercel/functions
```

### 3. Set environment variables in Vercel

| Variable | Value | Required |
|----------|-------|----------|
| `OSTR_AUTH` | `Basic xxx` from the ostr.io dashboard, or `user:pass` | Yes |
| `OSTR_SITE_ORIGIN` | `https://yourdomain.com`, `ROOT_URL` works as an alias | Only if preview URLs differ from your registered domain |
| `OSTR_SERVICE_URL` | Rendering endpoint | No, defaults to `https://render.ostr.io` |
| `OSTR_TIMEOUT` | Milliseconds to wait for ostr.io | No, defaults to `20000` |

Get your credentials from the [ostr.io dashboard](https://ostr.io) after adding your domain. The dashboard shows `OSTR_AUTH` as a ready `Basic xxx` value. A plain `user:pass` also works, the middleware base64-encodes it. If `OSTR_AUTH` is empty, the middleware logs one warning and ostr.io rejects every render.

### 4. Deploy

```bash
vercel deploy
```

### Verify

```bash
curl -sI -A 'Googlebot/2.1' https://yourdomain.com/
# The response has an x-prerender-id header from ostr.io

curl -sI -A 'Mozilla/5.0' https://yourdomain.com/
# No x-prerender-id header
```

## How it works

Vercel runs Routing Middleware before the CDN cache on every request that matches `config.matcher`. For a crawler request, the middleware calls `render.ostr.io` with the page URL and the crawler's User-Agent, and returns the rendered page.

The request to ostr.io carries only `User-Agent`, `Accept`, `Accept-Language` and your `Authorization` header. Visitor cookies, `x-forwarded-*` and `x-vercel-*` headers stay on Vercel. HEAD requests go to ostr.io as HEAD.

The middleware strips these headers from the ostr.io response: `Set-Cookie`, hop-by-hop headers such as `Connection` and `Transfer-Encoding`, `Content-Encoding` and `Content-Length` (fetch already decompressed the body), `x-middleware-*`, and the rest of the `ignoredHeaders` list from spiderable-middleware.

### Status codes and fallback

ostr.io returns the status your page declares with `<meta name="response:status-code">` (see [genuine status code](https://github.com/ostr-io/ostrio-docs/blob/master/docs/prerendering/genuine-status-code.md)). A 404 or 410 from ostr.io is usually the real answer. Serving your origin page instead would show the crawler a soft 404.

The middleware returns these statuses to the crawler as is:

- 2xx, with the rendered page.
- 3xx, with its `Location` header. fetch uses `redirect: "manual"`, so the crawler follows the redirect itself.
- 4xx and 5xx that a rendered page declared. Every rendered page has an `X-Prerender-Id` or `X-Prerender-Cache` header.

The middleware falls back to your origin (`next()`) only when ostr.io itself could not render the page:

- A network error. The middleware retries once if the error happens before any response arrives.
- No response within `OSTR_TIMEOUT` ms. A timeout is not retried, both attempts share one deadline.
- The response has an `X-Prerender-Reason` header, which ostr.io sets on its own errors.
- The body is ostr.io's own short `text/plain` error, such as `Unauthorized! [1001]`. On 401 or 403 the middleware also logs a hint to check `OSTR_AUTH`.
- A 5xx without `X-Prerender-Id` and `X-Prerender-Cache`. It came from the infrastructure in front of the renderer, not from your page.

The ostr.io [Cloudflare Worker](https://github.com/ostr-io/ostrio-docs/blob/master/docs/prerendering/cloudflare-worker.md#how-it-handles-errors) uses the same rule.

### Runtime and timeout

Routing Middleware runs on the Node.js runtime by default ([Vercel docs](https://vercel.com/docs/routing-middleware#runtime-options)). This file uses only Web APIs (`fetch`, `Headers`, `URL`, `AbortController`, `btoa`) and the `next()` helper from `@vercel/functions`, so it also runs on the Edge runtime.

The 20-second default for `OSTR_TIMEOUT` fits both runtimes. Edge functions must start sending a response within 25 seconds ([Vercel limits](https://vercel.com/docs/functions/limitations#edge-runtime)), which leaves time for the origin fallback. Node.js functions run for up to 300 seconds by default, so you can raise `OSTR_TIMEOUT` there if your pages take long to render.

## Compatibility

This file is for frameworks that don't build their own routing middleware, such as SvelteKit, Nuxt and plain static sites.

Next.js and Astro build their own routing middleware, and Vercel's docs say Routing Middleware `proxy` can't be used with them ([Vercel docs](https://vercel.com/docs/routing-middleware#creating-routing-middleware)).

- Next.js: use the [`seo-middleware-nextjs`](https://www.npmjs.com/package/seo-middleware-nextjs) npm package in `proxy.ts` (Next.js 16 and later) or `middleware.ts` (earlier versions).
- Astro: use Astro's own middleware. The [ostr.io pre-rendering docs](https://github.com/ostr-io/ostrio-docs/tree/master/docs/prerendering) list the available integrations.

## Customizing

- To detect more crawlers, add User-Agent substrings to `BOT_AGENTS`. Entries are regex fragments, so escape `.`, `+`, `(` and similar characters with `\\`.
- To run on fewer paths, narrow `config.matcher`. The default skips `_next/static`, `_astro` and `favicon.ico`.

## Tests

```bash
npm test
```

The tests use `node --test` (Node.js 20.6 or later) and need no `npm install`. They mock `fetch` and stub `@vercel/functions`. `package.json` exists only for the test script, your project needs `middleware.js` alone.

## Links

- [ostr.io docs](https://github.com/ostr-io/ostrio-docs): pre-rendering setup, status codes, cache
- [ostr.io](https://ostr.io): pre-rendering service
- [Vercel Routing Middleware docs](https://vercel.com/docs/routing-middleware)
- [spiderable-middleware](https://github.com/veliovgroup/spiderable-middleware): source of the crawler and static-asset lists
- [seo-middleware-nextjs](https://www.npmjs.com/package/seo-middleware-nextjs): the Next.js integration

---

Built by [Beton](https://getbeton.ai) for [selltostate.com](https://www.selltostate.com).
