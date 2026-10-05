import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { configFromEnv } from "../src/config";
import { DEFAULT_LOG_DIR } from "../src/history";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

describe("Pi package manifest", () => {
  test("package.json declares pi.extensions", () => {
    expect(pkg.pi).toBeDefined();
    expect(Array.isArray(pkg.pi.extensions)).toBe(true);
    expect(pkg.pi.extensions).toHaveLength(1);
  });

  test("package.json declares pi.skills", () => {
    expect(pkg.pi).toBeDefined();
    expect(Array.isArray(pkg.pi.skills)).toBe(true);
    expect(pkg.pi.skills).toHaveLength(1);
  });

  test("pi.extensions paths resolve to existing files", () => {
    expect(pkg.pi).toBeDefined();
    for (const ext of pkg.pi.extensions) {
      const resolved = resolve(ROOT, ext);
      expect(existsSync(resolved)).toBe(true);
      expect(statSync(resolved).isFile()).toBe(true);
    }
  });

  test("pi.skills paths resolve to existing directories with SKILL.md", () => {
    expect(pkg.pi).toBeDefined();
    for (const skill of pkg.pi.skills) {
      const dir = resolve(ROOT, skill);
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      const skillFile = join(dir, "SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
      expect(statSync(skillFile).isFile()).toBe(true);
    }
  });

  test("pi.extensions includes the pi-extension adapter", () => {
    expect(pkg.pi.extensions).toContain("./src/pi-extension.ts");
  });

  test("pi.skills includes the Pi jev-logs skill", () => {
    expect(pkg.pi.skills).toContain("./skills/pi/jev-logs");
  });

  test("pi-extension exports Pi's default factory and testable adapter helpers", async () => {
    const mod = await import("../src/pi-extension");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.activate).toBe("function");
    expect(typeof mod.createPiAdapter).toBe("function");
  });

  test("default factory registers a native Pi virtual-model route", async () => {
    const mod = await import("../src/pi-extension");
    let definition: Record<string, unknown> | undefined;
    const handlers = new Map<string, Function>();
    let renderer: Function | undefined;
    let tool: { execute: Function } | undefined;
    await mod.default({
      registerVirtualModel(value: Record<string, unknown>) { definition = value; },
      registerTool(value: { name: string; execute: Function }) {
        expect(value.name).toBe("jev_logs");
        tool = value;
      },
      registerEntryRenderer(type: string, value: Function) {
        expect(type).toBe("coding-router-jev");
        renderer = value;
      },
      on(event: string, handler: Function) { handlers.set(event, handler); return () => {}; },
    } as never);
    expect(definition?.provider).toBe("jev");
    expect(definition?.id).toBe("auto");
    expect(typeof definition?.route).toBe("function");
    expect(typeof handlers.get("session_start")).toBe("function");
    const beforeStart = handlers.get("before_agent_start")!;
    expect(beforeStart({ systemPrompt: "Base" }, { model: { provider: "jev", id: "auto" } }).systemPrompt)
      .toContain("not commands or skills");
    expect(beforeStart({ systemPrompt: "Base" }, { model: { provider: "openai", id: "test" } })).toBeUndefined();
    const message = "[Jev] tier: fast; decision: JEV/no-change, confidence: 0.74.";
    const component = renderer!({ data: { message } }, {}, { fg: (_color: string, text: string) => text });
    expect(component.render(120).join("\n")).toContain(message);
    const sessionId = `test-${randomUUID()}`;
    const path = join(DEFAULT_LOG_DIR, `jev-${sessionId}.jsonl`);
    const modelName = configFromEnv().piModels.fast;
    const slash = modelName.indexOf("/");
    const model = {
      provider: modelName.slice(0, slash), id: modelName.slice(slash + 1),
      name: "Test model", api: "openai-responses", reasoning: false, contextWindow: 1000000,
    };
    const ctx = {
      hasUI: false,
      sessionManager: { getSessionId: () => sessionId },
      modelRegistry: { getAvailable: () => [model], find: () => model },
    };
    try {
      for (let i = 0; i < 2; i++) {
        const result = await (definition!.route as Function)({ reason: "user", messages: [
          { role: "system", content: "System instructions. ".repeat(100) },
          ...(i === 1 ? [{ role: "assistant", content: [{ type: "text", text: "Prior answer" }],
            timestamp: Date.now() - 2 * 3600 * 1000, stopReason: "stop" }] : []),
          { role: "user", content: "use luna say hi" },
        ] }, ctx);
        expect(result.model.id).toBe(model.id);
        handlers.get("message_end")!({ message: {
          role: "assistant", provider: model.provider, model: model.id,
          usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 },
        } }, ctx);
        await (definition!.route as Function)({ reason: "continuation", messages: [] }, ctx);
        handlers.get("message_end")!({ message: {
          role: "assistant", provider: model.provider, model: model.id,
          usage: { input: 20, output: 5, cacheRead: 25, cacheWrite: 0 },
        } }, ctx);
      }
      const records = readFileSync(path, "utf-8").trim().split("\n").map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0].id).not.toBe(records[1].id);
      expect(records[0].decision.reason).toContain("override");
      expect(records[0].jev.request.state.session.context_tokens).toBeGreaterThan(400);
      expect(records[0].jev.request.state.session.last_response_at).toBeNull();
      expect(records[0].jev.request.state.session.last_response_seconds_ago).toBeNull();
      expect(records[1].jev.request.state.session.last_response_seconds_ago).toBeGreaterThanOrEqual(7200);
      expect(records[1].jev.request.state.purpose).toContain("long idle period");
      expect(records[0].cache.agent_usage.cache_read_tokens).toBe(75);
      expect(records[1].cache.agent_usage.cache_read_tokens).toBe(75);
      expect(records[1].cache.agent_usage.input_tokens).toBe(120);
      expect(records[1].response.observed_responses).toBe(2);
      const result = await tool!.execute("test", { last: 1, detail: true }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain(model.id);
      expect(result.content[0].text).toContain("75");
    } finally {
      rmSync(path, { force: true });
    }
  });
  test("Pi loads bundled skill frontmatter without warnings", () => {
    for (const dir of ["skills/pi/jev-logs", "skills/jev-logs"]) {
      const result = loadSkillsFromDir({ dir: join(ROOT, dir), source: "test" });
      expect(result.diagnostics).toEqual([]);
      expect(result.skills[0]?.name).toBe("jev-logs");
      expect(result.skills[0]?.description).toBeTruthy();
    }
  });
});

