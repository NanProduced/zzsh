import { ConfigurationError, readSecret } from "../config/config";
import { createAliyunRealNameProvider, createAliyunUserSmsSender, type AliyunUserCredentials } from "./aliyun-user-providers";
import { createAliyunMarketRealNameProvider } from "./aliyun-market-real-name";

/** Per-channel explicit configuration; media credentials and fake providers are never fallbacks. */
export function loadUserProviderRuntime(env: NodeJS.ProcessEnv = process.env, workingDirectory = process.cwd()) {
  const sms = env.USER_SMS_PROVIDER?.trim() || "disabled";
  const identity = env.USER_REAL_NAME_PROVIDER?.trim() || "disabled";
  if (sms !== "disabled" && sms !== "aliyun") throw new ConfigurationError("USER_SMS_PROVIDER must be disabled or aliyun");
  if (identity !== "disabled" && identity !== "aliyun-id2meta" && identity !== "aliyun-market-id2") throw new ConfigurationError("USER_REAL_NAME_PROVIDER must be disabled, aliyun-id2meta or aliyun-market-id2");
  if (sms === "aliyun" && env.AUTH_LOCAL_SMS_MOCK === "true") throw new ConfigurationError("Real SMS and fixed local SMS are exclusive");
  const credentials = (prefix: "USER_SMS" | "USER_REAL_NAME"): AliyunUserCredentials => ({
    accessKeyId: readSecret(env, `${prefix}_ACCESS_KEY_ID`, `${prefix}_ACCESS_KEY_ID_FILE`, workingDirectory),
    accessKeySecret: readSecret(env, `${prefix}_ACCESS_KEY_SECRET`, `${prefix}_ACCESS_KEY_SECRET_FILE`, workingDirectory),
    ...(env[`${prefix}_SECURITY_TOKEN`] || env[`${prefix}_SECURITY_TOKEN_FILE`]
      ? { securityToken: readSecret(env, `${prefix}_SECURITY_TOKEN`, `${prefix}_SECURITY_TOKEN_FILE`, workingDirectory) } : {}),
  });
  return {
    ...(sms === "aliyun" ? { userSmsSender: createAliyunUserSmsSender({ credentials: credentials("USER_SMS"),
      signName: env.USER_SMS_SIGN_NAME?.trim() ?? "", templateCode: env.USER_SMS_TEMPLATE_CODE?.trim() ?? "" }) } : {}),
    ...(identity === "aliyun-id2meta" ? { realNameProvider: createAliyunRealNameProvider(credentials("USER_REAL_NAME")) } : {}),
    ...(identity === "aliyun-market-id2" ? { realNameProvider: createAliyunMarketRealNameProvider(
      readSecret(env, "USER_REAL_NAME_APPCODE", "USER_REAL_NAME_APPCODE_FILE", workingDirectory)) } : {}),
  };
}
