import { buildAppRuntime } from "./app.js";
import { readEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = readEnv();
  const runtime = buildAppRuntime(env);
  const { app } = runtime;
  let shuttingDown: Promise<never> | undefined;

  await app.listen({
    host: env.HOST,
    port: env.PORT
  });

  await runtime.startExternalServices();

  const shutdown = (): Promise<never> => {
    if (shuttingDown) {
      return shuttingDown;
    }

    shuttingDown = (async () => {
      try {
        await runtime.stopExternalServices();
        await app.close();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }

      return new Promise<never>(() => undefined);
    })();

    return shuttingDown;
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
