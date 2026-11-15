import type { NextConfig } from "next";

export const securityHeaders=[
  {
    key:"Content-Security-Policy",
    value:[
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'"
    ].join("; ")
  },
  {key:"Cross-Origin-Opener-Policy",value:"same-origin"},
  {key:"Origin-Agent-Cluster",value:"?1"},
  {
    key:"Permissions-Policy",
    value:[
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()"
    ].join(", ")
  },
  {key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},
  {key:"X-Content-Type-Options",value:"nosniff"},
  {key:"X-Frame-Options",value:"DENY"},
  ...(process.env.NODE_ENV==="production"
    ?[{
      key:"Strict-Transport-Security",
      value:"max-age=63072000; includeSubDomains; preload"
    }]
    :[])
] as const;

const nextConfig:NextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  typedRoutes:true,
  async headers(){
    return [{
      source:"/:path*",
      headers:[...securityHeaders]
    }];
  }
};

export default nextConfig;
