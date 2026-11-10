import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// One .env file at the repository root serves the web app, the worker and the database tools.
const repoRoot = path.join(import.meta.dirname, '../..');
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextConfig: NextConfig = {
  output: 'standalone',
  // Trace from the monorepo root so the standalone build includes the workspace packages.
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  serverExternalPackages: ['sharp', 'pg'],
  experimental: {
    serverActions: {
      // CSV imports travel through a Server Action. File uploads use streaming route handlers instead.
      bodySizeLimit: '8mb',
    },
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
