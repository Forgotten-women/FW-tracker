import type { NextConfig } from 'next';

// Clean and normalize the backend API origin URL
let rawOrigin = process.env.API_ORIGIN?.trim() || 'http://127.0.0.1:5000';

// Strip any trailing slashes or trailing /api
rawOrigin = rawOrigin.replace(/\/+$/, '').replace(/\/api$/, '');

// Ensure https protocol when connecting to cloud domains
if (rawOrigin.includes('.vercel.app') || rawOrigin.includes('.onrender.com') || rawOrigin.includes('.trycloudflare.com')) {
  if (rawOrigin.startsWith('http://')) {
    rawOrigin = rawOrigin.replace('http://', 'https://');
  } else if (!rawOrigin.startsWith('http://') && !rawOrigin.startsWith('https://')) {
    rawOrigin = `https://${rawOrigin}`;
  }
}

const API_ORIGIN = rawOrigin;

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
    ];
  },
};

export default nextConfig;
