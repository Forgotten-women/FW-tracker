import type { NextConfig } from 'next';

// The backend origin. Only ever read on the Next server, never shipped to the
// browser, because every API call is proxied through the rewrite below.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:5000';

const nextConfig: NextConfig = {
  // Proxying keeps the browser same-origin with the dashboard, so there is no
  // cross-origin request to allow. The backend's CORS stays locked down rather
  // than being opened up for the dashboard's origin.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
    ];
  },
};

export default nextConfig;
