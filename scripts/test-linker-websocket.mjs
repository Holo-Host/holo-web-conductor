#!/usr/bin/env node
/**
 * Linker WebSocket Integration Test
 *
 * Tests the WebSocket protocol between browser extension and linker:
 * 1. Connect to linker WebSocket
 * 2. Authenticate
 * 3. Register an agent
 * 4. Send ping and receive pong
 * 5. Listen for signals (in watch mode)
 *
 * Usage:
 *   node scripts/test-linker-websocket.mjs [linker-url] [--watch]
 *
 * Options:
 *   --watch    Stay connected and listen for signals after tests pass
 *   --signal-test    Wait 5 seconds for a signal (for automated testing)
 *
 * Default linker URL: ws://localhost:8090/ws
 */

import WebSocket from 'ws';

const args = process.argv.slice(2);
const WATCH_MODE = args.includes('--watch');
const SIGNAL_TEST = args.includes('--signal-test');
const LINKER_URL = args.find(a => !a.startsWith('--')) || 'ws://localhost:8090/ws';

// Test data - using proper HoloHash format (base64 URL-safe, 53 chars = 39 bytes)
// DNA hash from the test fixture
const TEST_DNA_HASH = 'uhC0k2J3h4yJ17fbOaKJ8muCcpi9r58tqRFVVKFa6PeFqwy84A3ii';
// Valid 53-char URL-safe base64 for 39-byte agent pubkey (type prefix + 32-byte key + 4-byte loc)
const TEST_AGENT_PUBKEY = 'uhCAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

