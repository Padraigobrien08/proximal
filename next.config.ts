import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/Node-only modules stay outside the server bundle.
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist", "@napi-rs/canvas"],
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
