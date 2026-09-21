import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres", "ioredis"],
  poweredByHeader: false,
};

export default nextConfig;
