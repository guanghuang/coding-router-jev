import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
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

  test("pi-extension exports activate function", async () => {
    const mod = await import("../src/pi-extension");
    expect(typeof mod.activate).toBe("function");
  });

  test("pi-extension exports createPiAdapter function", async () => {
    const mod = await import("../src/pi-extension");
    expect(typeof mod.createPiAdapter).toBe("function");
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
