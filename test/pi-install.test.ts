import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dir, ".."));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

describe("Pi package manifest", () => {
  test("package.json declares pi.extensions", () => {
    expect(pkg.pi).toBeDefined();
    expect(Array.isArray(pkg.pi.extensions)).toBe(true);
    expect(pkg.pi.extensions.length).toBeGreaterThan(0);
  });

  test("package.json declares pi.skills", () => {
    expect(pkg.pi).toBeDefined();
    expect(Array.isArray(pkg.pi.skills)).toBe(true);
    expect(pkg.pi.skills.length).toBeGreaterThan(0);
  });

  test("pi.extensions paths resolve to existing files", () => {
    for (const ext of pkg.pi.extensions) {
      const resolved = resolve(ROOT, ext);
      expect(existsSync(resolved)).toBe(true);
      expect(statSync(resolved).isFile()).toBe(true);
    }
  });

  test("pi.skills paths resolve to existing directories with SKILL.md", () => {
    for (const skill of pkg.pi.skills) {
      const dir = resolve(ROOT, skill);
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      const skillFile = join(dir, "SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
    }
  });

  test("pi.extensions includes the pi-extension adapter", () => {
    expect(pkg.pi.extensions).toContain("./src/pi-extension.ts");
  });

  test("pi.skills includes the Pi jev-logs skill", () => {
    expect(pkg.pi.skills).toContain("./skills/pi/jev-logs");
  });
});

describe("Pi peer dependencies", () => {
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

  test("Pi host packages are not in devDependencies", () => {
    const devDeps = pkg.devDependencies ?? {};
    expect(devDeps["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(devDeps["@earendil-works/pi-ai"]).toBeUndefined();
  });
});

describe("package identity", () => {
  test("package remains private", () => {
    expect(pkg.private).toBe(true);
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

describe("Pi adapter startup validation", () => {
  test("createPiAdapter throws with empty registry (missing catalog model)", async () => {
    const { createPiAdapter } = await import("../src/pi-extension");
    const { configFromEnv } = await import("../src/config");

    const emptyRegistry = {
      find: () => undefined,
      list: () => [],
    };
    const clamp = {
      getSupportedThinkingLevels: () => [] as string[],
      clampThinkingLevel: (_m: unknown, l: string) => l,
    };

    const adapter = createPiAdapter({
      config: configFromEnv({}),
      route: async () => ({ request: {} as any, response: null, error: "test", ms: 0 }),
      registry: emptyRegistry as any,
      clamp: clamp as any,
    });

    await expect(
      adapter.resolveModel({ reason: "user", text: "test" }),
    ).rejects.toThrow(/No eligible Pi models/);
  });

  test("createPiAdapter throws descriptive error when no startup model", () => {
    const { createPiAdapter } = require("../src/pi-extension");
    const { configFromEnv } = require("../src/config");

    const emptyRegistry = {
      find: () => undefined,
      list: () => [],
    };
    const clamp = {
      getSupportedThinkingLevels: () => [] as string[],
      clampThinkingLevel: (_m: unknown, l: string) => l,
    };

    const adapter = createPiAdapter({
      config: configFromEnv({}),
      route: async () => ({ request: {} as any, response: null, error: "test", ms: 0 }),
      registry: emptyRegistry,
      clamp,
    });

    expect(() =>
      adapter.resolveModel({ reason: "continuation" }),
    ).toThrow(/No valid Pi models configured/);
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
