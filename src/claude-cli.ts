#!/usr/bin/env bun

import { configFromEnv, loadEnv } from "./config";
import { claudeArgs, startClaudeProxy } from "./claude-proxy";
import { generateClaudePlugin, resolveJevLogsPath, addPluginDirArg } from "./claude-skill";
import { buildStatusLine } from "./claude-status";
import { dirname } from "node:path";

const args = process.argv.slice(2);
let proxy: ReturnType<typeof startClaudeProxy> | undefined;
let pluginCleanup: (() => void) | undefined;

try {
  await loadEnv();
  const hasKey = !!process.env.TYPESAFE_API_KEY?.trim();
  let childArgs = args;
  let logPath: string | undefined;

  if (hasKey) {
    const config = configFromEnv();
    proxy = startClaudeProxy(config, {
      onNotice(notice) {
        // Status notices are available for session-local display
      },
    });
    childArgs = claudeArgs(args, process.env);
    logPath = proxy.logPath;

    // Generate session-local plugin for jev-logs skill
    const jevLogsPath = resolveJevLogsPath(dirname(dirname(import.meta.path)));
    if (logPath) {
      const plugin = generateClaudePlugin({
        jevLogsPath,
        sessionLogPath: logPath,
        env: process.env,
      });

      if (!plugin.skipped) {
        childArgs = addPluginDirArg(childArgs, plugin.pluginDir);
        pluginCleanup = plugin.cleanup;
      }
    }
  } else {
    console.error("[Jev] TYPESAFE_API_KEY is not set; starting Claude without routing.");
  }

  const which = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
  const claudePath = which.stdout.toString().trim();
  if (!claudePath || which.exitCode !== 0) {
    console.error("claude-jev: Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
    process.exitCode = 1;
  } else {
    const childEnv = { ...process.env };
    delete childEnv.TYPESAFE_API_KEY;
    delete childEnv.TYPESAFE_BASE_URL;
    delete childEnv.TYPESAFE_DEFAULT_MODEL;
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
  pluginCleanup?.();
  proxy?.close();
}
