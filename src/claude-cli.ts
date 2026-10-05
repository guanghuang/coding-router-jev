#!/usr/bin/env bun

import { dirname } from "node:path";
import { configFromEnv, loadEnv } from "./config";
import { claudeArgs, startClaudeProxy, CLAUDE_SENTINEL } from "./claude-proxy";
import { generateClaudePlugin, resolveJevLogsPath, addPluginDirArg } from "./claude-skill";
import { createClaudeStatusDisplay } from "./claude-status";
import { lookupCapabilities } from "./claude-capabilities";

const args = process.argv.slice(2);
let proxy: ReturnType<typeof startClaudeProxy> | undefined;
let pluginCleanup: (() => void) | undefined;
let statusDisplay: ReturnType<typeof createClaudeStatusDisplay>;

try {
  await loadEnv();
  const hasKey = !!process.env.TYPESAFE_API_KEY?.trim();
  let childArgs = args;
  let logPath: string | undefined;

  if (hasKey) {
    const config = configFromEnv();
    const tier = config.longModelEnabled || config.startTier !== "long" ? config.startTier : "fast";
    const initialModel = config.claudeModels[tier];
    if (config.showStatus) statusDisplay = createClaudeStatusDisplay(initialModel, lookupCapabilities(initialModel)?.defaultEffort, args, process.env, config.statusFormat);
    proxy = startClaudeProxy(config, {
      onDecision: values => statusDisplay?.update(values.model, values.effort),
    });
    childArgs = claudeArgs(args, process.env);
    if (statusDisplay) childArgs.push("--settings", statusDisplay.settingsPath);
    logPath = proxy.logPath;

    // Generate session-local plugin for jev-logs skill
    if (logPath) {
      try {
        const projectRoot = import.meta.dir ? dirname(import.meta.dir) : undefined;
        const jevLogsPath = resolveJevLogsPath(projectRoot);
        const plugin = generateClaudePlugin({
          jevLogsPath,
          sessionLogPath: logPath,
          env: process.env,
        });

        if (!plugin.skipped) {
          childArgs = addPluginDirArg(childArgs, plugin.pluginDir);
          pluginCleanup = plugin.cleanup;
        }
      } catch (error) {
        console.error(`[Jev] could not generate jev-logs plugin: ${error instanceof Error ? error.message : "unknown error"}`);
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
      childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION = CLAUDE_SENTINEL;
      childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = "Coding Router Jev";
      childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = "JEV selects the model and reasoning effort for each user intent.";
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
  statusDisplay?.cleanup();
}
