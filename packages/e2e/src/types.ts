/**
 * Types for E2E test automation
 */

export interface EnvConfig {
  /** hApp to use (fixture1 or ziptest) */
  happ: 'fixture1' | 'ziptest';
  /** Gateway type */
  gateway: 'gw-fork' | 'hc-membrane';
}

export interface EnvState {
  /** Whether environment is running */
  running: boolean;
  /** Bootstrap server address */
  bootstrapAddr?: string;
  /** Gateway port */
  gatewayPort?: number;
  /** Admin ports for each conductor */
  adminPorts: number[];
  /** DNA hash from the conductor */
  dnaHash?: string;
  /** App ID currently running */
  appId?: string;
  /** Known entry hash (for fixture1) */
  knownEntryHash?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Timestamp of the log entry */
  timestamp: Date;
  /** Source of the log (gateway, conductor, extension, bootstrap) */
  source: string;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Raw line from log file */
  raw?: string;
}

export interface CorrelatedLogGroup {
  /** Time window start */
  startTime: Date;
  /** Time window end */
  endTime: Date;
  /** Logs grouped together */
  logs: LogEntry[];
}

export interface TestResult {
  /** Test name */
  name: string;
  /** Test status */
  status: 'pass' | 'fail' | 'skip';
  /** Duration in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Logs captured during this test */
  logs?: LogEntry[];
}

export interface E2EResults {
  /** Timestamp of test run */
  timestamp: string;
  /** Environment configuration */
  environment: {
    happ: string;
    gateway: string;
    dnaHash?: string;
    gatewayUrl: string;
  };
  /** Test results summary */
  results: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    tests: TestResult[];
  };
  /** Aggregated logs by source */
  logs: {
    extension: LogEntry[];
    gateway: LogEntry[];
    conductor: LogEntry[];
    bootstrap: LogEntry[];
  };
}

export interface BrowserContextResult {
  /** Playwright browser context */
  context: import('@playwright/test').BrowserContext;
  /** Extension ID */
  extensionId: string;
  /** Service worker URL */
  serviceWorkerUrl: string;
}
