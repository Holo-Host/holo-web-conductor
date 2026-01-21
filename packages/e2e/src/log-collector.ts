/**
 * Log Collector
 *
 * Aggregates logs from multiple sources with correlation capabilities.
 */

import { Tail } from 'tail';
import { readFile, access } from 'fs/promises';
import type { BrowserContext, ConsoleMessage } from '@playwright/test';
import type { LogEntry, LogLevel, CorrelatedLogGroup } from './types.js';

/**
 * Parse log level from a log line
 */
function parseLogLevel(line: string): LogLevel {
  const lowerLine = line.toLowerCase();
  if (lowerLine.includes('error') || lowerLine.includes('err]')) return 'error';
  if (lowerLine.includes('warn')) return 'warn';
  if (lowerLine.includes('debug')) return 'debug';
  return 'info';
}

/**
 * Parse timestamp from various log formats
 */
function parseTimestamp(line: string): Date | null {
  // ISO format: 2026-01-20T10:23:45.123Z
  const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (isoMatch) {
    return new Date(isoMatch[1]);
  }

  // Rust log format: 2026-01-20T10:23:45.123456Z
  const rustMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+)/);
  if (rustMatch) {
    return new Date(rustMatch[1]);
  }

  // HH:MM:SS format (assume today)
  const timeMatch = line.match(/(\d{2}:\d{2}:\d{2})/);
  if (timeMatch) {
    const today = new Date();
    const [hours, minutes, seconds] = timeMatch[1].split(':').map(Number);
    today.setHours(hours, minutes, seconds, 0);
    return today;
  }

  return null;
}

export class LogCollector {
  private logs: LogEntry[] = [];
  private tails: Map<string, Tail> = new Map();
  private browserContexts: Map<string, BrowserContext> = new Map();
  private consoleHandlers: Map<string, (msg: ConsoleMessage) => void> = new Map();

  /**
   * Attach a file log source
   */
  async attachFileLog(source: string, path: string): Promise<void> {
    // Check if file exists first
    try {
      await access(path);
    } catch {
      console.warn(`Log file not found: ${path}`);
      return;
    }

    // Read existing content
    try {
      const existingContent = await readFile(path, 'utf-8');
      const lines = existingContent.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        this.addLogEntry(source, line);
      }
    } catch {
      // File might be empty or not readable yet
    }

    // Start tailing for new entries
    try {
      const tail = new Tail(path, { follow: true, fromBeginning: false });

      tail.on('line', (line: string) => {
        this.addLogEntry(source, line);
      });

      tail.on('error', (err: Error) => {
        console.error(`Tail error for ${source}:`, err.message);
      });

      this.tails.set(source, tail);
    } catch (err) {
      console.warn(`Could not start tailing ${path}:`, err);
    }
  }

  /**
   * Attach a Playwright browser context to capture console logs
   */
  attachBrowserContext(contextId: string, context: BrowserContext): void {
    const handler = (msg: ConsoleMessage) => {
      const level = this.mapConsoleType(msg.type());
      const entry: LogEntry = {
        timestamp: new Date(),
        source: `extension:${contextId}`,
        level,
        message: msg.text(),
        raw: `[${msg.type()}] ${msg.text()}`,
      };
      this.logs.push(entry);
    };

    // Attach to all pages in the context
    context.on('page', (page) => {
      page.on('console', handler);
    });

    this.browserContexts.set(contextId, context);
    this.consoleHandlers.set(contextId, handler);
  }

  /**
   * Map console message type to log level
   */
  private mapConsoleType(type: string): LogLevel {
    switch (type) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warn';
      case 'debug':
        return 'debug';
      default:
        return 'info';
    }
  }

  /**
   * Add a log entry from a raw line
   */
  private addLogEntry(source: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const timestamp = parseTimestamp(trimmed) || new Date();
    const level = parseLogLevel(trimmed);

    this.logs.push({
      timestamp,
      source,
      level,
      message: trimmed,
      raw: line,
    });
  }

  /**
   * Get all logs with optional filtering
   */
  getLogs(filter?: { source?: string; level?: LogLevel; since?: Date }): LogEntry[] {
    let result = [...this.logs];

    if (filter?.source) {
      result = result.filter((l) => l.source === filter.source || l.source.startsWith(`${filter.source}:`));
    }

    if (filter?.level) {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      const minIndex = levels.indexOf(filter.level);
      result = result.filter((l) => levels.indexOf(l.level) >= minIndex);
    }

    if (filter?.since) {
      const since = filter.since;
      result = result.filter((l) => l.timestamp >= since);
    }

    return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get logs grouped by time window correlation
   */
  correlate(windowMs: number = 1000): CorrelatedLogGroup[] {
    const sorted = this.getLogs();
    if (sorted.length === 0) return [];

    const groups: CorrelatedLogGroup[] = [];
    let currentGroup: CorrelatedLogGroup = {
      startTime: sorted[0].timestamp,
      endTime: sorted[0].timestamp,
      logs: [sorted[0]],
    };

    for (let i = 1; i < sorted.length; i++) {
      const entry = sorted[i];
      const timeDiff = entry.timestamp.getTime() - currentGroup.endTime.getTime();

      if (timeDiff <= windowMs) {
        // Add to current group
        currentGroup.logs.push(entry);
        currentGroup.endTime = entry.timestamp;
      } else {
        // Start new group
        groups.push(currentGroup);
        currentGroup = {
          startTime: entry.timestamp,
          endTime: entry.timestamp,
          logs: [entry],
        };
      }
    }

    // Don't forget the last group
    groups.push(currentGroup);

    return groups;
  }

  /**
   * Export logs as JSON
   */
  export(): string {
    const bySource: Record<string, LogEntry[]> = {};

    for (const log of this.logs) {
      const source = log.source.split(':')[0]; // Group extension:page1, extension:page2 etc.
      if (!bySource[source]) {
        bySource[source] = [];
      }
      bySource[source].push(log);
    }

    return JSON.stringify(bySource, null, 2);
  }

  /**
   * Get logs formatted for terminal display
   */
  formatForTerminal(filter?: { source?: string; level?: LogLevel; since?: Date }): string {
    const logs = this.getLogs(filter);
    const lines: string[] = [];

    for (const log of logs) {
      const time = log.timestamp.toISOString().split('T')[1].slice(0, 8);
      const levelColors: Record<LogLevel, string> = {
        debug: '\x1b[90m',
        info: '\x1b[0m',
        warn: '\x1b[33m',
        error: '\x1b[31m',
      };
      const reset = '\x1b[0m';
      const color = levelColors[log.level];

      lines.push(`${color}[${log.source}] ${time} ${log.level.toUpperCase()} ${log.message}${reset}`);
    }

    return lines.join('\n');
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Stop all log tailing
   */
  stop(): void {
    for (const [source, tail] of this.tails) {
      try {
        tail.unwatch();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.tails.clear();
    this.browserContexts.clear();
    this.consoleHandlers.clear();
  }

  /**
   * Get count of logs by source
   */
  getStats(): Record<string, { total: number; errors: number; warnings: number }> {
    const stats: Record<string, { total: number; errors: number; warnings: number }> = {};

    for (const log of this.logs) {
      const source = log.source.split(':')[0];
      if (!stats[source]) {
        stats[source] = { total: 0, errors: 0, warnings: 0 };
      }
      stats[source].total++;
      if (log.level === 'error') stats[source].errors++;
      if (log.level === 'warn') stats[source].warnings++;
    }

    return stats;
  }
}

// Export singleton for convenience
export const logCollector = new LogCollector();
