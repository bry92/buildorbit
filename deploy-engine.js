/**
 * Deploy Engine
 *
 * Post-pipeline deployment service. Takes verified build artifacts and serves
 * them live from the BuildOrbit Express app.
 *
 * Architecture:
 *   - Runs AFTER pipeline completes (verify_complete → completed)
 *   - Non-blocking: deploy failures never affect run status
 *   - Files served at /live/{slug}/ (static) or /live/{runId}/ (fallback)
 *   - Versioned: every deploy creates a numbered snapshot
 *   - Rollback: swap active pointer in DB → instant
 *
 * Deploy flow:
 *   1. Read code artifacts from artifact store
 *   2. Generate URL-safe slug from prompt
 *   3. Write files to ./deployed/{runId}/v{N}/
 *   4. Symlink/copy latest to ./deployed/{runId}/current/
 *   5. Record in pipeline_deployments table
 *   6. Emit SSE events throughout
 *
 * Serving:
 *   Express static middleware mounts /live/:runId → ./deployed/:runId/current/
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEPLOY_BASE = path.join(__dirname, 'deployed');
const PREVIEW_BASE = path.join(__dirname, 'preview');
const APPS_BASE = path.join(__dirname, 'apps');

class DeployEngine {
  /**
   * @param {import('pg').Pool} pool
   * @param {object} stateMachine - PipelineStateMachine (for SSE event emission)
   * @param {import('./lib/node-app-runner').NodeAppRunner} [nodeAppRunner] - Optional: manages PRODUCT_SYSTEM Node processes
   */
  constructor(pool, stateMachine, nodeAppRunner = null) {
    this.pool = pool;
    this.stateMachine = stateMachine;
    this.nodeAppRunner = nodeAppRunner;
    fs.mkdirSync(DEPLOY_BASE, { recursive: true });
    fs.mkdirSync(PREVIEW_BASE, { recursive: true });
    fs.mkdirSync(APPS_BASE, { recursive: true });
    console.log(`[DeployEngine] Initialized. Deploy base: ${DEPLOY_BASE}, Apps base: ${APPS_BASE}`);
  }

  /**
   * Recover all active deployments from the database on startup.
   * Render's filesystem is ephemeral — every restart wipes ./deployed/.
   * This method reconstructs the deployed files from pipeline_runs.code.
   *
   * Call once after construction, before the server starts accepting requests.
   * Non-fatal: individual recovery failures are logged but don't crash the server.
   *
   * @returns {Promise<{ recovered: number, failed: number }>}
   */
  async recover() {
    console.log('[DeployEngine] Recovering active deployments from database...');
    let recovered = 0;
    let failed = 0;

    try {
      // Find all active deployments with their code artifacts
      const { rows } = await this.pool.query(`
        SELECT d.run_id, d.version, d.slug, d.url, r.code, r.prompt
        FROM pipeline_deployments d
        JOIN pipeline_runs r ON r.id = d.run_id
        WHERE d.is_active = true AND d.status = 'deployed'
      `);

      if (rows.length === 0) {
        console.log('[DeployEngine] No active deployments to recover.');
        return { recovered: 0, failed: 0 };
      }

      console.log(`[DeployEngine] Found ${rows.length} active deployment(s) to recover.`);

      for (const row of rows) {
        try {
          const code = typeof row.code === 'string' ? JSON.parse(row.code) : row.code;
          if (!code || !code.files || Object.keys(code.files).length === 0) {
            console.warn(`[DeployEngine] Skip recovery for ${row.run_id.slice(0, 8)}: no code files in DB`);
            failed++;
            continue;
          }

          const versionDir = path.join(DEPLOY_BASE, row.run_id, `v${row.version}`);
          const currentDir = path.join(DEPLOY_BASE, row.run_id, 'current');

          // Write version files
          fs.mkdirSync(versionDir, { recursive: true });
          let fileCount = 0;
          for (const [filename, content] of Object.entries(code.files)) {
            if (typeof content !== 'string') continue;
            const filePath = path.join(versionDir, filename);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
            fileCount++;
          }

          // Auto-inject index.html if missing
          if (!code.files['index.html']) {
            const htmlFile = Object.keys(code.files).find(f => f.endsWith('.html'));
            if (htmlFile) {
              fs.copyFileSync(
                path.join(versionDir, htmlFile),
                path.join(versionDir, 'index.html')
              );
            } else {
              const entryPoint = code.entryPoint || Object.keys(code.files)[0] || 'app.js';
              fs.writeFileSync(
                path.join(versionDir, 'index.html'),
                this._generateIndexHtml(row.prompt, entryPoint, code.files),
                'utf8'
              );
              fileCount++;
            }
          }

          // Copy to current
          this._updateCurrentDir(currentDir, versionDir);
          recovered++;
          console.log(`[DeployEngine] Recovered ${row.run_id.slice(0, 8)} v${row.version} (${fileCount} files)`);
        } catch (err) {
          console.error(`[DeployEngine] Failed to recover ${row.run_id.slice(0, 8)}:`, err.message);
          failed++;
        }
      }
    } catch (err) {
      console.error('[DeployEngine] Recovery query failed:', err.message);
    }

    console.log(`[DeployEngine] Static recovery complete: ${recovered} recovered, ${failed} failed.`);

    // ── Recover PRODUCT_SYSTEM Node.js apps ────────────────────────────────
    if (this.nodeAppRunner) {
      try {
        const { rows: nodeRows } = await this.pool.query(`
          SELECT d.run_id, d.node_app_dir
          FROM pipeline_deployments d
          WHERE d.is_active = true AND d.status = 'deployed' AND d.deploy_type = 'nodejs'
            AND d.node_app_dir IS NOT NULL
        `);
        if (nodeRows.length > 0) {
          console.log(`[DeployEngine] Recovering ${nodeRows.length} Node.js app(s)...`);
          const recoveryList = nodeRows.map(r => ({ runId: r.run_id, appDir: r.node_app_dir }));
          const nodeResult = await this.nodeAppRunner.recoverApps(recoveryList);
          recovered += nodeResult.recovered;
          failed += nodeResult.failed;
        }
      } catch (err) {
        console.error('[DeployEngine] Node app recovery query failed:', err.message);
      }
    }

    console.log(`[DeployEngine] Recovery complete: ${recovered} recovered, ${failed} failed.`);
    return { recovered, failed };
  }

  /**
   * Deploy a completed run's artifacts.
   * Safe to call fire-and-forget — catches all internal errors.
   *
   * @param {string} runId - Pipeline run UUID
   * @param {string} prompt - Original user prompt (for slug generation)
   * @param {object} [codeArtifact] - Pre-loaded code artifact (optional; reads from DB if absent)
   * @returns {Promise<{ success: boolean, url?: string, deploymentId?: number, error?: string }>}
   */
  async deploy(runId, prompt, codeArtifact = null) {
    console.log(`[DeployEngine] Starting deploy for run ${runId.slice(0, 8)}...`);

    try {
      // Emit: deploy starting
      this._emit(runId, 'deploy_started', { phase: 'packaging', message: 'Packaging your work...' });

      // 0. Check intent class — PRODUCT_SYSTEM gets Node.js deploy
      const intentClass = await this._getIntentClass(runId);
      if (intentClass === 'PRODUCT_SYSTEM' && this.nodeAppRunner) {
        const code = codeArtifact || await this._loadCodeArtifact(runId);
        if (!code || !code.files || Object.keys(code.files).length === 0) {
          throw new Error('No code files found in artifact store');
        }
        return await this.deployNodeApp(runId, prompt, code);
      }

      // 1. Load code artifact
      const code = codeArtifact || await this._loadCodeArtifact(runId);
      if (!code || !code.files || Object.keys(code.files).length === 0) {
        throw new Error('No code files found in artifact store');
      }

      // 2. Generate slug from prompt
      const slug = this._slugify(prompt || runId);

      // 3. Determine version number
      const version = await this._getNextVersion(runId);

      // 4. Create deploy directory for this version
      const versionDir = path.join(DEPLOY_BASE, runId, `v${version}`);
      const currentDir = path.join(DEPLOY_BASE, runId, 'current');
      fs.mkdirSync(versionDir, { recursive: true });

      // 5. Write files
      const files = code.files;
      let fileCount = 0;
      for (const [filename, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue;
        const filePath = path.join(versionDir, filename);
        const fileDir = path.dirname(filePath);
        fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        fileCount++;
      }

      // 6. Auto-inject index.html if missing but there's an HTML file
      if (!files['index.html']) {
        const htmlFile = Object.keys(files).find(f => f.endsWith('.html'));
        if (htmlFile) {
          fs.copyFileSync(
            path.join(versionDir, htmlFile),
            path.join(versionDir, 'index.html')
          );
        } else {
          // Generate a minimal index.html wrapper
          const entryPoint = code.entryPoint || Object.keys(files)[0] || 'app.js';
          fs.writeFileSync(
            path.join(versionDir, 'index.html'),
            this._generateIndexHtml(prompt, entryPoint, files),
            'utf8'
          );
          fileCount++;
        }
      }

      this._emit(runId, 'deploy_uploading', { phase: 'uploading', message: 'Uploading...' });

      // 7. Deactivate previous deployments for this run
      await this.pool.query(
        `UPDATE pipeline_deployments SET is_active = false WHERE run_id = $1`,
        [runId]
      ).catch(() => {});

      // 8. Update ./deployed/{runId}/current → point to this version
      this._updateCurrentDir(currentDir, versionDir);

      // 9. Record in DB
      const deployType = this._detectType(files);
      const url = `/live/${runId}/`;
      const { rows } = await this.pool.query(
        `INSERT INTO pipeline_deployments
           (run_id, version, status, slug, url, deploy_type, file_count, is_active, deployed_at)
         VALUES ($1, $2, 'deployed', $3, $4, $5, $6, true, NOW())
         RETURNING id`,
        [runId, version, slug, url, deployType, fileCount]
      );
      const deploymentId = rows[0].id;

      // 10. Cache on pipeline_runs.deployment
      await this.pool.query(
        `UPDATE pipeline_runs SET deployment = $1 WHERE id = $2`,
        [JSON.stringify({ deploymentId, url, slug, version, status: 'deployed', deployedAt: new Date().toISOString() }), runId]
      ).catch(() => {});

      // 11. Emit: deployed!
      this._emit(runId, 'deploy_complete', {
        phase: 'deployed',
        message: 'Live ✓',
        deploymentId,
        url,
        slug,
        version,
        fileCount,
      });

      console.log(`[DeployEngine] Run ${runId.slice(0, 8)} deployed → ${url} (v${version}, ${fileCount} files)`);
      return { success: true, deploymentId, url, slug, version };

    } catch (err) {
      console.error(`[DeployEngine] Deploy failed for run ${runId.slice(0, 8)}:`, err.message);

      // Record failure in DB (best-effort)
      await this.pool.query(
        `INSERT INTO pipeline_deployments (run_id, version, status, error)
         VALUES ($1, 1, 'failed', $2)
         ON CONFLICT DO NOTHING`,
        [runId, err.message]
      ).catch(() => {});

      // Update pipeline_runs.deployment with failure
      await this.pool.query(
        `UPDATE pipeline_runs SET deployment = $1 WHERE id = $2`,
        [JSON.stringify({ status: 'failed', error: err.message }), runId]
      ).catch(() => {});

      this._emit(runId, 'deploy_failed', { phase: 'failed', message: err.message });

      return { success: false, error: err.message };
    }
  }

  /**
   * Rollback to a specific deployment version.
   *
   * @param {string} runId
   * @param {number} version - Target version number
   * @returns {Promise<{ success: boolean, url?: string, error?: string }>}
   */
  async rollback(runId, version) {
    console.log(`[DeployEngine] Rolling back run ${runId.slice(0, 8)} to v${version}`);

    try {
      const versionDir = path.join(DEPLOY_BASE, runId, `v${version}`);
      if (!fs.existsSync(versionDir)) {
        throw new Error(`Version v${version} not found for run ${runId.slice(0, 8)}`);
      }

      const currentDir = path.join(DEPLOY_BASE, runId, 'current');
      this._updateCurrentDir(currentDir, versionDir);

      // Deactivate all, activate target version
      await this.pool.query(
        `UPDATE pipeline_deployments SET is_active = false WHERE run_id = $1`,
        [runId]
      );
      await this.pool.query(
        `UPDATE pipeline_deployments SET is_active = true WHERE run_id = $1 AND version = $2`,
        [runId, version]
      );

      // Get slug/url from target version
      const { rows } = await this.pool.query(
        `SELECT url, slug FROM pipeline_deployments WHERE run_id = $1 AND version = $2`,
        [runId, version]
      );
      const url = rows[0]?.url || `/live/${runId}/`;

      // Update pipeline_runs.deployment
      await this.pool.query(
        `UPDATE pipeline_runs SET deployment = $1 WHERE id = $2`,
        [JSON.stringify({ status: 'deployed', url, version, rolledBackAt: new Date().toISOString() }), runId]
      ).catch(() => {});

      this._emit(runId, 'deploy_rollback', { version, url, message: `Restored to version ${version}` });

      return { success: true, url, version };
    } catch (err) {
      console.error(`[DeployEngine] Rollback failed:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get deploy status for a run.
   */
  async getStatus(runId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM pipeline_deployments WHERE run_id = $1 ORDER BY version DESC`,
      [runId]
    );
    const active = rows.find(r => r.is_active);
    return {
      runId,
      hasDeployment: rows.length > 0,
      activeDeployment: active || null,
      url: active?.url || null,
      status: active?.status || (rows.length > 0 ? rows[0].status : 'none'),
      history: rows,
    };
  }

  /**
   * Get deploy history (all versions) for a run.
   */
  async getHistory(runId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM pipeline_deployments WHERE run_id = $1 ORDER BY version DESC`,
      [runId]
    );
    return rows;
  }

  // ── PRODUCT_SYSTEM: Full-Stack Node.js Deploy ──────────────

  /**
   * Deploy a PRODUCT_SYSTEM build as a live Node.js process.
   *
   * Flow:
   *  1. Write files to ./apps/{runId}/v{N}/
   *  2. Copy to ./apps/{runId}/current/
   *  3. npm install --production in current dir
   *  4. nodeAppRunner.start(runId, currentDir)
   *  5. Record in pipeline_deployments with deploy_type='nodejs'
   *  6. Emit deploy_complete with url=/app/{runId}/
   *
   * @param {string} runId
   * @param {string} prompt
   * @param {{ files: Object<string, string>, entryPoint?: string }} code
   * @returns {Promise<{ success: boolean, url?: string, deploymentId?: number, error?: string }>}
   */
  async deployNodeApp(runId, prompt, code) {
    console.log(`[DeployEngine] PRODUCT_SYSTEM deploy for run ${runId.slice(0, 8)}...`);

    try {
      const slug = this._slugify(prompt || runId);
      const version = await this._getNextVersion(runId);

      const versionDir = path.join(APPS_BASE, runId, `v${version}`);
      const currentDir = path.join(APPS_BASE, runId, 'current');
      fs.mkdirSync(versionDir, { recursive: true });

      // 1. Write all files
      const files = code.files;
      let fileCount = 0;
      for (const [filename, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue;
        const filePath = path.join(versionDir, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        fileCount++;
      }

      // 2. Ensure package.json exists (fallback if AI didn't generate one)
      if (!files['package.json']) {
        const entryPoint = code.entryPoint || 'server.js';
        const defaultPkg = JSON.stringify({
          name: slug || 'app',
          version: '1.0.0',
          main: entryPoint,
          scripts: { start: `node ${entryPoint}` },
          dependencies: {
            express: '^4.18.2',
            pg: '^8.11.0',
            'better-sqlite3': '^9.0.0',
            jsonwebtoken: '^9.0.2',
            bcrypt: '^5.1.1',
          },
        }, null, 2);
        fs.writeFileSync(path.join(versionDir, 'package.json'), defaultPkg, 'utf8');
        fileCount++;
      }

      // 3. Copy to current
      this._updateCurrentDir(currentDir, versionDir);

      this._emit(runId, 'deploy_uploading', { phase: 'installing', message: 'Installing dependencies...' });

      // 4. npm install --production in current dir
      console.log(`[DeployEngine] Running npm install for ${runId.slice(0, 8)}...`);
      const npmResult = spawnSync('npm', ['install', '--production', '--legacy-peer-deps', '--no-audit', '--prefer-offline'], {
        cwd: currentDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000, // 2 minutes max
      });
      if (npmResult.status !== 0) {
        const stderr = npmResult.stderr?.toString() || '';
        console.warn(`[DeployEngine] npm install warnings/errors for ${runId.slice(0, 8)}: ${stderr.slice(0, 500)}`);
        // Warn but don't abort — partial installs sometimes still work
      } else {
        console.log(`[DeployEngine] npm install complete for ${runId.slice(0, 8)}`);
      }

      this._emit(runId, 'deploy_uploading', { phase: 'starting', message: 'Starting application...' });

      // 5. Deactivate previous deployments for this run
      await this.pool.query(
        `UPDATE pipeline_deployments SET is_active = false WHERE run_id = $1`,
        [runId]
      ).catch(() => {});

      // 6. Start the Node.js process
      const { port } = await this.nodeAppRunner.start(runId, currentDir);

      // 7. Record in DB
      const url = `/app/${runId}/`;
      const { rows } = await this.pool.query(
        `INSERT INTO pipeline_deployments
           (run_id, version, status, slug, url, deploy_type, file_count, is_active, deployed_at, node_app_dir)
         VALUES ($1, $2, 'deployed', $3, $4, 'nodejs', $5, true, NOW(), $6)
         RETURNING id`,
        [runId, version, slug, url, fileCount, currentDir]
      );
      const deploymentId = rows[0].id;

      // 8. Cache on pipeline_runs.deployment
      await this.pool.query(
        `UPDATE pipeline_runs SET deployment = $1 WHERE id = $2`,
        [JSON.stringify({ deploymentId, url, slug, version, status: 'deployed', deployType: 'nodejs', deployedAt: new Date().toISOString() }), runId]
      ).catch(() => {});

      // 9. Emit complete
      this._emit(runId, 'deploy_complete', {
        phase: 'deployed',
        message: 'App is live ✓',
        deploymentId,
        url,
        slug,
        version,
        fileCount,
        deployType: 'nodejs',
        port,
      });

      console.log(`[DeployEngine] PRODUCT_SYSTEM run ${runId.slice(0, 8)} live → ${url} (v${version}, port=${port})`);
      return { success: true, deploymentId, url, slug, version };

    } catch (err) {
      console.error(`[DeployEngine] Node deploy failed for run ${runId.slice(0, 8)}:`, err.message);

      await this.pool.query(
        `INSERT INTO pipeline_deployments (run_id, version, status, error)
         VALUES ($1, 1, 'failed', $2)
         ON CONFLICT DO NOTHING`,
        [runId, err.message]
      ).catch(() => {});

      await this.pool.query(
        `UPDATE pipeline_runs SET deployment = $1 WHERE id = $2`,
        [JSON.stringify({ status: 'failed', error: err.message }), runId]
      ).catch(() => {});

      this._emit(runId, 'deploy_failed', { phase: 'failed', message: err.message });

      return { success: false, error: err.message };
    }
  }

  // ── Internals ─────────────────────────────────────────────

  async _loadCodeArtifact(runId) {
    // Try filesystem artifact store
    const codePath = path.join(__dirname, 'artifacts', runId, 'code', 'code.json');
    if (fs.existsSync(codePath)) {
      try {
        return JSON.parse(fs.readFileSync(codePath, 'utf8'));
      } catch (_) {}
    }

    // Fall back to DB
    const { rows } = await this.pool.query(
      `SELECT code FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    if (rows[0]?.code) {
      return typeof rows[0].code === 'string' ? JSON.parse(rows[0].code) : rows[0].code;
    }

    return null;
  }

  /**
   * Read intent_class from pipeline_runs for the given runId.
   * Returns null if the DB can't be queried or the run has no intent_class.
   */
  async _getIntentClass(runId) {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query(
        'SELECT intent_class FROM pipeline_runs WHERE id = $1',
        [runId]
      );
      return rows[0]?.intent_class || null;
    } catch (_) {
      return null;
    }
  }

  async _getNextVersion(runId) {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pipeline_deployments WHERE run_id = $1`,
      [runId]
    );
    return rows[0]?.next || 1;
  }

  _updateCurrentDir(currentDir, versionDir) {
    // Remove existing current dir/symlink if exists
    if (fs.existsSync(currentDir)) {
      try {
        const stat = fs.lstatSync(currentDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(currentDir);
        } else if (stat.isDirectory()) {
          fs.rmSync(currentDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }

    // Copy version dir to current (avoids symlink issues on Render)
    this._copyDir(versionDir, currentDir);
  }

  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  _slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'app';
  }

  _detectType(files) {
    const names = Object.keys(files).map(f => f.toLowerCase());
    if (names.some(f => f.endsWith('.html'))) return 'static';
    if (names.includes('package.json') || names.includes('index.js')) return 'nodejs';
    return 'static';
  }

  _generateIndexHtml(prompt, entryPoint, files) {
    const title = (prompt || 'My App').slice(0, 60);
    const fileNames = Object.keys(files);
    const cssFiles = fileNames.filter(f => f.endsWith('.css'));

    // Only include JS files that look like browser code (not Node.js server files)
    const browserJsFiles = fileNames.filter(f => {
      if (!f.endsWith('.js')) return false;
      const content = files[f] || '';
      // Skip Node.js server files — they'll crash in the browser
      if (content.includes("require(") || content.includes('module.exports')) return false;
      // Skip files with obvious server patterns
      if (content.includes('express()') || content.includes('app.listen')) return false;
      return true;
    });

    const cssLinks = cssFiles.map(f => `    <link rel="stylesheet" href="${f}">`).join('\n');
    const jsScripts = browserJsFiles.map(f => `    <script src="${f}"></script>`).join('\n');

    // Build a file listing for the UI
    const fileList = fileNames.map(f => {
      const lines = (files[f] || '').split('\n').length;
      return `<li><span class="file-icon">📄</span> <strong>${f}</strong> <span class="line-count">${lines} lines</span></li>`;
    }).join('\n            ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
${cssLinks}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; padding: 3rem 1.5rem; }
    .hero { text-align: center; margin-bottom: 2.5rem; }
    .hero h1 { font-size: 1.75rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem; }
    .hero p { color: #64748b; font-size: 1rem; }
    .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-bottom: 1rem; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #334155; }
    .file-list { list-style: none; }
    .file-list li { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.875rem; }
    .file-list li:last-child { border-bottom: none; }
    .file-icon { font-size: 1rem; }
    .line-count { margin-left: auto; color: #94a3b8; font-size: 0.75rem; }
    .stack-tag { display: inline-block; background: #f1f5f9; color: #475569; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.75rem; margin: 0.15rem; }
    .footer { text-align: center; margin-top: 2rem; color: #94a3b8; font-size: 0.75rem; }
    .footer a { color: #0ea5e9; text-decoration: none; }
    #app { }
  </style>
</head>
<body>
  <div id="app"></div>
  <div class="container">
    <div class="hero">
      <div class="badge">✨ Built with BuildOrbit</div>
      <h1>${title}</h1>
      <p>Full-stack application — Express.js + PostgreSQL</p>
    </div>
    <div class="card">
      <h2>📁 Project Files</h2>
      <ul class="file-list">
            ${fileList}
      </ul>
    </div>
    <div class="card">
      <h2>🛠 Tech Stack</h2>
      <div>
        <span class="stack-tag">Node.js</span>
        <span class="stack-tag">Express</span>
        <span class="stack-tag">PostgreSQL</span>
      </div>
    </div>
    <div class="footer">
      <p>Generated by <a href="/dashboard">BuildOrbit</a></p>
    </div>
  </div>
${jsScripts}
</body>
</html>`;
  }

  /**
   * Write code artifacts to a temporary preview directory so the iframe can
   * show the app during the VERIFY phase — before a full deploy completes.
   *
   * Preview served at: /preview/{runId}/
   * Files written to: ./preview/{runId}/
   *
   * Non-fatal: errors are logged but never thrown.
   * Emits preview_ready SSE event on success.
   *
   * @param {string} runId
   * @param {{ files: Object<string, string>, entryPoint?: string }} codeArtifact
   * @param {string} [prompt] - Used for index.html generation if no HTML present
   */
  async writePreview(runId, codeArtifact, prompt = '') {
    try {
      if (!codeArtifact || !codeArtifact.files || Object.keys(codeArtifact.files).length === 0) {
        return;
      }

      const previewDir = path.join(PREVIEW_BASE, runId);
      fs.mkdirSync(previewDir, { recursive: true });

      const { files } = codeArtifact;

      // Write all files
      for (const [filename, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue;
        const filePath = path.join(previewDir, filename);
        const fileDir = path.dirname(filePath);
        fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
      }

      // Auto-inject index.html if missing
      if (!files['index.html']) {
        const htmlFile = Object.keys(files).find(f => f.endsWith('.html'));
        if (htmlFile) {
          fs.copyFileSync(path.join(previewDir, htmlFile), path.join(previewDir, 'index.html'));
        } else {
          const entryPoint = codeArtifact.entryPoint || Object.keys(files)[0] || 'app.js';
          fs.writeFileSync(
            path.join(previewDir, 'index.html'),
            this._generateIndexHtml(prompt, entryPoint, files),
            'utf8'
          );
        }
      }

      // Emit preview_ready so frontend can show the iframe immediately
      this._emit(runId, 'preview_ready', { url: `/preview/${runId}/` });
      console.log(`[DeployEngine] Preview written for run ${runId.slice(0, 8)}... → /preview/${runId}/`);
    } catch (err) {
      console.warn(`[DeployEngine] writePreview failed for ${runId.slice(0, 8)} (non-fatal):`, err.message);
    }
  }

  _emit(runId, eventType, payload) {
    const payloadStr = JSON.stringify(payload);
    try {
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage: 'deploy',
        status: eventType,
        payload: payloadStr,
        created_at: new Date().toISOString(),
      });
    } catch (_) {
      // Non-fatal — SSE emission should never throw
    }

    // Persist deploy events to pipeline_events so SSE replay on reconnect
    // includes the full deploy sequence (deploy_started → deploy_uploading →
    // deploy_complete/deploy_failed). Without this, only in-memory listeners
    // see deploy progress — late joiners skip straight to "completed".
    if (this.pool) {
      const idempotencyKey = `${runId}:deploy:${eventType}`;
      this.pool.query(
        `INSERT INTO pipeline_events (run_id, stage, status, payload, idempotency_key)
         VALUES ($1, 'deploy', $2, $3, $4)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING`,
        [runId, eventType, payloadStr, idempotencyKey]
      ).catch(err => {
        console.warn(`[DeployEngine] pipeline_events INSERT for ${eventType} failed (non-fatal): ${err.message}`);
      });
    }
  }
}

module.exports = { DeployEngine, DEPLOY_BASE, PREVIEW_BASE, APPS_BASE };