describe("Pi peer dependencies", () => {
  test("typebox is host-provided with an optional wildcard peer and local dev dependency", () => {
    expect(pkg.dependencies.typebox).toBeUndefined();
    expect(pkg.peerDependencies.typebox).toBe("*");
    expect(pkg.peerDependenciesMeta.typebox.optional).toBe(true);
    expect(pkg.devDependencies.typebox).toBeDefined();
  });
  test("peerDependencies declare Pi host packages as wildcard", () => {
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
  });

  test("peerDependenciesMeta marks Pi packages as optional", () => {
    expect(pkg.peerDependenciesMeta).toBeDefined();
    expect(pkg.peerDependenciesMeta["@earendil-works/pi-coding-agent"]).toEqual({ optional: true });
    expect(pkg.peerDependenciesMeta["@earendil-works/pi-ai"]).toEqual({ optional: true });
  });

  test("Pi host packages are not in runtime dependencies", () => {
    const deps = pkg.dependencies ?? {};
    expect(deps["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(deps["@earendil-works/pi-ai"]).toBeUndefined();
  });

  test("Pi host packages are dev dependencies for type-checking and adapter tests", () => {
    const devDeps = pkg.devDependencies ?? {};
    expect(devDeps["@earendil-works/pi-coding-agent"]).toBe("1.0.2");
    expect(devDeps["@earendil-works/pi-ai"]).toBe("1.0.2");
  });
});

describe("package identity", () => {
  test("package remains private", () => {
    expect(pkg.private).toBe(true);
  });

  test("package name matches Pi remove command in docs", () => {
    expect(pkg.name).toBe("coding-router-jev");
  });

  test("existing Codex bin mappings preserved", () => {
    expect(pkg.bin["codex-jev"]).toBe("src/cli.ts");
    expect(pkg.bin["jev-logs"]).toBe("src/jev-logs.ts");
  });

  test("build script preserved", () => {
    expect(pkg.scripts.build).toContain("codex-jev");
    expect(pkg.scripts.build).toContain("jev-logs");
  });

  test("check and test scripts preserved", () => {
    expect(pkg.scripts.check).toBe("tsc --noEmit");
    expect(pkg.scripts.test).toBe("bun test");
  });
});

describe("Pi skill content", () => {
  test("Pi jev-logs SKILL.md mentions Pi-specific features", () => {
    const content = readFileSync(
      join(ROOT, "skills", "pi", "jev-logs", "SKILL.md"),
      "utf-8",
    );
    expect(content).toContain("Pi");
    expect(content).toContain("jev_logs");
    expect(content).toContain("managed by coding-router-jev");
  });

  test("Codex jev-logs SKILL.md is separate from Pi skill", () => {
    const codexSkill = readFileSync(
      join(ROOT, "skills", "jev-logs", "SKILL.md"),
      "utf-8",
    );
    const piSkill = readFileSync(
      join(ROOT, "skills", "pi", "jev-logs", "SKILL.md"),
      "utf-8",
    );
    expect(codexSkill).not.toBe(piSkill);
    expect(codexSkill).toContain("JEV_SESSION_LOG");
    expect(piSkill).toContain("Pi");
  });
});

describe(".env.example documentation", () => {
  const envContent = readFileSync(join(ROOT, ".env.example"), "utf-8");

  test("documents Pi provider login as separate from TYPESAFE_API_KEY", () => {
    expect(envContent).toContain("Pi provider login");
    expect(envContent).toContain("pi provider login");
    expect(envContent).toContain("separate from TYPESAFE_API_KEY");
  });

  test("documents Pi model mappings", () => {
    expect(envContent).toContain("CODING_ROUTER_FAST_MODEL_PI");
    expect(envContent).toContain("CODING_ROUTER_BALANCED_MODEL_PI");
    expect(envContent).toContain("CODING_ROUTER_STRONG_MODEL_PI");
    expect(envContent).toContain("CODING_ROUTER_LONG_MODEL_PI");
  });
});

describe("negative manifest validation", () => {
  test("pi field is an object, not array or string", () => {
    expect(typeof pkg.pi).toBe("object");
    expect(Array.isArray(pkg.pi)).toBe(false);
  });

  test("pi.extensions entries are strings", () => {
    for (const ext of pkg.pi.extensions) {
      expect(typeof ext).toBe("string");
    }
  });

  test("pi.skills entries are strings", () => {
    for (const skill of pkg.pi.skills) {
      expect(typeof skill).toBe("string");
    }
  });
});
