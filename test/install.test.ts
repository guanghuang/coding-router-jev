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

      // GitHub API latest-release endpoint
      if (url.pathname.endsWith("/releases/latest")) {
        if (opts?.missing) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          });
        }
        return Response.json({ tag_name: "v0.1.0" });
      }

      // Asset download endpoint — serve fixture files
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

  describe("platform detection", () => {
    test("detects current platform without error", async () => {
      // Use a pinned version so resolve_version doesn't hit the network,
      // but let it fail at download (no server). We only care that
      // platform detection succeeds.
      const { stdout, stderr } = await runInstaller(
        { CODEX_JEV_VERSION: "v0.0.0-test" },
      );
      const combined = stdout + stderr;
      expect(combined).toMatch(/Detected platform: (darwin|linux)\/(arm64|x64)/);
    });
  });

  describe("successful install", () => {
    test("downloads, verifies, and installs binary", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-success");

      // Override the GitHub URLs to point at our fixture server.
      // install.sh uses hardcoded github.com URLs, so we patch via a
      // wrapper that rewrites REPO base URL through env.
      // Instead, we'll serve fixtures and point the script at our server.
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

      // Verify binary exists and is executable
      const binaryPath = join(installDir, "codex-jev");
      const info = await stat(binaryPath);
      expect(info.mode & 0o111).toBeGreaterThan(0);
    });

    test("upgrade replaces existing binary", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-upgrade");
      await mkdir(installDir, { recursive: true });

      // Place an "old" binary
      await writeFile(join(installDir, "codex-jev"), "old-binary");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("Replacing existing installation");

      // Verify the binary was replaced
      const content = await readFile(join(installDir, "codex-jev"), "utf8");
      expect(content).not.toBe("old-binary");
    });
  });

  describe("checksum verification", () => {
    test("rejects mismatched checksums", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-bad-checksum");

      // Serve bad checksums: copy fixtures, replace SHA256SUMS
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

      // Verify no binary was installed
      try {
        await stat(join(installDir, "codex-jev"));
        throw new Error("binary should not exist after checksum failure");
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e) {
          expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
        } else {
          throw e;
        }
      }
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

      const { exitCode, stdout, stderr } = await runInstallerWithServer(
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
    test("never modifies existing config file", async () => {
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-config");
      const configFile = join(
        process.env.HOME || "/tmp",
        ".coding-router-jev.env",
      );

      // Read config before (if it exists)
      let configBefore: string | null = null;
      try {
        configBefore = await readFile(configFile, "utf8");
      } catch {
        // File may not exist — that's fine
      }

      const { exitCode } = await runInstallerWithServer(server, installDir);
      server.stop();

      expect(exitCode).toBe(0);

      // Verify config unchanged (or still absent)
      let configAfter: string | null = null;
      try {
        configAfter = await readFile(configFile, "utf8");
      } catch {
        // Still absent — fine
      }
      expect(configAfter).toBe(configBefore);
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

/**
 * Run install.sh against a local fixture server by creating a patched
 * copy that replaces the hardcoded GitHub URLs with our local server.
 */
async function runInstallerWithServer(
  server: FixtureServer,
  installDir: string,
  opts?: { token?: string; version?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const baseUrl = `http://localhost:${server.port}`;
  const script = await readFile(INSTALL_SCRIPT, "utf8");

  // Replace GitHub URLs with local server URLs
  const patched = script
    .replace(
      /https:\/\/api\.github\.com\/repos\/\$\{REPO\}/g,
      `${baseUrl}/repos/\${REPO}`,
    )
    .replace(
      /https:\/\/github\.com\/\$\{REPO\}\/releases\/download/g,
      `${baseUrl}/releases/download`,
    );

  const patchedScript = join(installDir + "-script.sh");
  await writeFile(patchedScript, patched, { mode: 0o755 });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    INSTALL_DIR: installDir,
    HOME: process.env.HOME || "/tmp",
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
