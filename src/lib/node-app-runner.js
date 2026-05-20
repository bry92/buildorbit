/**
 * Node App Runner
 *
 * Manages spawned Node.js processes for PRODUCT_SYSTEM builds.
 * Each deployed full-stack app runs as a child process with its own port.
 *
 * Architecture:
 *   - Ports allocated from 3100–3199 (100-slot pool)
 *   - Max MAX_CONCURRENT_APPS running simultaneously; oldest evicted on overflow
 *   - Health check via HTTP probe on /health (or any 2xx/3xx/4xx response)
 *   - Auto-restart once on crash (2s delay)
 *   - Recovery: rebuild running set from stored app directories on server restart
 *
 * Usage:
 *   const { nodeAppRunner } = require('./src/lib/node-app-runner');
 *   const { port } = await nodeAppRunner.start(runId, appDir);
 *   // Proxy /app/:runId/* to localhost:{port}
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT_RANGE_START = 3100;
const PORT_RANGE_SIZE = 100;
const MAX_CONCURRENT_APPS = 5;
const HEALTH_CHECK_TIMEOUT_MS = 45_000; // 45s — npm install takes time on first start
const HEALTH_CHECK_INTERVAL_MS = 800;

class NodeAppRunner {
  constructor() {
    /** @type {Map<string, { process: import('child_process').ChildProcess, port: number, startedAt: number, appDir: string }>} */
    this._apps = new Map();
    this._usedPorts = new Set();
  }

  /**
   * Start (or restart) a Node.js app for the given run.
   * Kills any existing instance for this runId first.
   *
   * @param {string} runId   Pipeline run UUID
   * @param {string} appDir  Absolute path to the app directory (with node_modules installed)
   * @returns {Promise<{ port: number }>}
   */
  async start(runId, appDir) {
    // Kill existing instance so we don't double-start
    if (this._apps.has(runId)) {
      this._killOnly(runId);
    }

    // Evict oldest if at capacity
    if (this._apps.size >= MAX_CONCURRENT_APPS) {
      this._evictOldest();
    }

    const port = this._allocatePort();
    const entryFile = this._detectEntry(appDir);

    const appEnv = {
      ...process.env,
      PORT: String(port),
      // SQLite file path — apps receive this as DATABASE_URL
      DATABASE_URL: path.join(appDir, 'app.db'),
      NODE_ENV: 'production',
      // Unset credentials that must not leak to child processes
      DATABASE_URL_PG: '',
    };

    console.log(`[NodeAppRunner] Starting ${runId.slice(0, 8)}... entry=${entryFile} port=${port} dir=${appDir}`);

    const proc = spawn('node', [entryFile], {
      cwd: appDir,
      env: appEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => {
      const lines = d.toString().trim().split('\n');
      lines.forEach(l => l && console.log(`[App:${runId.slice(0, 8)}] ${l}`));
    });

    proc.stderr.on('data', (d) => {
      const lines = d.toString().trim().split('\n');
      lines.forEach(l => l && console.warn(`[App:${runId.slice(0, 8)}] ERR: ${l}`));
    });

    const appRecord = { process: proc, port, startedAt: Date.now(), appDir };
    this._apps.set(runId, appRecord);

    proc.on('exit', (code, signal) => {
      console.log(`[NodeAppRunner] ${runId.slice(0, 8)} exited (code=${code}, signal=${signal})`);
      // Guard: only handle if this is still the active record for this run
      const current = this._apps.get(runId);
      if (current && current.process === proc) {
        this._usedPorts.delete(current.port);
        this._apps.delete(runId);
        // Auto-restart once, after a short delay
        setTimeout(() => {
          console.log(`[NodeAppRunner] Auto-restarting ${runId.slice(0, 8)}...`);
          this.start(runId, appDir).catch(err => {
            console.error(`[NodeAppRunner] Auto-restart failed for ${runId.slice(0, 8)}: ${err.message}`);
          });
        }, 2000);
      }
    });

    // Wait for health check before returning
    try {
      await this._waitForHealth(port);
      console.log(`[NodeAppRunner] ${runId.slice(0, 8)} healthy on port ${port} ✓`);
    } catch (err) {
      // Kill process if it never became healthy
      proc.kill('SIGTERM');
      this._usedPorts.delete(port);
      this._apps.delete(runId);
      throw new Error(`App startup failed health check: ${err.message}`);
    }

    return { port };
  }

  /**
   * Stop a running app (removes it from pool, kills process).
   * Does NOT trigger auto-restart.
   */
  stop(runId) {
    const app = this._apps.get(runId);
    if (!app) return;
    console.log(`[NodeAppRunner] Stopping ${runId.slice(0, 8)}...`);
    // Remove BEFORE killing to suppress the auto-restart in the exit handler
    this._apps.delete(runId);
    this._usedPorts.delete(app.port);
    try {
      app.process.kill('SIGTERM');
    } catch (err) {
      console.warn(`[NodeAppRunner] Kill error for ${runId.slice(0, 8)}: ${err.message}`);
    }
  }

  /** Return the port for a running app, or null. */
  getPort(runId) {
    return this._apps.get(runId)?.port ?? null;
  }

  /** Whether an app is currently running. */
  isRunning(runId) {
    return this._apps.has(runId);
  }

  /**
   * Recover a set of apps after server restart.
   * Skips any runId whose appDir doesn't exist on disk.
   *
   * @param {Array<{ runId: string, appDir: string }>} recoveryList
   * @returns {Promise<{ recovered: number, failed: number }>}
   */
  async recoverApps(recoveryList) {
    let recovered = 0;
    let failed = 0;
    for (const { runId, appDir } of recoveryList) {
      if (!fs.existsSync(appDir)) {
        console.warn(`[NodeAppRunner] Recovery skip ${runId.slice(0, 8)}: dir missing`);
        failed++;
        continue;
      }
      if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
        console.warn(`[NodeAppRunner] Recovery skip ${runId.slice(0, 8)}: node_modules missing (ephemeral wipe?)`);
        failed++;
        continue;
      }
      try {
        await this.start(runId, appDir);
        recovered++;
      } catch (err) {
        console.error(`[NodeAppRunner] Recovery failed for ${runId.slice(0, 8)}: ${err.message}`);
        failed++;
      }
    }
    console.log(`[NodeAppRunner] Recovery: ${recovered} recovered, ${failed} failed`);
    return { recovered, failed };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _allocatePort() {
    for (let i = 0; i < PORT_RANGE_SIZE; i++) {
      const p = PORT_RANGE_START + i;
      if (!this._usedPorts.has(p)) {
        this._usedPorts.add(p);
        return p;
      }
    }
    throw new Error('Port pool exhausted — no available ports in range 3100–3199');
  }

  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [runId, app] of this._apps) {
      if (app.startedAt < oldestTime) {
        oldestId = runId;
        oldestTime = app.startedAt;
      }
    }
    if (oldestId) {
      console.log(`[NodeAppRunner] Evicting oldest app: ${oldestId.slice(0, 8)}`);
      this.stop(oldestId);
    }
  }

  /** Kill without suppressing auto-restart (used when immediately restarting) */
  _killOnly(runId) {
    const app = this._apps.get(runId);
    if (!app) return;
    // Remove first so the exit handler's auto-restart is suppressed
    this._apps.delete(runId);
    this._usedPorts.delete(app.port);
    try { app.process.kill('SIGTERM'); } catch (_) {}
  }

  _detectEntry(appDir) {
    const candidates = ['server.js', 'index.js', 'app.js', 'main.js'];
    for (const f of candidates) {
      if (fs.existsSync(path.join(appDir, f))) return f;
    }
    return 'server.js';
  }

  async _waitForHealth(port) {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this._probe(port);
        return;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
      }
    }
    throw new Error(
      `Timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s. Last: ${lastError?.message}`
    );
  }

  /** HTTP probe — succeeds on any status < 500 (4xx means "app is up but route doesn't exist"). */
  _probe(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/health', timeout: 3000 },
        (res) => {
          res.resume(); // drain body
          if (res.statusCode < 500) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        }
      );
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
  }
}

// Singleton — shared between DeployEngine and the server.js proxy route
const nodeAppRunner = new NodeAppRunner();

module.exports = { NodeAppRunner, nodeAppRunner };
