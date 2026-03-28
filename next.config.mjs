import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
export default function nextConfig(phase) {
  return {
    // Keep dev output separate so a production build cannot clobber a live dev server.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    experimental: {
      serverComponentsExternalPackages: ['better-sqlite3'],
    },
    webpack: (config) => {
      config.externals.push({
        'better-sqlite3': 'commonjs better-sqlite3',
        '@aws-sdk/client-s3': 'commonjs @aws-sdk/client-s3',
      });
      return config;
    },
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            {
              key: 'X-Content-Type-Options',
              value: 'nosniff',
            },
            {
              key: 'X-Frame-Options',
              value: 'DENY',
            },
            {
              key: 'X-XSS-Protection',
              value: '1; mode=block',
            },
            {
              key: 'Referrer-Policy',
              value: 'strict-origin-when-cross-origin',
            },
          ],
        },
      ];
    },
  };
}
