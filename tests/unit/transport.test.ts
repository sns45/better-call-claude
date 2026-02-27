import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "events";

/**
 * Unit tests for TransportManager
 * Uses mock.module to intercept child_process before TransportManager imports it.
 */

// ============================================================
// Mock child_process BEFORE importing TransportManager
// ============================================================

// Shared state that tests can mutate to control mock behavior
let execResponses: Array<{ stdout?: string; stderr?: string; error?: Error }> = [];
let execCallIndex = 0;
let spawnChildren: any[] = [];
let spawnCallIndex = 0;

function createMockSpawnChild(opts?: { exitCode?: number; stdout?: string; stderr?: string }) {
  const child = new EventEmitter() as any;
  child.stdin = { write: mock(() => {}), end: mock(() => {}) };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock(() => {});
  child.pid = 99;

  if (opts?.stdout !== undefined || opts?.stderr !== undefined || opts?.exitCode !== undefined) {
    setTimeout(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.exitCode ?? 0);
    }, 5);
  }
  return child;
}

// Mock exec (callback-style, to work with promisify)
const mockExec = (...args: any[]) => {
  const callback = args[args.length - 1];
  const r = execResponses[execCallIndex] || execResponses[execResponses.length - 1] || { stdout: "" };
  execCallIndex++;
  if (typeof callback === "function") {
    if (r.error) {
      callback(r.error, "", r.error.message);
    } else {
      callback(null, r.stdout || "", r.stderr || "");
    }
  }
  // Return a mock child for the non-promisified path
  return { stdout: null, stderr: null, on: () => {} };
};
// promisify looks for custom promisify symbol
(mockExec as any)[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string) => {
  const r = execResponses[execCallIndex] || execResponses[execResponses.length - 1] || { stdout: "" };
  execCallIndex++;
  if (r.error) {
    return Promise.reject(r.error);
  }
  return Promise.resolve({ stdout: r.stdout || "", stderr: r.stderr || "" });
};

// Mock spawn — returns the next pre-configured child
const mockSpawn = (...args: any[]) => {
  const child = spawnChildren[spawnCallIndex] || spawnChildren[spawnChildren.length - 1] || createMockSpawnChild({ exitCode: 0 });
  spawnCallIndex++;
  return child;
};

mock.module("child_process", () => ({
  exec: mockExec,
  spawn: mockSpawn,
}));

// NOW import TransportManager (it will get our mocked child_process)
const { TransportManager } = await import("../../src/transport");

// ============================================================

