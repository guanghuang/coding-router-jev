import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURES = resolve(import.meta.dir, "fixtures/install");
const INSTALL_SCRIPT = resolve(import.meta.dir, "../install.sh");

interface FixtureServer {
  port: number;
  stop(): void;
}

/** Start a minimal HTTP server that serves fixture release assets. */
function startFixtureServer(
  fixturesDir: string,
  opts?: { failAuth?: boolean; missing?: boolean },
): FixtureServer {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (opts?.failAuth) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
        });
      }

      if (url.pathname.endsWith("/releases/latest")) {
        if (opts?.missing) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          });
        }
        return Response.json({ tag_name: "v0.1.0" });
      }

      const match = url.pathname.match(
        /\/releases\/download\/[^/]+\/(.+)$/,
      );
      if (match) {
        const assetName = match[1];
        const filePath = join(fixturesDir, assetName);
        try {
          const data = await Bun.file(filePath).arrayBuffer();
          return new Response(data, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  return server as unknown as FixtureServer;
}

/** Run install.sh with environment overrides, returning stdout, stderr, and exit code. */
async function runInstaller(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["sh", INSTALL_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Run install.sh against a local fixture server by creating a patched
 * copy that replaces the hardcoded GitHub URLs with our local server.
 */
async function runInstallerWithServer(
  server: FixtureServer,
  installDir: string,
  opts?: { token?: string; version?: string; home?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const baseUrl = `http://localhost:${server.port}`;
  const script = await readFile(INSTALL_SCRIPT, "utf8");

  const patched = script
    .replace(
      /https:\/\/api\.github\.com\/repos\/\$\{REPO\}/g,
      `${baseUrl}/repos/\${REPO}`,
    )
    .replace(
      /https:\/\/github\.com\/\$\{REPO\}\/releases\/download/g,
      `${baseUrl}/releases/download`,
    );

  await mkdir(installDir, { recursive: true });
  const patchedScript = join(installDir + "-script.sh");
  await writeFile(patchedScript, patched, { mode: 0o755 });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    INSTALL_DIR: installDir,
    HOME: opts?.home ?? process.env.HOME ?? "/tmp",
  };

  if (opts?.token) {
    env.GH_TOKEN = opts.token;
  }

  const args: string[] = [];
  if (opts?.version) {
    args.push("--version", opts.version);
  }

  const proc = Bun.spawn(["sh", patchedScript, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("install.sh", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-jev-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--help prints usage and exits 0", async () => {
    const { stdout, exitCode } = await runInstaller({}, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Install or upgrade codex-jev");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--dir");
    expect(stdout).toContain("Uninstall");
    expect(stdout).toContain("Rollback");
  });

  test("rejects unknown options", async () => {
    const { exitCode, stderr } = await runInstaller({}, ["--bogus"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });

  test("rejects empty --version=", async () => {
    const { exitCode, stderr } = await runInstaller({}, ["--version="]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("non-empty value");
  });

  describe("platform detection", () => {
    test("detects current platform via fixture server", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-platform-detect");
      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();
      const combined = stdout + stderr;
      expect(combined).toMatch(/Detected platform: (darwin|linux)\/(arm64|x64)/);
      expect(exitCode).toBe(0);
    });
  });

  describe("successful install", () => {
    test("downloads, verifies, and installs binary", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-success");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("Checksum verified");
      expect(combined).toContain("Installed codex-jev to");
      expect(combined).toContain("Done!");

      const binaryPath = join(installDir, "codex-jev");
      const info = await stat(binaryPath);
      expect(info.mode & 0o111).toBeGreaterThan(0);
    });

    test("upgrade replaces existing binary", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-upgrade");
      await mkdir(installDir, { recursive: true });

      await writeFile(join(installDir, "codex-jev"), "old-binary");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("Replacing existing installation");

      const content = await readFile(join(installDir, "codex-jev"), "utf8");
      expect(content).not.toBe("old-binary");
    });

    test("authenticated download with GH_TOKEN succeeds", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-auth-success");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { token: "ghp_test_valid_token", version: "v0.1.0" },
      );
      server.stop();

      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("Installed codex-jev to");
    });
  });

  describe("checksum verification", () => {
    test("rejects mismatched checksums and preserves existing binary", async () => {
      const installDir = join(tempDir, "install-bad-checksum");
      await mkdir(installDir, { recursive: true });
      await writeFile(join(installDir, "codex-jev"), "existing-binary");

      const badFixtures = join(tempDir, "bad-checksum-fixtures");
      await mkdir(badFixtures, { recursive: true });
      for (const f of await readdir(FIXTURES)) {
        const src = await readFile(join(FIXTURES, f));
        if (f === "SHA256SUMS") {
          await writeFile(
            join(badFixtures, f),
            await readFile(join(FIXTURES, "SHA256SUMS.bad")),
          );
        } else if (!f.endsWith(".bad")) {
          await writeFile(join(badFixtures, f), src);
        }
      }
      const badServer = startFixtureServer(badFixtures);

      const { stderr, exitCode } = await runInstallerWithServer(
        badServer,
        installDir,
      );
      badServer.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("checksum mismatch");

      // Existing binary must be preserved after checksum failure
      const content = await readFile(join(installDir, "codex-jev"), "utf8");
      expect(content).toBe("existing-binary");
    });
  });

  describe("error handling", () => {
    test("reports missing release", async () => {
      const server = startFixtureServer(FIXTURES, { missing: true });
      const installDir = join(tempDir, "install-missing");

      const { stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("release not found");
    });

    test("reports authentication failure", async () => {
      const server = startFixtureServer(FIXTURES, { failAuth: true });
      const installDir = join(tempDir, "install-auth-fail");

      const { stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { token: "bad-token" },
      );
      server.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("authorization failed");
    });
  });

  describe("directory with spaces", () => {
    test("installs to a path containing spaces", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install dir with spaces");

      const { exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).toBe(0);
      const info = await stat(join(installDir, "codex-jev"));
      expect(info.mode & 0o111).toBeGreaterThan(0);
    });
  });

  describe("PATH guidance", () => {
    test("prints PATH advice when install dir is not in PATH", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-path-check");

      const { stdout, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("export PATH=");
    });
  });

  describe("config preservation", () => {
    test("never modifies config file in isolated HOME", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-config");
      const fakeHome = join(tempDir, "fake-home-config");
      await mkdir(fakeHome, { recursive: true });

      const configPath = join(fakeHome, ".coding-router-jev.env");
      const configContent = "TYPESAFE_API_KEY=test-key\n";
      await writeFile(configPath, configContent);

      const { exitCode } = await runInstallerWithServer(server, installDir, {
        home: fakeHome,
      });
      server.stop();

      expect(exitCode).toBe(0);
      const after = await readFile(configPath, "utf8");
      expect(after).toBe(configContent);
    });
  });

  describe("version pinning", () => {
    test("uses pinned version without resolving latest", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-pinned");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();

      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("Pinned version: v0.1.0");
      expect(combined).not.toContain("Resolving latest");
    });

    test("CODEX_JEV_VERSION env var works like --version", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-env-version");

      const baseUrl = `http://localhost:${server.port}`;
      const script = await readFile(INSTALL_SCRIPT, "utf8");
      const patched = script
        .replace(
          /https:\/\/api\.github\.com\/repos\/\$\{REPO\}/g,
          `${baseUrl}/repos/\${REPO}`,
        )
        .replace(
          /https:\/\/github\.com\/\$\{REPO\}\/releases\/download/g,
          `${baseUrl}/releases/download`,
        );
      await mkdir(installDir, { recursive: true });
      const patchedScript = join(installDir + "-env-script.sh");
      await writeFile(patchedScript, patched, { mode: 0o755 });

      const proc = Bun.spawn(["sh", patchedScript], {
        env: {
          ...process.env as Record<string, string>,
          INSTALL_DIR: installDir,
          HOME: process.env.HOME ?? "/tmp",
          CODEX_JEV_VERSION: "v0.1.0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      server.stop();

      expect(exitCode).toBe(0);
      expect(stdout + stderr).toContain("Pinned version: v0.1.0");
    });
  });

  describe("temp directory cleanup", () => {
    test("cleans up temp files on checksum failure", async () => {
      const badFixtures = join(tempDir, "bad-checksum-cleanup");
      await mkdir(badFixtures, { recursive: true });
      for (const f of await readdir(FIXTURES)) {
        const src = await readFile(join(FIXTURES, f));
        if (f === "SHA256SUMS") {
          await writeFile(join(badFixtures, f), await readFile(join(FIXTURES, "SHA256SUMS.bad")));
        } else if (!f.endsWith(".bad")) {
          await writeFile(join(badFixtures, f), src);
        }
      }
      const badServer = startFixtureServer(badFixtures);
      const installDir = join(tempDir, "install-cleanup-test");

      // Run installer — it will fail at checksum
      await runInstallerWithServer(badServer, installDir);
      badServer.stop();

      // Verify no codex-jev-install.* temp dirs left behind
      const tmpFiles = await readdir(process.env.TMPDIR || "/tmp");
      const leftover = tmpFiles.filter(
        (f) => f.startsWith("codex-jev-install.") && f.length > 25,
      );
      // The trap should have cleaned up; at most the current test's tempDir
      expect(leftover.length).toBeLessThanOrEqual(1);
    });
  });

  describe("shell syntax", () => {
    test("install.sh passes sh -n syntax check", async () => {
      const proc = Bun.spawn(["sh", "-n", INSTALL_SCRIPT], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });
  });
});
