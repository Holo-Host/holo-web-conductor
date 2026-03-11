/**
 * Test Runner
 *
 * Orchestrates test execution with environment setup and log collection.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EnvironmentManager } from './environment.js';
import { LogCollector } from './log-collector.js';
import type { E2EResults, EnvConfig, TestResult, LogEntry } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const E2E_PACKAGE = join(__dirname, '..');

export interface TestRunnerOptions {
  /** Environment configuration */
  envConfig?: Partial<EnvConfig>;
  /** Whether to clean the environment before starting */
  clean?: boolean;
  /** Test file pattern to match */
  pattern?: string;
  /** Playwright project to run (e.g., 'chromium-extension', 'cross-browser') */
  project?: string;
  /** Specific test file to run (e.g., 'tests/cross-browser.test.ts') */
  testFile?: string;
  /** Output format */
  outputFormat?: 'json' | 'pretty';
  /** Whether to collect logs from environment */
  collectLogs?: boolean;
  /** Whether to run in headed mode (visible browser) */
  headed?: boolean;
}

export class TestRunner {
  private env: EnvironmentManager;
  private logCollector: LogCollector;

  constructor() {
    this.env = new EnvironmentManager();
    this.logCollector = new LogCollector();
  }

  /**
   * Run e2e tests with full orchestration
   */
  async run(options: TestRunnerOptions = {}): Promise<E2EResults> {
    const startTime = new Date();
    const results: E2EResults = {
      timestamp: startTime.toISOString(),
      environment: {
        happ: options.envConfig?.happ ?? 'ziptest',
        linkerUrl: 'http://localhost:8000',
      },
      results: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        tests: [],
      },
      logs: {
        extension: [],
        linker: [],
        conductor: [],
        bootstrap: [],
      },
    };

    try {
      // Clean if requested
      if (options.clean) {
        console.log('Cleaning environment...');
        await this.env.clean();
      }

      // Start environment
      console.log('Starting test environment...');
      const envState = await this.env.start(options.envConfig);

      results.environment.dnaHash = envState.dnaHash;
      results.environment.linkerUrl = this.env.getLinkerUrl();

      // Attach log collectors if requested
      if (options.collectLogs !== false) {
        console.log('Attaching log collectors...');
        await this.attachLogCollectors();
      }

      // Run Playwright tests
      console.log('Running tests...');
      const testResults = await this.runPlaywrightTests(options);
      results.results = testResults;

      // Collect logs
      if (options.collectLogs !== false) {
        results.logs = {
          extension: this.logCollector.getLogs({ source: 'extension' }),
          linker: this.logCollector.getLogs({ source: 'linker' }),
          conductor: this.logCollector.getLogs({ source: 'conductor' }),
          bootstrap: this.logCollector.getLogs({ source: 'bootstrap' }),
        };
      }
    } catch (err) {
      console.error('Test run failed:', err);
      results.results.tests.push({
        name: 'Test Runner',
        status: 'fail',
        duration: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      results.results.failed++;
      results.results.total++;
    } finally {
      // Stop log collection
      this.logCollector.stop();
    }

    return results;
  }

  /**
   * Attach log collectors to environment log files
   */
  private async attachLogCollectors(): Promise<void> {
    await this.logCollector.attachFileLog('linker', this.env.getLogPath('linker'));
    await this.logCollector.attachFileLog('conductor', this.env.getLogPath('conductor'));
    await this.logCollector.attachFileLog('bootstrap', this.env.getLogPath('bootstrap'));
  }

  /**
   * Run Playwright tests and parse results
   */
  private async runPlaywrightTests(
    options: TestRunnerOptions
  ): Promise<E2EResults['results']> {
    return new Promise((resolve) => {
      // Test file must come immediately after 'playwright test' (positional arg),
      // before any --options, otherwise Playwright misparses it.
      const args = ['playwright', 'test', '--config=playwright.config.cjs'];

      if (options.testFile) {
        args.push(options.testFile);
      }

      args.push('--reporter=json');

      if (options.project) {
        args.push('--project', options.project);
      }

      if (options.pattern) {
        args.push('--grep', options.pattern);
      }

      if (options.headed) {
        args.push('--headed');
      }

      const proc = spawn('npx', args, {
        cwd: E2E_PACKAGE,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LINKER_URL: this.env.getLinkerUrl(),
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
        // Also print errors to console
        process.stderr.write(data);
      });

      proc.on('close', (code) => {
        const results: E2EResults['results'] = {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          tests: [],
        };

        try {
          // Parse Playwright JSON output
          const report = JSON.parse(stdout);

          for (const suite of report.suites || []) {
            this.parseSuite(suite, results);
          }
        } catch {
          // If we can't parse the output, create a summary result
          if (code === 0) {
            results.tests.push({
              name: 'All tests',
              status: 'pass',
              duration: 0,
            });
            results.passed = 1;
            results.total = 1;
          } else {
            results.tests.push({
              name: 'Test execution',
              status: 'fail',
              duration: 0,
              error: stderr || 'Tests failed with no output',
            });
            results.failed = 1;
            results.total = 1;
          }
        }

        resolve(results);
      });
    });
  }

  /**
   * Parse a Playwright test suite recursively
   */
  private parseSuite(suite: any, results: E2EResults['results']): void {
    // Parse specs in this suite
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const result: TestResult = {
          name: `${suite.title} > ${spec.title}`,
          status: test.status === 'passed' ? 'pass' : test.status === 'skipped' ? 'skip' : 'fail',
          duration: test.results?.[0]?.duration ?? 0,
        };

        if (result.status === 'fail' && test.results?.[0]?.error) {
          result.error = test.results[0].error.message;
        }

        results.tests.push(result);
        results.total++;

        switch (result.status) {
          case 'pass':
            results.passed++;
            break;
          case 'fail':
            results.failed++;
            break;
          case 'skip':
            results.skipped++;
            break;
        }
      }
    }

