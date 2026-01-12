/**
 * Transport Layer
 * Manages ngrok or Tailscale tunnels for webhook access
 */

import ngrok from "@ngrok/ngrok";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type TransportType = "ngrok" | "tailscale";

export interface TransportConfig {
  transport: TransportType;
  port: number;
  // ngrok
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
  // Tailscale
  tailscaleHostname?: string;
  tailscaleUseFunnel?: boolean;
  tailscaleFunnelPort?: number;
}

interface Transport {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
  getPublicUrl(): string;
}

/**
 * ngrok Transport
 * Creates a public URL using ngrok tunneling service
 */
class NgrokTransport implements Transport {
  private listener: ngrok.Listener | null = null;
  private publicUrl: string = "";

  constructor(private config: TransportConfig) {}

  async start(port: number): Promise<string> {
    console.log("[ngrok] Starting tunnel...");

    // Configure ngrok
    const options: ngrok.Config = {
      authtoken: this.config.ngrokAuthtoken,
      addr: port,
    };

    // Use custom domain if provided (paid feature)
    if (this.config.ngrokDomain) {
      options.domain = this.config.ngrokDomain;
      console.log(`[ngrok] Using custom domain: ${this.config.ngrokDomain}`);
    }

    try {
      this.listener = await ngrok.forward(options);
      this.publicUrl = this.listener.url() || "";

      console.log(`[ngrok] Tunnel established: ${this.publicUrl}`);
      return this.publicUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start ngrok tunnel: ${message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.listener) {
      console.log("[ngrok] Closing tunnel...");
      await this.listener.close();
      this.listener = null;
    }
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }
}

/**
 * Tailscale Transport
 * Uses Tailscale Funnel for public access or MagicDNS for private network access
 */
class TailscaleTransport implements Transport {
  private publicUrl: string = "";
  private funnelProcess: ChildProcess | null = null;

  constructor(private config: TransportConfig) {}

  async start(port: number): Promise<string> {
    console.log("[tailscale] Configuring transport...");

    // Get Tailscale hostname
    let hostname = this.config.tailscaleHostname;

    if (!hostname) {
      // Auto-detect hostname from tailscale status
      try {
        const { stdout } = await execAsync("tailscale status --json");
        const status = JSON.parse(stdout);
        hostname = status.Self?.DNSName?.replace(/\.$/, "") || "";
        console.log(`[tailscale] Auto-detected hostname: ${hostname}`);
      } catch (error) {
        throw new Error(
          "Failed to detect Tailscale hostname. Ensure Tailscale is running or set BETTERCALLCLAUDE_TAILSCALE_HOSTNAME"
        );
      }
    }

    if (!hostname) {
      throw new Error("Could not determine Tailscale hostname");
    }

    if (this.config.tailscaleUseFunnel) {
      // Use Tailscale Funnel for public access
      this.publicUrl = await this.startFunnel(port, hostname);
    } else {
      // Use MagicDNS for private network access
      // Note: This only works if your phone provider can reach your Tailscale network
      this.publicUrl = `https://${hostname}:${port}`;
      console.log(`[tailscale] Using MagicDNS: ${this.publicUrl}`);
      console.log(
        "[tailscale] Warning: Phone provider webhooks may not reach private Tailscale URLs. Consider using Funnel."
      );
    }

    return this.publicUrl;
  }

  private async startFunnel(port: number, hostname: string): Promise<string> {
    console.log("[tailscale] Starting Funnel...");

    const funnelPort = this.config.tailscaleFunnelPort || 443;

    // Check if funnel is available
    try {
      await execAsync("tailscale funnel status");
    } catch (error) {
      throw new Error(
        "Tailscale Funnel is not available. Please enable it in your Tailscale admin console and run: tailscale funnel <port>"
      );
    }

    // Start funnel in background
    // tailscale funnel <local_port> creates https://<hostname>:<funnel_port> -> localhost:<local_port>
    return new Promise((resolve, reject) => {
      this.funnelProcess = spawn("tailscale", ["funnel", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let startupOutput = "";

      this.funnelProcess.stdout?.on("data", (data) => {
        startupOutput += data.toString();
        console.log(`[tailscale funnel] ${data.toString().trim()}`);
      });

      this.funnelProcess.stderr?.on("data", (data) => {
        startupOutput += data.toString();
        console.error(`[tailscale funnel] ${data.toString().trim()}`);
      });

      this.funnelProcess.on("error", (error) => {
        reject(new Error(`Failed to start Tailscale Funnel: ${error.message}`));
      });

      // Give it a moment to start
      setTimeout(() => {
        if (this.funnelProcess && !this.funnelProcess.killed) {
          const url =
            funnelPort === 443
              ? `https://${hostname}`
              : `https://${hostname}:${funnelPort}`;
          console.log(`[tailscale] Funnel established: ${url}`);
          resolve(url);
        } else {
          reject(new Error(`Tailscale Funnel failed to start: ${startupOutput}`));
        }
      }, 2000);
    });
  }

  async stop(): Promise<void> {
    if (this.funnelProcess) {
      console.log("[tailscale] Stopping Funnel...");
      this.funnelProcess.kill("SIGTERM");
      this.funnelProcess = null;
    }
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }
}

/**
 * Transport Manager
 * Factory for creating and managing transport instances
 */
export class TransportManager {
  private transport: Transport;

  constructor(config: TransportConfig) {
    switch (config.transport) {
      case "ngrok":
        this.transport = new NgrokTransport(config);
        break;
      case "tailscale":
        this.transport = new TailscaleTransport(config);
        break;
      default:
        throw new Error(`Unknown transport type: ${config.transport}`);
    }
  }

  async start(port: number): Promise<string> {
    return this.transport.start(port);
  }

  async stop(): Promise<void> {
    return this.transport.stop();
  }

  getPublicUrl(): string {
    return this.transport.getPublicUrl();
  }
}
