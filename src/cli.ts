#!/usr/bin/env bun

import { configFromEnv, loadEnv } from "./config";
import { codexArgs, startProxy } from "./proxy";
import { installSkill } from "./skill-install";

const args = process.argv.slice(2);
let proxy: ReturnType<typeof startProxy> | undefined;

try {
  await loadEnv();
  installSkill({ silent: false });
  let childArgs = args;
  let logPath: string | undefined;
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    const config = configFromEnv();
    proxy = startProxy(config);
    childArgs = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
    logPath = proxy.logPath;
  } else {
    console.error("[Jev] TYPESAFE_API_KEY is not set; starting Codex without routing.");
  }
  const childEnv = { ...process.env };
  delete childEnv.TYPESAFE_API_KEY;
  delete childEnv.TYPESAFE_BASE_URL;
  delete childEnv.TYPESAFE_DEFAULT_MODEL;
  if (logPath) childEnv.JEV_SESSION_LOG = logPath;
  else delete childEnv.JEV_SESSION_LOG;
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
