// Minimal structural declaration for the ali-oss client surface used by the
// OSS media adapter. The package ships no TypeScript entry; keep the members
// here in sync with src/supply/media-oss.ts.
declare module "ali-oss" {
  interface OssClientOptions {
    region: string;
    bucket: string;
    endpoint?: string;
    accessKeyId: string;
    accessKeySecret: string;
    stsToken?: string;
    secure?: boolean;
    cname?: boolean;
    timeout?: number;
    authorizationV4?: boolean;
  }

  class OSS {
    constructor(options: OssClientOptions);
    head(name: string, options?: Record<string, unknown>): Promise<{ status: number; res: unknown }>;
    put(name: string, file: Buffer, options?: Record<string, unknown>): Promise<{ res: unknown; name: string }>;
    get(name: string, options?: Record<string, unknown>): Promise<{ content: Buffer; res: unknown; status: number }>;
    getStream(name: string): Promise<{ stream: import("node:stream").Readable; res: { headers: Record<string, string | undefined> } }>;
    signPostObjectPolicyV4(policy: object, date: Date): string;
    signatureUrlV4(method: "GET", expires: number, request: { queries: Record<string, string> }, name: string): Promise<string>;
    processObjectSave(source: string, target: string, process: string, bucket: string): Promise<{ status: number }>;
    delete(name: string, options?: Record<string, unknown>): Promise<{ res: unknown }>;
  }

  export = OSS;
}
