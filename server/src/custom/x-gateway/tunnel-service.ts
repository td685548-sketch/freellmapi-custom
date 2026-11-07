import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../lib/config.js';

export type TunnelState = 'stopped' | 'starting' | 'active' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  port: number;
  startedAt: number | null;
  uptimeSeconds: number;
  cloudflaredInstalled: boolean;
  cloudflaredPath: string | null;
  error: string | null;
  logTail: string[];
  metrics: {
    reconnectCount: number;
  };
}

const MAX_LOG_LINES = 100;
const TRY_CLOUDFLARE_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class QuickTunnelService {
  private state: TunnelState = 'stopped';
  private url: string | null = null;
  private port = 3001;
  private startedAt: number | null = null;
  private process: ChildProcess | null = null;
  private error: string | null = null;
  private logs: string[] = [];
  private reconnectCount = 0;
  private cachedPath: { checked: boolean; path: string | null } = { checked: false, path: null };

  constructor() {
    // Ensure child process is killed on Node process exit
    const cleanup = () => {
      this.stop();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }

  /** Locate the cloudflared executable on the host system */
  public findCloudflaredBinary(): string | null {
    if (this.cachedPath.checked) return this.cachedPath.path;

    if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) {
      this.cachedPath = { checked: true, path: process.env.CLOUDFLARED_PATH };
      return this.cachedPath.path;
    }

    // Try finding via `where` on Windows or `which` on Unix
    const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const out = execFileSync(lookupCmd, ['cloudflared'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const firstLine = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (firstLine && fs.existsSync(firstLine)) {
        this.cachedPath = { checked: true, path: firstLine };
        return firstLine;
      }
    } catch {
      // not found in PATH via tool, fall back to known paths
    }

    // Check standard OS paths
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      const localAppData = process.env['LOCALAPPDATA'] || '';
      candidates.push(
        path.join(progFiles, 'cloudflared', 'cloudflared.exe'),
        'C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe',
        path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
      );
    } else {
      candidates.push(
        '/usr/local/bin/cloudflared',
        '/usr/bin/cloudflared',
        '/opt/homebrew/bin/cloudflared',
        '/snap/bin/cloudflared'
      );
    }

    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        this.cachedPath = { checked: true, path: c };
        return c;
      }
    }

    this.cachedPath = { checked: true, path: null };
    return null;
  }

  public isInstalled(): boolean {
    if (process.env.CLOUDFLARED_MOCK === 'true') return true;
    return Boolean(this.findCloudflaredBinary());
  }

  public getStatus(): TunnelStatus {
    const now = Date.now();
    const uptimeSeconds = this.startedAt && this.state === 'active'
      ? Math.floor((now - this.startedAt) / 1000)
      : 0;

    return {
      state: this.state,
      url: this.url,
      port: this.port,
      startedAt: this.startedAt,
      uptimeSeconds,
      cloudflaredInstalled: this.isInstalled(),
      cloudflaredPath: this.findCloudflaredBinary(),
      error: this.error,
      logTail: [...this.logs],
      metrics: {
        reconnectCount: this.reconnectCount,
      },
    };
  }

  public getLogs(): string[] {
    return [...this.logs];
  }

  private appendLog(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    const line = `[${timestamp}] ${message.trim()}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.shift();
    }
  }

  public async start(customPort?: number): Promise<TunnelStatus> {
    if (this.state === 'active' || this.state === 'starting') {
      return this.getStatus();
    }

    this.port = customPort || Number(loadConfig().port) || 3001;
    this.error = null;
    this.url = null;
    this.state = 'starting';
    this.appendLog(`Starting Cloudflare Quick Tunnel for port ${this.port}...`);

    // Mock Mode for automated tests or environments without cloudflared
    if (process.env.CLOUDFLARED_MOCK === 'true') {
      this.startedAt = Date.now();
      this.url = `https://mock-${Date.now().toString(36)}.trycloudflare.com`;
      this.state = 'active';
      this.appendLog(`[MOCK] Assigned quick tunnel URL: ${this.url}`);
      return this.getStatus();
    }

    const binary = this.findCloudflaredBinary();
    if (!binary) {
      this.state = 'error';
      this.error = 'cloudflared executable was not found on this system.';
      this.appendLog('Error: cloudflared binary not found in PATH or standard installation locations.');
      return this.getStatus();
    }

    try {
      const args = ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate'];
      this.appendLog(`Spawning: ${binary} ${args.join(' ')}`);

      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.process = child;

      const handleData = (data: Buffer) => {
        const text = data.toString('utf-8');
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          this.appendLog(line);

          // Look for trycloudflare.com URL
          if (!this.url) {
            const match = line.match(TRY_CLOUDFLARE_REGEX);
            if (match) {
              this.url = match[0];
              this.state = 'active';
              this.startedAt = Date.now();
              this.appendLog(`Tunnel established! Public URL: ${this.url}`);
            }
          }

          if (line.includes('Retrying connection') || line.includes('Re-connecting')) {
            this.reconnectCount++;
          }
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);

      child.on('error', (err) => {
        this.state = 'error';
        this.error = err.message;
        this.appendLog(`Process error: ${err.message}`);
        this.process = null;
      });

      child.on('exit', (code, signal) => {
        this.appendLog(`cloudflared exited with code ${code ?? signal ?? 'unknown'}`);
        if (this.state === 'active' || this.state === 'starting') {
          this.state = 'stopped';
          this.url = null;
          this.startedAt = null;
        }
        this.process = null;
      });

      // Give it up to 15 seconds to establish tunnel before returning
      const startWait = Date.now();
      while (this.state === 'starting' && Date.now() - startWait < 5000) {
        await new Promise((r) => setTimeout(r, 200));
      }

      return this.getStatus();
    } catch (err: unknown) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.appendLog(`Failed to spawn cloudflared: ${this.error}`);
      return this.getStatus();
    }
  }

  public stop(): TunnelStatus {
    if (this.process) {
      this.appendLog('Stopping Cloudflare Quick Tunnel...');
      try {
        if (process.platform === 'win32') {
          // On Windows, taskkill is more reliable for killing process tree
          try {
            if (this.process.pid) {
              execFileSync('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], {
                stdio: 'ignore',
                timeout: 3000,
              });
            }
          } catch {
            this.process.kill('SIGTERM');
          }
        } else {
          this.process.kill('SIGINT');
          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.process.kill('SIGKILL');
            }
          }, 1500);
        }
      } catch (e: unknown) {
        this.appendLog(`Error terminating process: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.process = null;
    }

    this.state = 'stopped';
    this.url = null;
    this.startedAt = null;
    this.appendLog('Tunnel stopped.');
    return this.getStatus();
  }

  /** Reset internal state for test isolation */
  public resetForTesting(): void {
    this.stop();
    this.logs = [];
    this.error = null;
    this.reconnectCount = 0;
    this.cachedPath = { checked: false, path: null };
  }
}

export const tunnelService = new QuickTunnelService();
