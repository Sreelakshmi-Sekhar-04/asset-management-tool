/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }, // camera: QR scanning on this site only
  ...(process.env.FORCE_HTTPS === 'true'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['pdfkit', 'sharp', 'exceljs', 'ldapts', 'nodemailer', 'bcryptjs'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  // Verification is shown as Campaigns; old links (bookmarks, emails, stored notifications) still work.
  async redirects() {
    return [
      { source: '/verification', destination: '/campaigns', permanent: false },
      { source: '/verification/campaigns/:id', destination: '/campaigns/:id', permanent: false },
      { source: '/verification/:path*', destination: '/campaigns/:path*', permanent: false },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default nextConfig;
