/** @type {import('next').NextConfig} */
export default {
  webpack: config => {

    /**
     * This is necessary when using ESM module with nodenext tsconfig. See the issue and PR:
     * https://github.com/vercel/next.js/issues/41961
     * https://github.com/vercel/next.js/pull/44177
     */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };

    return config;
  },
};
