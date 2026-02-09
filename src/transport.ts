/**
 * Transport Layer - Tailscale Funnel
 * Provides public URLs via Tailscale Funnel (free, unlimited tunnels)
 * Includes guided setup when prerequisites are missing
 */

import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  authenticated: boolean;
  funnelEnabled: boolean;
  hostname?: string;
  error?: string;
}

/**
 * Transport Manager
 * Uses Tailscale Funnel for public webhook access
 */
export class TransportManager {
  private publicUrl: string = "";
  private hostname: string = "";
  private port: number = 0;

  async start(port: number): Promise<string> {
    console.log("[Tailscale] Checking setup...");

    // Check all prerequisites and provide guidance
    const status = await this.checkTailscaleStatus();

    if (!status.installed) {
      await this.guidedInstall();
      throw new Error("Tailscale installation required - see instructions above");
    }

    if (!status.running) {
      console.log("[Tailscale] Tailscale daemon not running, attempting to start...");
      await this.startTailscaleDaemon();
    }

    if (!status.authenticated) {
      console.log("[Tailscale] Not authenticated, starting login...");
      await this.authenticate();
      // Re-check status after auth
      const newStatus = await this.checkTailscaleStatus();
      if (!newStatus.authenticated) {
        throw new Error("Tailscale authentication required - please complete the login in your browser");
      }
    }

    // Get hostname
    this.hostname = status.hostname || await this.getHostname();
    console.log(`[Tailscale] Hostname: ${this.hostname}`);

    // Check if funnel is enabled
    if (!status.funnelEnabled) {
      this.printFunnelInstructions();
      throw new Error("Tailscale Funnel not enabled - see instructions above");
    }

    // Start funnel
    this.port = port;
    console.log("[Tailscale] Starting Funnel...");
    await this.enableFunnel(port);

    this.publicUrl = `https://${this.hostname}/bcc`;
    console.log(`[Tailscale] Funnel active: ${this.publicUrl}`);
    return this.publicUrl;
  }

  private async checkTailscaleStatus(): Promise<TailscaleStatus> {
    const status: TailscaleStatus = {
      installed: false,
      running: false,
      authenticated: false,
      funnelEnabled: false,
    };

    // Check if tailscale is installed
    try {
      await execAsync("which tailscale");
      status.installed = true;
    } catch {
      // Try common installation paths
      const paths = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"];
      for (const path of paths) {
        try {
          await execAsync(`${path} version`);
          status.installed = true;
          break;
        } catch {
          continue;
        }
      }
      if (!status.installed) {
        return status;
      }
    }

    // Check if tailscale is running and get status
    try {
      const { stdout } = await execAsync("tailscale status --json");
      const tsStatus = JSON.parse(stdout);

      status.running = true;
      status.authenticated = tsStatus.BackendState === "Running";
      status.hostname = tsStatus.Self?.DNSName?.replace(/\.$/, "");

      // Check funnel capability
      if (status.authenticated) {
        try {
          const { stdout: funnelOut } = await execAsync("tailscale funnel status 2>&1");
          // If we get output without "error" or "not enabled", funnel is available
          status.funnelEnabled = !funnelOut.toLowerCase().includes("not enabled") &&
                                  !funnelOut.toLowerCase().includes("funnel is not available") &&
                                  !funnelOut.toLowerCase().includes("policy does not allow");
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          // Parse error to determine if it's a policy issue
          if (errorMsg.includes("policy") || errorMsg.includes("not enabled") || errorMsg.includes("not available")) {
            status.funnelEnabled = false;
          } else {
            // Other errors might mean funnel is enabled but no active funnels
            status.funnelEnabled = true;
          }
        }
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);

      if (errorMsg.includes("not running") || errorMsg.includes("connection refused")) {
        status.running = false;
      } else if (errorMsg.includes("NeedsLogin") || errorMsg.includes("Logged out")) {
        status.running = true;
        status.authenticated = false;
      } else {
        status.error = errorMsg;
      }
    }

    return status;
  }

