import { createRequire } from "module";
const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  /**
   * Issue #283 — Cloudflare CDN edge caching: Cache-Control headers
   *
   * Next.js static chunks under /_next/static/ are content-addressed
   * (the hash is part of the filename), so they are safe to cache
   * at the CDN edge for one year with `immutable`.
   *
   * Public market images under /markets/ and /images/ are also
   * long-lived assets, cached for 7 days.
   *
   * Public API endpoints (market list metadata) set `s-maxage=10,
   * stale-while-revalidate=30` so Cloudflare serves the cached
   * response for up to 10 seconds and revalidates in the background
   * for a further 30 seconds, keeping origin load low during spikes.
   *
   * Cloudflare respects `Cache-Control: s-maxage` for its edge cache
   * and treats `stale-while-revalidate` as a background revalidation
   * directive. These headers are the canonical way to configure edge
   * cache behaviour from the origin without needing a Cloudflare
   * Workers script.
   */
  async headers() {
    return [
      // ── Static Next.js chunks (JS/CSS/fonts) ───────────────────────────
      // Content-addressed filenames — safe to cache forever.
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      // ── Public market images and static media ──────────────────────────
      {
        source: "/markets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source: "/images/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
          },
        ],
      },
      // ── Public cached market metadata API ─────────────────────────────
      // s-maxage=10: Cloudflare edge caches for 10 s.
      // stale-while-revalidate=30: serve stale + revalidate in background
      // for 30 s more, keeping origin CPU low during traffic spikes.
      {
        source: "/api/markets",
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=10, stale-while-revalidate=30",
          },
        ],
      },
      {
        source: "/api/markets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=10, stale-while-revalidate=30",
          },
        ],
      },
      // ── Never cache the Soroban RPC proxy or auth endpoints ───────────
      {
        source: "/api/rpc",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store",
          },
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Buffer polyfill for Stellar SDK compatibility
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve("buffer/"),
      };
      const webpack = require("webpack");
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
        })
      );
    }
    return config;
  },
};

export default nextConfig;