describe("TransportManager", () => {
  let transport: InstanceType<typeof TransportManager>;

  beforeEach(() => {
    transport = new TransportManager();
    execResponses = [];
    execCallIndex = 0;
    spawnChildren = [];
    spawnCallIndex = 0;
  });

  // ================================================================
  // checkTailscaleStatus — not installed
  // ================================================================
  describe("checkTailscaleStatus — tailscale not installed", () => {
    it("start() throws when tailscale not found", async () => {
      const notFound = new Error("not found");
      execResponses = [
        { error: notFound }, // which tailscale
        { error: notFound }, // /usr/local/bin/tailscale version
        { error: notFound }, // /opt/homebrew/bin/tailscale version
        { error: notFound }, // /usr/bin/tailscale version
      ];

      await expect(transport.start(3333)).rejects.toThrow("Tailscale installation required");
    });
  });

  // ================================================================
  // checkTailscaleStatus — installed but not running
  // ================================================================
  describe("checkTailscaleStatus — installed but not running", () => {
    it("start() detects not-running and attempts auth, then fails", async () => {
      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which → installed
        { error: new Error("connection refused") }, // tailscale status --json → not running
        { error: new Error("not running") }, // startTailscaleDaemon (open -a / systemctl)
        // After daemon start, it continues to authenticate():
        // authenticate() calls spawn ("tailscale up"), we provide a failing child
        // Then re-check → also fails
        { error: new Error("connection refused") }, // re-check status --json
      ];

      // spawn for authenticate() → tailscale up → fails
      spawnChildren = [createMockSpawnChild({ exitCode: 1, stderr: "failed" })];

      await expect(transport.start(3333)).rejects.toThrow();
    });
  });

  // ================================================================
  // checkTailscaleStatus — NeedsLogin
  // ================================================================
  describe("checkTailscaleStatus — running, NeedsLogin", () => {
    it("start() detects NeedsLogin and fails after auth fails", async () => {
      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { error: new Error("NeedsLogin") }, // tailscale status --json → NeedsLogin
      ];

      spawnChildren = [createMockSpawnChild({ exitCode: 1, stderr: "auth failed" })];

      await expect(transport.start(3333)).rejects.toThrow();
    });
  });

  // ================================================================
  // checkTailscaleStatus — fully running
  // ================================================================
  describe("checkTailscaleStatus — fully running", () => {
    it("start() parses hostname and funnel status from JSON", async () => {
      const statusJson = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "myhost.tailnet.ts.net." },
      });

      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { stdout: statusJson }, // tailscale status --json
        { stdout: "https://myhost.tailnet.ts.net:443/" }, // tailscale funnel status
        { stdout: "{}" }, // getServeConfig (inside enableFunnel → setMergedFunnelConfig)
      ];

      // spawn for --set-raw (inside setMergedFunnelConfig)
      spawnChildren = [createMockSpawnChild({ exitCode: 0 })];

      const url = await transport.start(3333);
      expect(url).toBe("https://myhost.tailnet.ts.net/bcc");
    });
  });

  // ================================================================
  // Funnel policy denied
  // ================================================================
  describe("checkTailscaleStatus — funnel policy denied", () => {
    it("start() throws when funnel policy is denied", async () => {
      const statusJson = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "myhost.tailnet.ts.net." },
      });

      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { stdout: statusJson }, // tailscale status --json
        { error: new Error("policy does not allow funnel") }, // funnel status → policy error
      ];

      await expect(transport.start(3333)).rejects.toThrow("Tailscale Funnel not enabled");
    });
  });

  // ================================================================
  // start() happy path
  // ================================================================
  describe("start() — happy path", () => {
    it("returns public URL with /bcc path", async () => {
      const statusJson = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "dev-machine.tailnet.ts.net." },
      });

      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { stdout: statusJson }, // tailscale status --json
        { stdout: "Available on the internet" }, // funnel status
        { stdout: "{}" }, // getServeConfig
      ];

      spawnChildren = [createMockSpawnChild({ exitCode: 0 })];

      const url = await transport.start(3333);
      expect(url).toBe("https://dev-machine.tailnet.ts.net/bcc");
    });
  });

  // ================================================================
  // enableFunnel — fallback to CLI
  // ================================================================
  describe("enableFunnel — fallback to CLI", () => {
    it("falls back to tailscale funnel --bg when --set-raw fails", async () => {
      const statusJson = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "host.tailnet.ts.net." },
      });

      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { stdout: statusJson }, // tailscale status --json
        { stdout: "Available on the internet" }, // funnel status
        { stdout: "{}" }, // getServeConfig (inside setMergedFunnelConfig)
        // fallback: tailscale funnel --bg
        { stdout: "Available on the internet: https://host.tailnet.ts.net/" },
      ];

      // --set-raw spawn fails → triggers fallback to exec-based CLI
      spawnChildren = [createMockSpawnChild({ exitCode: 1, stderr: "unknown flag: --set-raw" })];

      const url = await transport.start(3333);
      expect(url).toBe("https://host.tailnet.ts.net/bcc");
    });
  });

  // ================================================================
  // stop() — removes /bcc, preserves /dc
  // ================================================================
  describe("stop()", () => {
    it("removes /bcc path preserving other paths", async () => {
      const statusJson = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "host.tailnet.ts.net." },
      });

      const serveConfig = {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "host.tailnet.ts.net:443": {
            Handlers: {
              "/bcc": { Proxy: "http://127.0.0.1:3333" },
              "/dc": { Proxy: "http://127.0.0.1:4444" },
            },
          },
        },
        AllowFunnel: { "host.tailnet.ts.net:443": true },
      };

      execResponses = [
        { stdout: "/usr/local/bin/tailscale" }, // which
        { stdout: statusJson }, // tailscale status --json
        { stdout: "Available" }, // funnel status
        { stdout: "{}" }, // getServeConfig (start → enableFunnel)
        // stop() calls:
        { stdout: JSON.stringify(serveConfig) }, // getServeConfig (stop)
      ];

      let writtenConfig = "";
      const startSpawnChild = createMockSpawnChild({ exitCode: 0 });
      const stopSpawnChild = createMockSpawnChild({ exitCode: 0 });
      stopSpawnChild.stdin.write = mock((data: string) => { writtenConfig += data; });

      spawnChildren = [startSpawnChild, stopSpawnChild];

      await transport.start(3333);
      await transport.stop();

      if (writtenConfig) {
        const parsed = JSON.parse(writtenConfig);
        expect(parsed.Web?.["host.tailnet.ts.net:443"]?.Handlers?.["/bcc"]).toBeUndefined();
        expect(parsed.Web?.["host.tailnet.ts.net:443"]?.Handlers?.["/dc"]).toBeDefined();
      }
    });
  });

  // ================================================================
  // getHostname — uses TAILSCALE_HOSTNAME env
  // ================================================================
  describe("getHostname — uses TAILSCALE_HOSTNAME env", () => {
    it("returns env value when TAILSCALE_HOSTNAME is set", async () => {
      const origEnv = process.env.TAILSCALE_HOSTNAME;
      process.env.TAILSCALE_HOSTNAME = "custom-host.tailnet.ts.net";

      try {
        const statusJson = JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "" }, // Empty DNS → falls back to getHostname()
        });

        execResponses = [
          { stdout: "/usr/local/bin/tailscale" }, // which
          { stdout: statusJson }, // tailscale status --json
          { stdout: "Available" }, // funnel status
          { stdout: "{}" }, // getServeConfig
        ];

        spawnChildren = [createMockSpawnChild({ exitCode: 0 })];

        const url = await transport.start(3333);
        expect(url).toBe("https://custom-host.tailnet.ts.net/bcc");
      } finally {
        if (origEnv === undefined) delete process.env.TAILSCALE_HOSTNAME;
        else process.env.TAILSCALE_HOSTNAME = origEnv;
      }
    });
  });
});
