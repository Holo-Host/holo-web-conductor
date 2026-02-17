#!/usr/bin/env node
/**
 * HWC E2E Test Runner CLI
 *
 * Usage:
 *   npm run e2e                    # Run all tests
 *   npm run e2e -- --clean         # Clean state first
 *   npm run e2e -- --pattern foo   # Run tests matching pattern
 *   npm run e2e:env start          # Start environment
 *   npm run e2e:env stop           # Stop environment
 *   npm run e2e:env status         # Show status
 *   npm run e2e:logs               # Stream logs
 */

import { Command } from 'commander';
import { EnvironmentManager } from './environment.js';
import { LogCollector } from './log-collector.js';
import { TestRunner } from './test-runner.js';
import type { EnvConfig } from './types.js';

const program = new Command();

program
  .name('hwc-e2e')
  .description('E2E test runner for Holochain Web Conductor browser extension')
  .version('0.0.1');

// Main test command
program
  .command('test', { isDefault: true })
  .description('Run e2e tests')
  .option('--clean', 'Clean environment before starting')
  .option('--pattern <pattern>', 'Test file pattern to match')
  .option('--happ <name>', 'hApp to use (ziptest or mewsfeed)', 'ziptest')
  .option('--json', 'Output results as JSON')
  .option('--headed', 'Run with visible browser')
  .option('--no-logs', 'Skip log collection')
  .action(async (options) => {
    const runner = new TestRunner();

    const envConfig: Partial<EnvConfig> = {
      happ: options.happ as EnvConfig['happ'],
    };

    const results = await runner.run({
      envConfig,
      clean: options.clean,
      pattern: options.pattern,
      outputFormat: options.json ? 'json' : 'pretty',
      collectLogs: options.logs !== false,
      headed: options.headed,
    });

    if (options.json) {
      console.log(runner.formatJSON(results));
    } else {
      console.log(runner.formatPretty(results));
    }

    // Exit with error code if tests failed
    process.exit(results.results.failed > 0 ? 1 : 0);
  });

// Environment management commands
const envCommand = program.command('env').description('Manage test environment');

envCommand
  .command('start')
  .description('Start the test environment')
  .option('--happ <name>', 'hApp to use (ziptest or mewsfeed)', 'ziptest')
  .action(async (options) => {
    const env = new EnvironmentManager({
      happ: options.happ,
    });

    try {
      const state = await env.start();
      console.log('\nEnvironment started:');
      console.log(`  Running: ${state.running}`);
      console.log(`  App ID: ${state.appId}`);
      console.log(`  DNA Hash: ${state.dnaHash}`);
      console.log(`  Gateway: ${env.getGatewayUrl()}`);
      console.log(`  Admin Ports: ${state.adminPorts.join(', ')}`);
    } catch (err) {
      console.error('Failed to start environment:', err);
      process.exit(1);
    }
  });

envCommand
  .command('stop')
  .description('Stop the test environment')
  .action(async () => {
    const env = new EnvironmentManager();
    try {
      await env.stop();
      console.log('Environment stopped');
    } catch (err) {
      console.error('Failed to stop environment:', err);
      process.exit(1);
    }
  });

envCommand
  .command('status')
  .description('Show environment status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const env = new EnvironmentManager();
    const state = await env.getStatus();

    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log('\nEnvironment Status:');
      console.log(`  Running: ${state.running ? '\x1b[32mYes\x1b[0m' : '\x1b[31mNo\x1b[0m'}`);
      if (state.running) {
        console.log(`  App ID: ${state.appId}`);
        console.log(`  DNA Hash: ${state.dnaHash}`);
        console.log(`  Bootstrap: ${state.bootstrapAddr}`);
        console.log(`  Admin Ports: ${state.adminPorts.join(', ')}`);
        console.log(`  Gateway Port: ${state.gatewayPort}`);
      }
    }
  });

envCommand
  .command('clean')
  .description('Clean up sandbox data')
  .action(async () => {
    const env = new EnvironmentManager();
    try {
      await env.clean();
      console.log('Environment cleaned');
    } catch (err) {
      console.error('Failed to clean environment:', err);
      process.exit(1);
    }
  });

envCommand
  .command('pause')
  .description('Pause the gateway (conductors keep running)')
  .action(async () => {
    const env = new EnvironmentManager();
    try {
      await env.pauseGateway();
      console.log('Gateway paused');
    } catch (err) {
      console.error('Failed to pause gateway:', err);
      process.exit(1);
    }
  });

envCommand
  .command('unpause')
  .description('Unpause the gateway')
  .option('--happ <name>', 'hApp to use', 'ziptest')
  .action(async (options) => {
    const env = new EnvironmentManager({ happ: options.happ });
    try {
      await env.unpauseGateway();
      console.log('Gateway unpaused');
    } catch (err) {
      console.error('Failed to unpause gateway:', err);
      process.exit(1);
    }
  });

// Log streaming command
program
  .command('logs')
  .description('Stream logs from the test environment')
  .option('--source <source>', 'Filter by source (gateway, conductor, bootstrap)')
  .option('--level <level>', 'Minimum log level (debug, info, warn, error)', 'info')
  .action(async (options) => {
    const env = new EnvironmentManager();
    const collector = new LogCollector();

    console.log('Streaming logs... (Ctrl+C to stop)\n');

    // Attach to log files
    await collector.attachFileLog('gateway', env.getLogPath('gateway'));
    await collector.attachFileLog('conductor', env.getLogPath('conductor'));
    await collector.attachFileLog('bootstrap', env.getLogPath('bootstrap'));

    // Print logs as they come in
    let lastPrintedIndex = 0;

    const printInterval = setInterval(() => {
      const logs = collector.getLogs({
        source: options.source,
        level: options.level,
      });

      for (let i = lastPrintedIndex; i < logs.length; i++) {
        const log = logs[i];
        const time = log.timestamp.toISOString().split('T')[1].slice(0, 8);
        const levelColors: Record<string, string> = {
          debug: '\x1b[90m',
          info: '\x1b[0m',
          warn: '\x1b[33m',
          error: '\x1b[31m',
        };
        const color = levelColors[log.level] ?? '\x1b[0m';
        console.log(`${color}[${log.source}] ${time} ${log.level.toUpperCase()} ${log.message}\x1b[0m`);
      }
      lastPrintedIndex = logs.length;
    }, 100);

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      clearInterval(printInterval);
      collector.stop();
      console.log('\nStopped log streaming');
      process.exit(0);
    });
  });

// Export modules for programmatic use
export { EnvironmentManager } from './environment.js';
export { LogCollector } from './log-collector.js';
export { TestRunner } from './test-runner.js';
export * from './browser-context.js';
export * from './types.js';

// Run CLI
program.parse();