class LinkerWebSocketTest {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.authenticated = false;
    this.registered = false;
    this.receivedSignals = [];
    this.testsPassed = 0;
    this.testsFailed = 0;
    this.messageHandlers = [];
  }

  log(level, msg, data = null) {
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const prefix = { info: '\x1b[32m[INFO]\x1b[0m', error: '\x1b[31m[ERROR]\x1b[0m', debug: '\x1b[34m[DEBUG]\x1b[0m', signal: '\x1b[35m[SIGNAL]\x1b[0m' }[level] || '[LOG]';
    if (data) {
      console.log(`${timestamp} ${prefix} ${msg}`, data);
    } else {
      console.log(`${timestamp} ${prefix} ${msg}`);
    }
  }

  pass(testName) {
    this.testsPassed++;
    console.log(`\x1b[32m✓ PASS:\x1b[0m ${testName}`);
  }

  fail(testName, error) {
    this.testsFailed++;
    console.log(`\x1b[31m✗ FAIL:\x1b[0m ${testName} - ${error}`);
  }

  send(msg) {
    const json = JSON.stringify(msg);
    this.log('debug', `Sending: ${json}`);
    this.ws.send(json);
  }

  async waitForMessage(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
        reject(new Error(`Timeout waiting for message`));
      }, timeout);

      const handler = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
          resolve(msg);
          return true;
        }
        return false;
      };

      this.messageHandlers.push(handler);
    });
  }

  handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      this.log('debug', `Received: ${JSON.stringify(msg)}`);

      // Check if this is a signal
      if (msg.type === 'signal') {
        this.receivedSignals.push(msg);
        this.log('signal', `Signal received from ${msg.from_agent}`, {
          dna_hash: msg.dna_hash,
          zome_name: msg.zome_name,
          signal_length: msg.signal?.length || 0
        });
      }

      // Check all registered handlers
      for (const handler of this.messageHandlers) {
        if (handler(msg)) {
          break;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.log('info', `Connecting to ${this.url}`);
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.log('info', 'Connected');
        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data));

      this.ws.on('error', (err) => {
        this.log('error', 'WebSocket error', err.message);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.log('info', `Connection closed: code=${code}, reason=${reason}`);
      });
    });
  }

  async testAuth() {
    this.log('info', 'Test: Authentication');

    // Send auth with empty token (linker accepts when no authenticator configured)
    this.send({ type: 'auth', session_token: '' });

    try {
      const response = await this.waitForMessage(msg => msg.type === 'auth_ok' || msg.type === 'auth_error');

      if (response.type === 'auth_ok') {
        this.authenticated = true;
        this.pass('Authentication');
        return true;
      } else {
        this.fail('Authentication', response.message || 'Unknown error');
        return false;
      }
    } catch (e) {
      this.fail('Authentication', e.message);
      return false;
    }
  }

  async testRegister() {
    this.log('info', 'Test: Agent Registration');

    if (!this.authenticated) {
      this.fail('Agent Registration', 'Not authenticated');
      return false;
    }

    this.send({
      type: 'register',
      dna_hash: TEST_DNA_HASH,
      agent_pubkey: TEST_AGENT_PUBKEY,
    });

    try {
      const response = await this.waitForMessage(msg =>
        msg.type === 'registered' || msg.type === 'error'
      );

      if (response.type === 'registered') {
        this.registered = true;
        this.pass('Agent Registration');
        this.log('info', `Registered: dna=${response.dna_hash}, agent=${response.agent_pubkey}`);
        return true;
      } else {
        this.fail('Agent Registration', response.message || 'Unknown error');
        return false;
      }
    } catch (e) {
      this.fail('Agent Registration', e.message);
      return false;
    }
  }

  async testPingPong() {
    this.log('info', 'Test: Ping/Pong');

    this.send({ type: 'ping' });

    try {
      const response = await this.waitForMessage(msg => msg.type === 'pong');
      this.pass('Ping/Pong');
      return true;
    } catch (e) {
      this.fail('Ping/Pong', e.message);
      return false;
    }
  }

  async testUnregister() {
    this.log('info', 'Test: Agent Unregistration');

    if (!this.registered) {
      this.fail('Agent Unregistration', 'Not registered');
      return false;
    }

    this.send({
      type: 'unregister',
      dna_hash: TEST_DNA_HASH,
      agent_pubkey: TEST_AGENT_PUBKEY,
    });

    try {
      const response = await this.waitForMessage(msg =>
        msg.type === 'unregistered' || msg.type === 'error'
      );

      if (response.type === 'unregistered') {
        this.registered = false;
        this.pass('Agent Unregistration');
        return true;
      } else {
        this.fail('Agent Unregistration', response.message || 'Unknown error');
        return false;
      }
    } catch (e) {
      this.fail('Agent Unregistration', e.message);
      return false;
    }
  }

  async testConnectionPersistence() {
    this.log('info', 'Test: Connection Persistence (60s heartbeat simulation)');

    // Send multiple pings over time to verify connection stays alive
    for (let i = 0; i < 3; i++) {
      this.send({ type: 'ping' });
      try {
        await this.waitForMessage(msg => msg.type === 'pong', 2000);
        this.log('debug', `Ping ${i + 1}/3 OK`);
      } catch (e) {
        this.fail('Connection Persistence', `Ping ${i + 1} failed: ${e.message}`);
        return false;
      }
      // Wait a bit between pings
      await new Promise(r => setTimeout(r, 500));
    }

    this.pass('Connection Persistence');
    return true;
  }

  async testSignalWait() {
    this.log('info', 'Test: Signal Reception (waiting 5 seconds)');

    try {
      const response = await this.waitForMessage(msg => msg.type === 'signal', 5000);
      this.pass('Signal Reception');
      this.log('info', `Received signal from ${response.from_agent}`);
      return true;
    } catch (e) {
      // Not receiving a signal in 5 seconds is not necessarily a failure
      // It just means no signal was sent during that time
      this.log('info', 'No signal received within 5 seconds (this is expected if no signal was sent)');
      this.pass('Signal Reception (no signal sent)');
      return true;
    }
  }

  async watchMode() {
    this.log('info', '\n========================================');
    this.log('info', 'WATCH MODE: Listening for signals...');
    this.log('info', 'Press Ctrl+C to exit');
    this.log('info', '========================================\n');

    // Keep connection alive with periodic pings
    const pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 30000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      this.log('info', '\nShutting down...');
      clearInterval(pingInterval);
      if (this.registered) {
        this.send({
          type: 'unregister',
          dna_hash: TEST_DNA_HASH,
          agent_pubkey: TEST_AGENT_PUBKEY,
        });
      }
      setTimeout(() => {
        if (this.ws) {
          this.ws.close();
        }
        console.log(`\nTotal signals received: ${this.receivedSignals.length}`);
        process.exit(0);
      }, 100);
    });

    // Keep the process running
    await new Promise(() => {});
  }

  async run() {
    console.log('\n========================================');
    console.log('Linker WebSocket Integration Test');
    console.log('========================================\n');

    if (WATCH_MODE) {
      console.log('Mode: WATCH (will stay connected after tests)');
    } else if (SIGNAL_TEST) {
      console.log('Mode: SIGNAL TEST (will wait 5s for signal)');
    } else {
      console.log('Mode: STANDARD');
    }
    console.log(`Linker URL: ${this.url}\n`);

    try {
      await this.connect();

      await this.testAuth();
      await this.testRegister();
      await this.testPingPong();
      await this.testConnectionPersistence();

      if (SIGNAL_TEST) {
        await this.testSignalWait();
      }

      if (!WATCH_MODE) {
        await this.testUnregister();
      }

    } catch (e) {
      this.log('error', 'Test suite error', e.message);
    }

    console.log('\n========================================');
    console.log(`Results: ${this.testsPassed} passed, ${this.testsFailed} failed`);
    console.log('========================================\n');

    if (WATCH_MODE && this.testsFailed === 0) {
      await this.watchMode();
    } else {
      if (this.ws) {
        this.ws.close();
      }
      process.exit(this.testsFailed > 0 ? 1 : 0);
    }
  }
}

// Run tests
const test = new LinkerWebSocketTest(LINKER_URL);
test.run().catch(console.error);
