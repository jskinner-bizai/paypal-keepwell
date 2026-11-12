/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Use threads for static generation in the restricted Windows build environment.
  experimental: { workerThreads: true, cpus: 2 },
};
export default nextConfig;
