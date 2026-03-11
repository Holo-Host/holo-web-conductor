/**
 * Environment Manager
 *
 * Wraps the e2e-test-setup.sh script for programmatic control of the test environment.
 */

import { spawn, ChildProcess } from 'child_process';
import { readFile, access, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EnvConfig, EnvState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Navigate from packages/e2e/src to project root
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
// Use /tmp for sandbox to avoid Unix socket path length limits (SUN_LEN ~108 chars)
const SANDBOX_DIR = '/tmp/hwc-e2e';
const SETUP_SCRIPT = join(PROJECT_ROOT, 'scripts', 'e2e-test-setup.sh');

export class EnvironmentManager {
  private config: EnvConfig;

  constructor(config: Partial<EnvConfig> = {}) {
    this.config = {
      happ: config.happ ?? 'ziptest',
    };
  }

  /**
   * Start the test environment (conductors + linker).
   *
   * Idempotent: if the environment is already running with the requested hApp,
   * this is a no-op. If it's running with a different hApp, it stops first
   * and restarts with the correct one.
   */
  async start(config?: Partial<EnvConfig>): Promise<EnvState> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Check if environment is already running with the correct hApp
    const currentState = await this.getStatus();
    if (currentState.running) {
      if (currentState.appId === this.config.happ) {
        console.log(`Environment already running with hApp: ${this.config.happ}`);
        return currentState;
      }
      console.log(`Environment running with hApp '${currentState.appId}', need '${this.config.happ}' — restarting...`);
      await this.stop();
    }

    console.log(`Starting environment with hApp: ${this.config.happ}`);
    await this.runScript('start', [`--happ=${this.config.happ}`]);

    // Read state from sandbox files
    return this.getStatus();
  }

  /**
   * Stop all services
   */
  async stop(): Promise<void> {
    console.log('Stopping environment...');
    await this.runScript('stop');
  }

  /**
   * Clean up sandbox data
   */
  async clean(): Promise<void> {
    console.log('Cleaning environment...');
    await this.runScript('clean');
  }

  /**
   * Pause the linker (conductors keep running)
   */
  async pauseLinker(): Promise<void> {
    console.log('Pausing linker...');
    await this.runScript('pause');
  }

  /**
   * Unpause the linker (restart it while conductors are running)
   */
  async unpauseLinker(): Promise<void> {
    console.log('Unpausing linker...');
    await this.runScript('unpause', [`--happ=${this.config.happ}`]);
  }

  /**
   * Get current environment status by reading state files
   */
  async getStatus(): Promise<EnvState> {
    const state: EnvState = {
      running: false,
      adminPorts: [],
    };

    try {
      // Check if sandbox directory exists
      await access(SANDBOX_DIR);
    } catch {
      return state;
    }

    // Check bootstrap address
    try {
      const bootstrapAddr = await readFile(join(SANDBOX_DIR, 'bootstrap_addr.txt'), 'utf-8');
      state.bootstrapAddr = bootstrapAddr.trim();
    } catch {
      // Bootstrap not running
    }

    // Check admin ports
    try {
      const files = await readdir(SANDBOX_DIR);
      for (const file of files) {
        if (file.startsWith('admin_port') && file.endsWith('.txt')) {
          const port = await readFile(join(SANDBOX_DIR, file), 'utf-8');
          state.adminPorts.push(parseInt(port.trim(), 10));
        }
      }
    } catch {
      // No admin ports
    }

    // Check DNA hash
    try {
      const dnaHash = await readFile(join(SANDBOX_DIR, 'dna_hash.txt'), 'utf-8');
      state.dnaHash = dnaHash.trim();
    } catch {
      // No DNA hash
    }

    // Check app ID
    try {
      const appId = await readFile(join(SANDBOX_DIR, 'app_id.txt'), 'utf-8');
      state.appId = appId.trim();
    } catch {
      // No app ID
    }

    // Linker is on port 8000 by default
    state.linkerPort = 8000;

    // Check if services are running by checking PID files
    const running = await this.checkProcessesRunning();
    state.running = running;

    return state;
  }

  /**
   * Check if the test environment processes are running
   */
  private async checkProcessesRunning(): Promise<boolean> {
    try {
      // Check conductor PID
      const conductorPid = await readFile(join(SANDBOX_DIR, 'conductor.pid'), 'utf-8');
      const pid = parseInt(conductorPid.trim(), 10);

      // Check if process exists
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Run the setup script with the given command and arguments
   */
  private runScript(command: string, args: string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const fullArgs = [command, ...args];
      console.log(`Running: ${SETUP_SCRIPT} ${fullArgs.join(' ')}`);

      const proc = spawn(SETUP_SCRIPT, fullArgs, {
        cwd: PROJECT_ROOT,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        // Stream output to console
        process.stdout.write(text);
      });

      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(text);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Script exited with code ${code}\n${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Get path to the sandbox directory
   */
  getSandboxDir(): string {
    return SANDBOX_DIR;
  }

  /**
   * Get path to a specific log file
   */
  getLogPath(name: 'linker' | 'conductor' | 'bootstrap'): string {
    const logFiles: Record<string, string> = {
      linker: 'linker.log',
      conductor: 'sandbox-generate.log',
      bootstrap: 'bootstrap.log',
    };
    return join(SANDBOX_DIR, logFiles[name]);
  }

  /**
   * Get the linker URL for the current environment
   */
  getLinkerUrl(): string {
    // Both linkers use port 8000 (configured in e2e-test-setup.sh)
    return 'http://localhost:8000';
  }
}

// Export singleton for convenience
export const env = new EnvironmentManager();
