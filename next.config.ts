import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg is a Node-only driver; keep it out of the server bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
