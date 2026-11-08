export type NativeRealNameProvider = "aliyun-id2meta" | "aliyun-market-id2";

export function isNativeRealNameProvider(provider: unknown): provider is NativeRealNameProvider {
  return provider === "aliyun-id2meta" || provider === "aliyun-market-id2";
}
