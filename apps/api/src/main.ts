import { createApp } from "./app";
async function bootstrap() {
  const port = Number(process.env.PORT ?? 3102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const app = await createApp();
  await app.listen(port, process.env.HOST ?? "127.0.0.1");
}
void bootstrap().catch(() => { console.error("API startup failed; check configuration and port availability."); process.exitCode = 1; });
