# Cloudflare CDN Edge Caching

**Issue:** [#283](https://github.com/smokeylenz1-commits/stellar-nintendo-crest/issues/283)

This document describes the CDN caching strategy for iPredict's static assets
and public market metadata API endpoints.

---

## Objectives

- Drive global edge cache hit ratio above 85% for static assets.
- Reduce origin server CPU load by more than 60% during traffic spikes.
- Automatically purge the CDN edge cache on every major version deployment.

---

## Cache-Control Header Strategy

### Static Next.js chunks — `/_next/static/**`

```
Cache-Control: public, max-age=31536000, immutable
```

Next.js names every static chunk with a content hash (e.g.
`_next/static/chunks/main-abc123.js`). The filename changes on every build, so
it is safe to cache these files at the edge for one year. The `immutable`
directive tells the browser and CDN never to revalidate — there is no need.

### Market images and public media — `/images/**`, `/markets/**`

```
Cache-Control: public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400
```

Market images change rarely. The 7-day edge cache (`s-maxage=604800`) absorbs
traffic spikes, and `stale-while-revalidate=86400` allows the CDN to serve a
one-day-old image while asynchronously fetching a fresh copy.

### Public market metadata API — `/api/markets` and `/api/markets/**`

```
Cache-Control: public, s-maxage=10, stale-while-revalidate=30
```

The market list is read-heavy and tolerable to be 10–40 seconds stale.
Cloudflare caches the response at the edge for 10 seconds (`s-maxage=10`) and
then revalidates in the background for a further 30 seconds
(`stale-while-revalidate=30`), so origin receives at most ~1 request per 10
seconds for this endpoint regardless of traffic volume.

### Soroban RPC proxy — `/api/rpc`

```
Cache-Control: no-store
```

The RPC proxy handles mutable blockchain state (transaction submissions, polling
for confirmation). It must never be cached.

---

## Implementation

The `Cache-Control` headers are set in two places:

1. **`frontend/next.config.mjs`** — `async headers()` function. This covers
   all Next.js deployments (Vercel, self-hosted Node.js).

2. **`frontend/public/_headers`** — Cloudflare Pages static headers file. This
   configures the CDN directly when deploying to Cloudflare Pages, and serves as
   documentation of the intended rules for Cloudflare Workers / Cache Rules UI.

---

## Cache Purge Webhook

**Endpoint:** `POST /api/cache-purge`  
**Authentication:** `Authorization: Bearer <CACHE_PURGE_SECRET>`

Calling this endpoint triggers a Cloudflare API call to purge cached URLs for
the zone. By default, it purges:

- `/api/markets` (market list)
- `https://ipredict.app/` and `https://www.ipredict.app/` (HTML)

Pass a `urls` array in the request body to purge specific URLs instead.

### Required secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_ZONE_ID` | Cloudflare Zone ID (from zone overview page) |
| `CLOUDFLARE_API_TOKEN` | API token with **Cache Purge** permission on the zone |
| `CACHE_PURGE_SECRET` | Shared secret used to authenticate the webhook caller |

Configure these as environment variables on the deployment platform and as
GitHub Actions secrets.

### CI integration

The `deploy-staging.yml` workflow includes a `purge-cdn-cache` job that fires
automatically after a successful smoke test, calling `POST /api/cache-purge`
with the `CACHE_PURGE_SECRET`. If the secret is not configured the job is
skipped (no failure).

---

## Verifying cache hit ratio

In the Cloudflare dashboard:

1. Zone → **Analytics & Logs** → **Traffic**.
2. Filter by resource type **Static** to see the cache hit ratio for static assets.
3. For the market API endpoint, use **Logs** → filter `uri_path starts with /api/markets`.

Target: **≥ 85% cache hit ratio** for static assets, **≥ 60% reduction** in
origin requests for `/api/markets` during peak hours compared to uncached baseline.

---

## Cloudflare Cache Rules (alternative to `_headers`)

If the project is deployed as a Cloudflare Worker or behind a Cloudflare proxy
(not Cloudflare Pages), configure these rules in the Cloudflare dashboard under
**Rules → Cache Rules**:

| Rule | Match | Action |
|------|-------|--------|
| Static assets | URI path matches `/_next/static/*` | Cache level: Cache Everything; Edge TTL: 1 year; Browser TTL: 1 year |
| Market images | URI path matches `/markets/*` or `/images/*` | Cache level: Cache Everything; Edge TTL: 7 days |
| Market API | URI path matches `/api/markets*` | Cache level: Cache Everything; Edge TTL: 10 s; Serve stale: 30 s |
| RPC proxy | URI path matches `/api/rpc` | Bypass cache |

These rules mirror the `Cache-Control` headers and take precedence over Cloudflare's
default caching behaviour for dynamic content.
