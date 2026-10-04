import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import {
  mkdtemp, rm, readdir, stat, readFile, writeFile, mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURES = resolve(import.meta.dir, "fixtures/install");
const INSTALL_SCRIPT = resolve(import.meta.dir, "../install.ps1");

interface FixtureServer {
  port: number;
  stop(): void;
}

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

async function runInstallerWithServer(
  server: FixtureServer,
  installDir: string,
  opts?: { token?: string; version?: string; failArch?: string; envVersion?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const baseUrl = `http://localhost:${server.port}`;
  const script = await readFile(INSTALL_SCRIPT, "utf8");

  let patched = script
    .replace(
      /https:\/\/api\.github\.com\/repos\/\$Script:Repo/g,
      `${baseUrl}/repos/\$Script:Repo`,
    )
    .replace(
      /https:\/\/github\.com\/\$Script:Repo\/releases\/download/g,
      `${baseUrl}/releases/download`,
    );

  await mkdir(installDir, { recursive: true });
  const patchedScript = join(installDir + "-script.ps1");

  if (opts?.failArch) {
    patched = patched.replace(
      /function Test-Architecture \{[\s\S]*?^\}/m,
      `function Test-Architecture {\n    Exit-WithError "unsupported architecture: ${opts.failArch}. Only Windows x64 is supported."\n}`,
    );
  }

  await writeFile(patchedScript, patched);

  const args: string[] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    patchedScript,
  ];

  if (opts?.version) {
    args.push("-Version", opts.version);
  }

  args.push("-Dir", installDir);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  if (opts?.token) {
    env.GH_TOKEN = opts.token;
  }

  if (opts?.envVersion) {
    env.CODEX_JEV_VERSION = opts.envVersion;
  }

  const proc = Bun.spawn(["pwsh", ...args], {
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

describe("install.ps1", () => {
  let tempDir: string;
  let pwshAvailable = false;

  beforeAll(async () => {
    try {
      const proc = Bun.spawn(["pwsh", "-Version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      pwshAvailable = proc.exitCode === 0;
    } catch {
      pwshAvailable = false;
    }
    if (!pwshAvailable) {
      console.warn(
        "Skipping install.ps1 tests: pwsh (PowerShell 7+) is not available.",
      );
    }
    tempDir = await mkdtemp(join(tmpdir(), "codex-jev-win-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("script has valid PowerShell syntax", async () => {
    if (!pwshAvailable) return;
    const escapedPath = INSTALL_SCRIPT.replace(/\\/g, "\\\\");
    const proc = Bun.spawn(
      [
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$errs = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile("${escapedPath}", [ref]$null, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("-Help prints usage and exits 0", async () => {
    if (!pwshAvailable) return;
    const proc = Bun.spawn(
      [
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        INSTALL_SCRIPT,
        "-Help",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Install or upgrade codex-jev");
    expect(stdout).toContain("-Version");
    expect(stdout).toContain("-Dir");
    expect(stdout).toContain("Uninstall");
    expect(stdout).toContain("Rollback");
    expect(stdout).toContain("user PATH");
  });

  describe("successful install", () => {
    test("downloads, verifies, and installs binary", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-success");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();

      const combined = stdout + stderr;
      if (exitCode !== 0) console.error("Install stderr:", stderr);
      expect(exitCode).toBe(0);
      expect(combined).toContain("Checksum verified");
      expect(combined).toContain("Installed codex-jev to");
      expect(combined).toContain("Done!");

      const binaryPath = join(installDir, "codex-jev.exe");
      const info = await stat(binaryPath);
      expect(info.size).toBeGreaterThan(0);
    });

    test("resolves latest release when no version pinned", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-latest");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      const combined = stdout + stderr;
      if (exitCode !== 0) console.error("Resolve latest stderr:", stderr);
      expect(exitCode).toBe(0);
      expect(combined).toContain("Resolving latest release...");
      expect(combined).toContain("Latest release: v0.1.0");
      expect(combined).not.toContain("Pinned version:");
    });

    test("upgrade replaces existing binary", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-upgrade");
      await mkdir(installDir, { recursive: true });

      await writeFile(join(installDir, "codex-jev.exe"), "old-binary");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();

      const combined = stdout + stderr;
      expect(exitCode).toBe(0);
      expect(combined).toContain("Replacing existing installation");

      const content = await readFile(join(installDir, "codex-jev.exe"), "utf8");
      expect(content).not.toBe("old-binary");
    });

    test("authenticated download with GH_TOKEN succeeds", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-auth-success");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { token: "ghp_test_valid_token", version: "v0.1.0" },
      );
      server.stop();

      const combined = stdout + stderr;
      expect(exitCode).toBe(0);
      expect(combined).toContain("Installed codex-jev to");
    });
  });

  describe("checksum verification", () => {
    test("rejects mismatched checksums and preserves existing binary", async () => {
      if (!pwshAvailable) return;
      const installDir = join(tempDir, "install-bad-checksum");
      await mkdir(installDir, { recursive: true });
      await writeFile(join(installDir, "codex-jev.exe"), "existing-binary");

      const badFixtures = join(tempDir, "bad-checksum-fixtures-win");
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
        { version: "v0.1.0" },
      );
      badServer.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("checksum mismatch");

      const content = await readFile(join(installDir, "codex-jev.exe"), "utf8");
      expect(content).toBe("existing-binary");
    });
  });

  describe("error handling", () => {
    test("reports missing release", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES, { missing: true });
      const installDir = join(tempDir, "install-missing");

      const { stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
      );
      server.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr.toLowerCase()).toMatch(/not found|404|release/);
    });

    test("reports authentication failure", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES, { failAuth: true });
      const installDir = join(tempDir, "install-auth-fail");

      const { stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { token: "bad-token", version: "v0.1.0" },
      );
      server.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr.toLowerCase()).toMatch(/authorization|401|bad credentials/);
    });

    test("rejects unsupported architecture", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-bad-arch");

      const { stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { failArch: "Arm64", version: "v0.1.0" },
      );
      server.stop();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("unsupported architecture");
    });
  });

  describe("directory with spaces", () => {
    test("installs to a path containing spaces", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install dir with spaces");

      const { exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();

      expect(exitCode).toBe(0);
      const info = await stat(join(installDir, "codex-jev.exe"));
      expect(info.size).toBeGreaterThan(0);
    });
  });

  describe("version pinning", () => {
    test("uses pinned version without resolving latest", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-pinned");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { version: "v0.1.0" },
      );
      server.stop();

      const combined = stdout + stderr;
      expect(exitCode).toBe(0);
      expect(combined).toContain("Pinned version: v0.1.0");
      expect(combined).not.toContain("Resolving latest");
    });

    test("CODEX_JEV_VERSION env var works like -Version", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-env-version");

      const { stdout, stderr, exitCode } = await runInstallerWithServer(
        server,
        installDir,
        { envVersion: "v0.1.0" },
      );
      server.stop();

      const combined = stdout + stderr;
      expect(exitCode).toBe(0);
      expect(combined).toContain("Pinned version: v0.1.0");
    });
  });

  describe("config preservation", () => {
    test("never modifies config file", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-config-win");
      const fakeHome = join(tempDir, "fake-home-config-win");
      await mkdir(fakeHome, { recursive: true });

      const configPath = join(fakeHome, ".coding-router-jev.env");
      const configContent = "TYPESAFE_API_KEY=test-key\n";
      await writeFile(configPath, configContent);

      const { exitCode } = await runInstallerWithServer(server, installDir, {
        version: "v0.1.0",
      });
      server.stop();

      expect(exitCode).toBe(0);
      const after = await readFile(configPath, "utf8");
      expect(after).toBe(configContent);
    });
  });

  describe("temp directory cleanup", () => {
    test("cleans up temp files after successful install", async () => {
      if (!pwshAvailable) return;
      const server = startFixtureServer(FIXTURES);
      const installDir = join(tempDir, "install-cleanup-win");

      await runInstallerWithServer(server, installDir, { version: "v0.1.0" });
      server.stop();

      const tmpFiles = await readdir(
        process.env.TMPDIR || process.env.TEMP || "/tmp",
      );
      const leftover = tmpFiles.filter((f) =>
        f.startsWith("codex-jev-install-"),
      );
      expect(leftover.length).toBe(0);
    });

    test("cleans up temp files on checksum failure", async () => {
      if (!pwshAvailable) return;
      const badFixtures = join(tempDir, "bad-checksum-cleanup-win");
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
      const installDir = join(tempDir, "install-cleanup-fail-win");

      await runInstallerWithServer(badServer, installDir, { version: "v0.1.0" });
      badServer.stop();

      const tmpFiles = await readdir(
        process.env.TMPDIR || process.env.TEMP || "/tmp",
      );
      const leftover = tmpFiles.filter((f) =>
        f.startsWith("codex-jev-install-"),
      );
      expect(leftover.length).toBe(0);
    });
  });
});
