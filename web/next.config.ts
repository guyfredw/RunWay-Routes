import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The routing package is TypeScript source, so Next.js compiles it with the app.
  transpilePackages: ['@runway/routing'],
};

export default nextConfig;
