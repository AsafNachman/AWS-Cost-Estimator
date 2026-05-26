/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // typedRoutes pre-computes a union of every static route at build time
    // (parsed from the `app/` folder by next-tsc) so `<Link href="...">`
    // is type-checked. Trade-off: an extra .next/types pass on each build.
    typedRoutes: false,
  },
};

module.exports = nextConfig;
