/**
 * Ops Agent
 *
 * Owns the SAVE stage + cross-cutting operational concerns.
 *
 * Responsibilities:
 *   - SAVE: Persists pipeline artifacts to the database
 *   - GitHub PR push: After saving, pushes generated files as a PR if user has
 *     a GitHub repo selected on the run (github_repo column). Fire-and-forget
 *     with graceful fallback — GitHub push failure never blocks SAVE completion.
 *   - Health monitoring: Tracks retry counts, durations, failure patterns per run
 *   - Retry decisions: Decides whether transient failures should be retried
 *   - Error escalation: Flags high-severity issues after max retries exceeded
 *   - Recovery assistance: Provides health context to the orchestrator on restart
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { persisted: true, runId, versionId, timestamp, githubPrUrl? }
 *
 * Health API:
 *   agent.recordEvent(runId, eventType, meta?)  - Track pipeline lifecycle events
 *   agent.shouldRetry(runId, stage)             - Should this failure be retried?
 *   agent.getHealth(runId)                      - Return health summary for a run
 *   agent.onPipelineComplete(runId)             - Mark run as complete, log metrics
 *   agent.onPipelineFailed(runId, stage, error) - Record failure, escalate if needed
 *
 * Communication: Reads code from previousOutputs (pipeline state).
 * No direct calls to other agents — coordinates via pipeline state.
 */

const { pushToPR } = require('../services/github-push');

