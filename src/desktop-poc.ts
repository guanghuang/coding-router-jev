#!/usr/bin/env bun
import { configFromEnv, loadEnv } from "./config";
import { startProxy } from "./proxy";

try {
  const args = process.argv.slice(2);
  const usage = "Usage: codex-jev-proxy [--host ADDRESS] [--port PORT] (default: 127.0.0.1:8765)";
  if (args.length === 1 && args[0] === "--help") { console.log(usage); process.exit(0); }
  let hostname = "127.0.0.1";
  let port = 8765;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === "--host" && value && !value.startsWith("-") && !/[\s/]/.test(value)) hostname = value;
    else if (args[i] === "--port" && value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) port = Number(value);
    else throw new Error(usage);
  }
  await loadEnv();
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is required; set it in the environment or ~/.coding-router-jev.env");
  const config = configFromEnv();
  const proxy = startProxy(config, {
    port,
    hostname,
    desktopNotice: true,
    onDecision: config.showFeedback ? notice => console.log(notice) : undefined,
  });
  console.log(`Codex desktop proxy: http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${proxy.port}`);
  console.log(`Routing log: ${proxy.logPath}`);
  console.log("Press Ctrl+C to stop.");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { proxy.close(); process.exit(0); });
} catch (error) {
  console.error(`codex-jev-proxy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
