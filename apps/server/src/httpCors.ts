export const browserApiCorsAllowedMethods = ["GET", "POST", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "x-cad-render-token",
  "x-cad-render-receipt",
] as const;
