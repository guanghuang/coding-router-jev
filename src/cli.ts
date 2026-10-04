#!/usr/bin/env bun

import { configFromEnv, loadEnv } from "./config";
import { codexArgs, startProxy } from "./proxy";

const args = process.argv.slice(2);
let proxy: ReturnType<typeof startProxy> | undefined;

try {
  await loadEnv();
  let childArgs = args;
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    proxy = startProxy(configFromEnv());
    childArgs = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  } else {
    console.error("[Jev] TYPESAFE_API_KEY is not set; starting Codex without routing.");
  }
  const childEnv = { ...process.env };
  delete childEnv.TYPESAFE_API_KEY;
  delete childEnv.TYPESAFE_BASE_URL;
  delete childEnv.TYPESAFE_DEFAULT_MODEL;
  const child = Bun.spawn(["codex", ...childArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await child.exited;
} catch (error) {
  console.error("codex-jev: startup failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  proxy?.close();
}
