#!/usr/bin/env bun
import { configFromEnv, loadEnv } from "./config";
import { startProxy } from "./proxy";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log("Usage: codex-jev-proxy [--port PORT] (default: 8765)"); process.exit(0); }
  if (args.length && (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]) || Number(args[1]) < 1 || Number(args[1]) > 65535)) throw new Error("Usage: codex-jev-proxy [--port PORT] (1–65535)");
  await loadEnv();
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is required; set it in the environment or ~/.coding-router-jev.env");
  const config = configFromEnv();
  const proxy = startProxy(config, {
    port: args.length ? Number(args[1]) : 8765,
    desktopNotice: true,
    onDecision: config.showFeedback ? notice => console.log(notice) : undefined,
  });
  console.log(`Codex desktop proxy: http://127.0.0.1:${proxy.port}`);
  console.log(`Routing log: ${proxy.logPath}`);
  console.log("Press Ctrl+C to stop.");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { proxy.close(); process.exit(0); });
} catch (error) {
  console.error(`codex-jev-proxy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
