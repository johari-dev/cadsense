declare module "gltf-validator" {
  export function validateBytes(
    bytes: Uint8Array,
    options?: {
      maxIssues?: number;
      ignoredIssues?: string[];
      externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
    },
  ): Promise<unknown>;
}