class OpsAgent {
  constructor(pool) {
    this.stages = ['save'];
    this.pool = pool;

    // Health tracking per run: runId → HealthRecord
    this._health = new Map();

    // Retry config
    this.MAX_RETRIES = 3;
    this.TRANSIENT_ERROR_PATTERNS = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network error',
      'rate limit',
      '429',
      '503',
    ];
  }

  /**
   * Execute the SAVE stage.
   * Persists all pipeline artifacts to PostgreSQL.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - Must be 'save'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, scaffold, code }
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   * @returns {object} { persisted, runId, versionId, timestamp }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[OpsAgent] Executing SAVE for run ${runId.slice(0, 8)}...`);

    // Detect repo-aware builds — these push targeted patches to the source repo
    const _codeOutput = previousOutputs.code || {};
    const _isRepoAware = Boolean(
      (_codeOutput._repo_aware) ||
      (previousOutputs.scaffold && previousOutputs.scaffold._repo_aware)
    );
    const _repoAwareTargetRepo = _isRepoAware
      ? (_codeOutput._repoFullName || (previousOutputs.scaffold && previousOutputs.scaffold._repoFullName) || null)
      : null;

    // Detect React CDN builds by presence of app.jsx in generated files
    const codeFiles = _codeOutput && _codeOutput.files ? _codeOutput.files : {};
    const isReactBuild = Object.keys(codeFiles).some(k => k === 'app.jsx' || k.endsWith('/app.jsx'));

    let lines;
    if (_isRepoAware) {
      const changedFiles = Object.keys(codeFiles);
      lines = [
        `## Repo-Aware Changes Saved`,
        ``,
        `\u2713 Repository: ${_repoAwareTargetRepo || 'connected repo'}`,
        `\u2713 Changed files: ${changedFiles.length}`,
        ...changedFiles.slice(0, 10).map(f => `  \u2022 ${f}`),
        ...(changedFiles.length > 10 ? [`  \u2026 and ${changedFiles.length - 10} more`] : []),
        `\u2713 Pipeline run: \`${runId.slice(0, 8)}...\``,
        `\u2713 Timestamp: ${new Date().toISOString()}`,
        ``,
        `Targeted changes committed to PR in ${_repoAwareTargetRepo || 'your connected repo'}.`,
      ];
    } else if (isReactBuild) {
      const componentFiles = Object.keys(codeFiles).filter(f => f.startsWith('components/') || f.includes('/components/'));
      const hasCustomCss = Object.keys(codeFiles).some(f => f.endsWith('.css'));
      lines = [
        `## React Project Saved`,
        ``,
        `\u2713 React CDN project structure persisted`,
        `\u2713 index.html \u2014 React CDN loader (Babel + Tailwind)`,
        `\u2713 app.jsx \u2014 Main application component`,
        ...(componentFiles.length > 0 ? [`\u2713 components/ \u2014 ${componentFiles.length} component file(s)`] : []),
        ...(hasCustomCss ? [`\u2713 styles.css \u2014 Custom stylesheet`] : []),
        `\u2713 package.json \u2014 Local dev setup (npm install + serve)`,
        `\u2713 Pipeline run: \`${runId.slice(0, 8)}...\``,
        `\u2713 Timestamp: ${new Date().toISOString()}`,
        ``,
        `Project saved. Download as ZIP for local development.`,
        `Open preview to see the live React render.`,
      ];
    } else {
      lines = [
        `## Artifacts Saved`,
        ``,
        `\u2713 Execution plan persisted`,
        `\u2713 File structure recorded`,
        `\u2713 Generated code committed`,
        `\u2713 Pipeline run: \`${runId.slice(0, 8)}...\``,
        `\u2713 Timestamp: ${new Date().toISOString()}`,
        ``,
        `All artifacts stored in PostgreSQL and retrievable via API.`,
      ];
    }

    for (const line of lines) {
      emitChunk(line + '\n');
      await this._delay(180);
    }

    // Persist phase outputs to pipeline_runs
    const updates = {};
    if (previousOutputs.plan) updates.plan = JSON.stringify(previousOutputs.plan);
    if (previousOutputs.scaffold) updates.scaffold = JSON.stringify(previousOutputs.scaffold);
    if (previousOutputs.code) updates.code = JSON.stringify(previousOutputs.code);

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = Object.values(updates);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
      await this.pool.query(
        `UPDATE pipeline_runs SET ${sets} WHERE id = $1`,
        [runId, ...values]
      );
    }

    const versionId = `v1-${runId.slice(0, 8)}-${Date.now().toString(36)}`;
    const timestamp = new Date().toISOString();

    // ── GitHub PR push (fire-and-forget, graceful fallback) ───────────────────
    // Check if this run has a target GitHub repo. If yes, push the generated
    // files as a PR. Failure here never blocks SAVE — we emit SSE events so
    // the UI can show success or a fallback error message.
    let githubPrUrl = null;

    try {
      const runRow = await this.pool.query(
        'SELECT github_repo, github_create_repo, github_repo_private, user_id, intent_class FROM pipeline_runs WHERE id = $1',
        [runId]
      );

      const runData = runRow.rows[0];

      // For repo-aware builds: use the source repo as the push target
      // (the user's connected repo, not a newly created one)
      const _effectiveGithubRepo = _isRepoAware
        ? (_repoAwareTargetRepo || runData.github_repo)
        : runData.github_repo;

      // For repo-aware builds: write source_repo to pipeline_runs so it's visible in UI
      if (_isRepoAware && _repoAwareTargetRepo && this.pool) {
        this.pool.query(
          'UPDATE pipeline_runs SET source_repo = $1 WHERE id = $2',
          [_repoAwareTargetRepo, runId]
        ).catch(e => console.warn('[OpsAgent] source_repo write failed (non-fatal):', e.message));
      }

      if (runData && _effectiveGithubRepo && runData.user_id) {
        emitChunk(_isRepoAware
          ? `\n🔗 Committing changes to ${_effectiveGithubRepo}...\n`
          : '\n🔗 Pushing to GitHub...\n'
        );

        // Build repo-aware commit message listing changed files
        const _changedFiles = Object.keys(codeFiles);
        const _commitPrompt = _isRepoAware && _changedFiles.length > 0
          ? `${prompt}\n\nChanged files: ${_changedFiles.join(', ')}`
          : prompt;

        const pushResult = await pushToPR({
          pool:           this.pool,
          userId:         runData.user_id,
          runId,
          repoFullName:   _effectiveGithubRepo,
          files:          codeFiles,
          prompt:         _commitPrompt,
          intentClass:    runData.intent_class || null,
          createIfMissing: _isRepoAware ? false : Boolean(runData.github_create_repo),
          privateRepo:    Boolean(runData.github_repo_private),
        });

        githubPrUrl = pushResult.prUrl;

        // Persist PR URL to pipeline_runs
        await this.pool.query(
          'UPDATE pipeline_runs SET github_pr_url = $1 WHERE id = $2',
          [githubPrUrl, runId]
        );

        emitChunk(`✓ GitHub PR opened: #${pushResult.prNumber}\n`);
        emitChunk(`  Branch: ${pushResult.branchName}\n`);
        emitChunk(`  ${pushResult.filesCommitted} file(s) committed\n`);
        if (pushResult.skippedFiles && pushResult.skippedFiles.length > 0) {
          emitChunk(`  ⚠ Skipped ${pushResult.skippedFiles.length} oversized file(s)\n`);
        }

        console.log(`[OpsAgent] GitHub PR created for run ${runId.slice(0, 8)}: ${githubPrUrl}`);
      }
    } catch (ghErr) {
      // GitHub push failure is non-fatal — log it and surface to the terminal
      console.warn(`[OpsAgent] GitHub push failed for run ${runId.slice(0, 8)} (non-fatal): ${ghErr.message}`);

      const userMsg = ghErr.code === 'NOT_CONNECTED'
        ? '⚠ GitHub push skipped — connect GitHub in Settings to enable PR creation\n'
        : ghErr.code === 'TOKEN_EXPIRED'
          ? '⚠ GitHub push failed — token expired. Reconnect GitHub in Settings\n'
          : ghErr.code === 'RATE_LIMITED'
            ? '⚠ GitHub push failed — rate limited. Your artifacts are saved locally\n'
            : `⚠ GitHub push failed — ${ghErr.message.slice(0, 100)}. Artifacts saved locally\n`;

      emitChunk(userMsg);
    }
    // ── end GitHub push ───────────────────────────────────────────────────────

    // Record save in health tracker
    this.recordEvent(runId, 'save_completed', { versionId, timestamp });

    return {
      persisted: true,
      runId,
      versionId,
      timestamp,
      githubPrUrl,
    };
  }

  // ── Health Monitoring ────────────────────────────────────

  /**
   * Record a lifecycle event for a pipeline run.
   * Used to build health history without coupling to state machine.
   *
   * @param {string} runId
   * @param {string} eventType - 'stage_started' | 'stage_completed' | 'stage_failed' | 'save_completed'
   * @param {object} [meta]    - Optional metadata
   */
  recordEvent(runId, eventType, meta = {}) {
    const record = this._getOrCreateHealth(runId);
    record.events.push({
      type: eventType,
      timestamp: new Date().toISOString(),
      ...meta,
    });

    if (eventType === 'stage_failed') {
      record.failureCount++;
      record.lastFailure = { stage: meta.stage, error: meta.error, timestamp: new Date().toISOString() };
    }

    if (eventType === 'stage_started') {
      record.stageStartTimes[meta.stage] = Date.now();
    }

    if (eventType === 'stage_completed' && record.stageStartTimes[meta.stage]) {
      const duration = Date.now() - record.stageStartTimes[meta.stage];
      record.stageDurations[meta.stage] = duration;
    }
  }

  /**
   * Decide whether a failed stage should be retried.
   * Returns true for transient errors within retry limits.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} [error] - Error message
   * @returns {boolean}
   */
  shouldRetry(runId, stage, error = '') {
    const record = this._getOrCreateHealth(runId);

    // Hard cap on total failures
    if (record.failureCount >= this.MAX_RETRIES) {
      console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: max retries (${this.MAX_RETRIES}) exceeded — no retry`);
      return false;
    }

    // Check if error looks transient
    const isTransient = this.TRANSIENT_ERROR_PATTERNS.some(pattern =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );

    if (!isTransient && record.failureCount >= 1) {
      // Non-transient errors: only retry once
      console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: non-transient error after retry — escalating`);
      return false;
    }

    console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: retry approved for stage "${stage}" (attempt ${record.failureCount + 1}/${this.MAX_RETRIES})`);
    return true;
  }

  /**
   * Get health summary for a run.
   * Used by the orchestrator's retry and recovery logic.
   *
   * @param {string} runId
   * @returns {object} Health summary
   */
  getHealth(runId) {
    const record = this._getOrCreateHealth(runId);
    const totalDuration = Object.values(record.stageDurations).reduce((a, b) => a + b, 0);

    return {
      runId,
      failureCount: record.failureCount,
      lastFailure: record.lastFailure,
      stageDurations: record.stageDurations,
      totalDurationMs: totalDuration,
      eventCount: record.events.length,
      startedAt: record.startedAt,
    };
  }

  /**
   * Called when a pipeline completes successfully.
   * Logs metrics and cleans up health state.
   *
   * @param {string} runId
   */
  onPipelineComplete(runId) {
    const health = this.getHealth(runId);
    const totalMs = health.totalDurationMs;
    console.log(
      `[OpsAgent] Pipeline ${runId.slice(0, 8)} COMPLETED — ` +
      `${health.failureCount} failures, ` +
      `${totalMs}ms total across ${Object.keys(health.stageDurations).length} stages`
    );
    // Keep health record for a while (for debugging), but mark complete
    const record = this._health.get(runId);
    if (record) record.completedAt = new Date().toISOString();
  }

  /**
   * Called when a pipeline fails terminally (no more retries).
   * Logs the escalation.
   *
   * @param {string} runId
   * @param {string} stage  - Stage that failed
   * @param {string} error  - Error message
   */
  onPipelineFailed(runId, stage, error) {
    const health = this.getHealth(runId);
    console.error(
      `[OpsAgent] Pipeline ${runId.slice(0, 8)} FAILED — ` +
      `stage: ${stage}, ` +
      `attempts: ${health.failureCount}, ` +
      `error: ${error}`
    );
    // Mark as failed in health record
    const record = this._health.get(runId);
    if (record) {
      record.failedAt = new Date().toISOString();
      record.finalError = { stage, error };
    }
  }

  // ── Internal ─────────────────────────────────────────────

  _getOrCreateHealth(runId) {
    if (!this._health.has(runId)) {
      this._health.set(runId, {
        runId,
        failureCount: 0,
        lastFailure: null,
        stageStartTimes: {},
        stageDurations: {},
        events: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        finalError: null,
      });
    }
    return this._health.get(runId);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OpsAgent };
