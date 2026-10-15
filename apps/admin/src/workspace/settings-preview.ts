export function isLocalSettingsPreview(): boolean {
  return import.meta.env.DEV && typeof window !== "undefined"
    && ["localhost", "127.0.0.1"].includes(window.location.hostname)
    && window.location.port === "4381";
}