  private async guidedInstall(): Promise<void> {
    const platform = process.platform;

    console.log("\n" + "=".repeat(60));
    console.log("  TAILSCALE INSTALLATION REQUIRED");
    console.log("=".repeat(60));
    console.log("\nTailscale provides free, stable public URLs for webhooks.\n");

    if (platform === "darwin") {
      console.log("Install on macOS:");
      console.log("  brew install tailscale");
      console.log("\nOr download from: https://tailscale.com/download/mac");
    } else if (platform === "linux") {
      console.log("Install on Linux:");
      console.log("  curl -fsSL https://tailscale.com/install.sh | sh");
      console.log("\nOr see: https://tailscale.com/download/linux");
    } else if (platform === "win32") {
      console.log("Install on Windows:");
      console.log("  Download from: https://tailscale.com/download/windows");
    } else {
      console.log("Download Tailscale from: https://tailscale.com/download");
    }

    console.log("\nAfter installation, restart this server.");
    console.log("=".repeat(60) + "\n");
  }

  private async startTailscaleDaemon(): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === "darwin") {
        // On macOS, open the Tailscale app
        console.log("[Tailscale] Opening Tailscale app...");
        await execAsync("open -a Tailscale");
        // Wait for daemon to start
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else if (platform === "linux") {
        console.log("[Tailscale] Starting tailscaled service...");
        await execAsync("sudo systemctl start tailscaled");
      }
    } catch (e) {
      console.log("[Tailscale] Could not auto-start daemon.");
      console.log("  macOS: Open the Tailscale app from Applications");
      console.log("  Linux: sudo systemctl start tailscaled");
    }
  }

  private async authenticate(): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("  TAILSCALE AUTHENTICATION");
    console.log("=".repeat(60));
    console.log("\nOpening browser for Tailscale login...\n");

    try {
      // tailscale up will open browser for authentication
      const child = spawn("tailscale", ["up"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Capture output for any auth URLs
      child.stdout?.on("data", (data) => {
        const output = data.toString();
        console.log(output);
      });

      child.stderr?.on("data", (data) => {
        const output = data.toString();
        if (output.includes("https://")) {
          console.log("\nPlease visit this URL to authenticate:");
          console.log(output);
        }
      });

      // Wait for auth to complete (with timeout)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Authentication timeout - please run 'tailscale up' manually"));
        }, 120000); // 2 minute timeout

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            console.log("[Tailscale] Authentication successful!");
            resolve();
          } else {
            reject(new Error(`Authentication failed with code ${code}`));
          }
        });
      });
    } catch (e) {
      console.log("\n[Tailscale] Please authenticate manually:");
      console.log("  Run: tailscale up");
      throw e;
    }
  }

  private printFunnelInstructions(): void {
    console.log("\n" + "=".repeat(60));
    console.log("  TAILSCALE FUNNEL SETUP REQUIRED");
    console.log("=".repeat(60));
    console.log("\nFunnel needs to be enabled in your Tailscale admin console.");
    console.log("\n1. Go to: https://login.tailscale.com/admin/acls");
    console.log("\n2. Add this to your ACL policy (in the JSON editor):");
    console.log(`
   "nodeAttrs": [
     {
       "target": ["autogroup:member"],
       "attr": ["funnel"]
     }
   ]
`);
    console.log("3. Save the policy and restart this server.");
    console.log("\nAlternatively, use the policy file template at:");
    console.log("  https://tailscale.com/kb/1223/funnel#prerequisites");
    console.log("=".repeat(60) + "\n");
  }

  private async getHostname(): Promise<string> {
    const envHostname = process.env.TAILSCALE_HOSTNAME;
    if (envHostname) {
      console.log("[Tailscale] Using hostname from TAILSCALE_HOSTNAME env");
      return envHostname;
    }

    const { stdout } = await execAsync("tailscale status --json");
    const status = JSON.parse(stdout);
    const hostname = status.Self?.DNSName?.replace(/\.$/, "");

    if (!hostname) {
      throw new Error("Could not determine Tailscale hostname");
    }

    return hostname;
  }

  /**
   * Read current serve config to avoid overwriting other paths (e.g. /dc from dear-claude).
   */
  private async getServeConfig(): Promise<Record<string, any> | null> {
    try {
      const { stdout } = await execAsync("tailscale serve status --json 2>/dev/null");
      const config = JSON.parse(stdout);
      if (!config || Object.keys(config).length === 0) return null;
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Set serve config by merging our /bcc path into existing config,
   * preserving other paths (e.g. /dc from dear-claude).
   */
  private async setMergedFunnelConfig(port: number): Promise<void> {
    const hostPort = `${this.hostname}:443`;
    const existing = await this.getServeConfig() || {};

    // Merge TCP
    const tcp = existing.TCP || {};
    tcp["443"] = { HTTPS: true };

    // Merge Web handlers — preserve existing paths, add/update /bcc
    const web = existing.Web || {};
    const handlers = web[hostPort]?.Handlers || {};
    handlers["/bcc"] = { Proxy: `http://127.0.0.1:${port}` };
    web[hostPort] = { Handlers: handlers };

    // Merge AllowFunnel
    const allowFunnel = existing.AllowFunnel || {};
    allowFunnel[hostPort] = true;

    const merged = { ...existing, TCP: tcp, Web: web, AllowFunnel: allowFunnel };

    // Write config atomically via stdin
    const configJson = JSON.stringify(merged);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tailscale", ["serve", "--set-raw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tailscale serve --set-raw failed (${code}): ${stderr}`));
      });
      child.on("error", reject);
      child.stdin?.write(configJson);
      child.stdin?.end();
    });
  }

  private async enableFunnel(port: number): Promise<void> {
    try {
      // Try merge-aware config first (preserves other paths like /dc)
      try {
        await this.setMergedFunnelConfig(port);
        console.log("[Tailscale Funnel] Config merged — /bcc path set, other paths preserved");
        return;
      } catch (mergeErr) {
        // --set-raw may not be available on older Tailscale versions; fall back to CLI
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        console.log(`[Tailscale] Merge-aware config failed (${msg}), falling back to CLI...`);
      }

      // Fallback: use --bg --set-path (may overwrite other paths on buggy versions)
      const { stdout, stderr } = await execAsync(`tailscale funnel --bg --set-path=/bcc ${port} 2>&1`);
      const output = stdout + stderr;

      if (output.includes("error") && !output.includes("Available on the internet")) {
        throw new Error(output);
      }

      console.log(`[Tailscale Funnel] ${output.trim()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("not enabled") || message.includes("policy")) {
        this.printFunnelInstructions();
        throw new Error("Tailscale Funnel not enabled on your tailnet");
      }

      throw new Error(`Failed to start Tailscale Funnel: ${message}`);
    }
  }

  /**
   * Remove only our /bcc path, preserving other paths (e.g. /dc).
   */
  async stop(): Promise<void> {
    if (this.port) {
      console.log("[Tailscale] Removing /bcc path...");
      try {
        const existing = await this.getServeConfig();
        if (existing) {
          const hostPort = `${this.hostname}:443`;
          const handlers = existing.Web?.[hostPort]?.Handlers;
          if (handlers && handlers["/bcc"]) {
            delete handlers["/bcc"];
            // If no handlers left, remove the entire Web entry
            if (Object.keys(handlers).length === 0) {
              delete existing.Web[hostPort];
              if (Object.keys(existing.Web).length === 0) delete existing.Web;
              delete existing.AllowFunnel?.[hostPort];
              if (existing.AllowFunnel && Object.keys(existing.AllowFunnel).length === 0) delete existing.AllowFunnel;
              delete existing.TCP?.["443"];
              if (existing.TCP && Object.keys(existing.TCP).length === 0) delete existing.TCP;
            }
            // Write back
            const configJson = JSON.stringify(existing);
            await new Promise<void>((resolve) => {
              const child = spawn("tailscale", ["serve", "--set-raw"], { stdio: ["pipe", "ignore", "ignore"] });
              child.on("close", () => resolve());
              child.stdin?.write(configJson);
              child.stdin?.end();
            });
          }
        }
      } catch {
        // Ignore errors on cleanup
      }
      this.port = 0;
    }
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }
}
