#!/usr/bin/env bun

import { configFromEnv, loadEnv } from "./config";
import { claudeArgs, startClaudeProxy } from "./claude-proxy";

const args = process.argv.slice(2);
let proxy: ReturnType<typeof startClaudeProxy> | undefined;

try {
  await loadEnv();
  const hasKey = !!process.env.TYPESAFE_API_KEY?.trim();
  let childArgs = args;
  let logPath: string | undefined;

  if (hasKey) {
    proxy = startClaudeProxy(configFromEnv());
    const built = claudeArgs(`http://127.0.0.1:${proxy.port}`, args);
    childArgs = built.args;
    logPath = proxy.logPath;
  } else {
    console.error("[Jev] TYPESAFE_API_KEY is not set; starting Claude without routing.");
  }

  // Find the real claude executable
  const which = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
  const claudePath = which.stdout.toString().trim();
  if (!claudePath || which.exitCode !== 0) {
    console.error("claude-jev: Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
    process.exitCode = 1;
  } else {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    // Remove TypeSafe credentials from child environment
    delete childEnv.TYPESAFE_API_KEY;
    delete childEnv.TYPESAFE_BASE_URL;
    delete childEnv.TYPESAFE_DEFAULT_MODEL;
    // Point Claude at local proxy when routing is active
    if (hasKey && proxy) {
      childEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}`;
    }
    if (logPath) childEnv.JEV_SESSION_LOG = logPath;
    else delete childEnv.JEV_SESSION_LOG;

    const child = Bun.spawn([claudePath, ...childArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv,
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    process.exitCode = await child.exited;
  }
} catch (error) {
  console.error("claude-jev: startup failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  proxy?.close();
}
