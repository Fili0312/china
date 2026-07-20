/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Servita dietro nginx su filippo.eventoyou.com/china
  basePath: process.env.NEXT_BASE_PATH ?? "/china",
};

export default nextConfig;
