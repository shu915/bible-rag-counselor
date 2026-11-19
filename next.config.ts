import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 検索エンジンに載せない(試してもらう段階。広く公開するときに外す)。
  // ヘッダーは HTML 以外(画像・API)にも効き、layout.tsx の meta は、HTML を保存して使い回されても残る(二重にしてある)
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
