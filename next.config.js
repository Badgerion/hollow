/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent bundling of Node.js-only modules for the client (Next.js 14 API)
    serverComponentsExternalPackages: [
      'happy-dom',
      'yoga-layout-prebuilt',
      'got-scraping',       // ESM-only; its browserslist/header-generator deps
      'header-generator',  // trigger "cannot statically extract" warnings when
      'browserslist',      // webpack bundles them — exclude the whole chain
    ],
  },

  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
