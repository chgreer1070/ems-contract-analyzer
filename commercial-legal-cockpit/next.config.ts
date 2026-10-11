import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" }
];

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,
  // Worker modules load from disk outside Next's server bundle.
  outputFileTracingIncludes: {
    "/api/matters/*/pdf-preparations": [
      "./runtime/*.cjs", "./node_modules/pdf-lib/**/*",
      "./node_modules/@pdf-lib/**/*", "./node_modules/pako/**/*", "./node_modules/tslib/**/*"
    ]
  },
  turbopack: { root: __dirname },
  // The production workflow injects the exact approved Git SHA at build time.
  // Next replaces this server reference with that literal, so a runtime env
  // override cannot make a different prebuilt artifact attest to the SHA.
  env: {
    CONTRACTTWIN_RELEASE_SHA: process.env.CONTRACTTWIN_RELEASE_SHA ?? ""
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default withWorkflow(nextConfig);