    // Parse nested suites
    for (const childSuite of suite.suites || []) {
      this.parseSuite(childSuite, results);
    }
  }

  /**
   * Format results for terminal output
   */
  formatPretty(results: E2EResults): string {
    const lines: string[] = [
      '',
      'HWC E2E Test Runner',
      '=====================',
      `Environment: ${results.environment.happ} | Linker: ${results.environment.linkerUrl}`,
      '',
    ];

    // Test results
    for (const test of results.results.tests) {
      const icon = test.status === 'pass' ? '\x1b[32m✓\x1b[0m' : test.status === 'skip' ? '\x1b[33m○\x1b[0m' : '\x1b[31m✗\x1b[0m';
      lines.push(`  ${icon} ${test.name} (${test.duration}ms)`);
    }

    lines.push('');
    lines.push(
      `Results: ${results.results.passed}/${results.results.total} passed${
        results.results.skipped > 0 ? `, ${results.results.skipped} skipped` : ''
      }`
    );

    // Failed test details
    const failed = results.results.tests.filter((t) => t.status === 'fail');
    if (failed.length > 0) {
      lines.push('');
      lines.push('Failures:');
      for (const test of failed) {
        lines.push(`  ${test.name}`);
        if (test.error) {
          lines.push(`    Error: ${test.error}`);
        }
        // Show relevant logs
        if (test.logs && test.logs.length > 0) {
          lines.push('    Logs:');
          for (const log of test.logs.slice(-5)) {
            lines.push(`      [${log.source}] ${log.timestamp.toISOString().split('T')[1].slice(0, 8)} ${log.message.slice(0, 100)}`);
          }
        }
      }
    }

    // Log summary
    const logStats = this.logCollector.getStats();
    if (Object.keys(logStats).length > 0) {
      lines.push('');
      lines.push('Log Summary:');
      for (const [source, stats] of Object.entries(logStats)) {
        const errors = stats.errors > 0 ? `\x1b[31m${stats.errors} errors\x1b[0m` : '0 errors';
        const warnings = stats.warnings > 0 ? `\x1b[33m${stats.warnings} warnings\x1b[0m` : '0 warnings';
        lines.push(`  ${source}: ${stats.total} total, ${errors}, ${warnings}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Format results as JSON
   */
  formatJSON(results: E2EResults): string {
    return JSON.stringify(results, null, 2);
  }

  /**
   * Get the environment manager
   */
  getEnvironment(): EnvironmentManager {
    return this.env;
  }

  /**
   * Get the log collector
   */
  getLogCollector(): LogCollector {
    return this.logCollector;
  }
}
