/**
 * Artifact Store
 *
 * Stores and retrieves pipeline run artifacts on the local filesystem.
 * Every pipeline run is persisted and replayable from its artifacts + event log.
 *
 * Storage layout:
 *   {basePath}/{runId}/{stage}/{filename}
 *
 * Key properties:
 *   - Immutable writes: artifacts are never overwritten once written
 *   - Abstracted interface: S3 or other backends can be swapped in without
 *     changing callers — just implement the same interface
 *   - Replay support: buildReplay() merges the event log + artifacts into
 *     a chronological timeline
 *
 * Artifact filenames per stage:
 *   plan     → plan.json
 *   scaffold → scaffold.json
 *   code     → code.json
 *   save     → save.json
 *   verify   → report.json
 */

const fs = require('fs');
const path = require('path');

// ── Stage → artifact filename mapping ──────────────────────
const STAGE_FILENAMES = {
  plan: 'plan.json',
  scaffold: 'scaffold.json',
  code: 'code.json',
  save: 'save.json',
  verify: 'report.json',
  deploy: 'deployment.json',
};

class ArtifactStore {
  /**
   * @param {string} [basePath='./artifacts'] - Root directory for artifact storage
   */
  constructor(basePath = './artifacts') {
    this.basePath = basePath;
    fs.mkdirSync(basePath, { recursive: true });
    console.log(`[ArtifactStore] Initialized at: ${basePath}`);
  }

  /**
   * Write an artifact for a pipeline stage.
   * Immutable: skips silently if artifact already exists.
   *
   * @param {string} runId    - Pipeline run UUID
   * @param {string} stage    - Stage name: plan | scaffold | code | save | verify
   * @param {string} filename - Artifact filename (use STAGE_FILENAMES default or custom)
   * @param {*}      data     - Object (JSON-serialized) or raw string
   * @returns {{ written?: boolean, skipped?: boolean, path: string, size?: number }}
   */
  async writeArtifact(runId, stage, filename, data) {
    const dir = path.join(this.basePath, runId, stage);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, filename);

    // Immutability: never overwrite
    if (fs.existsSync(filePath)) {
      console.log(`[ArtifactStore] Skip (immutable): ${runId.slice(0, 8)}/${stage}/${filename}`);
      return { skipped: true, path: filePath };
    }

    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, 'utf8');

    console.log(`[ArtifactStore] Written: ${runId.slice(0, 8)}/${stage}/${filename} (${content.length}B)`);
    return { written: true, path: filePath, size: content.length };
  }

  /**
   * Write the canonical artifact for a stage (uses standard filename).
   * Convenience wrapper around writeArtifact.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {*}      data
   * @returns {Promise<object>}
   */
  async writeStageArtifact(runId, stage, data) {
    const filename = STAGE_FILENAMES[stage] || `${stage}.json`;
    return this.writeArtifact(runId, stage, filename, data);
  }

  /**
   * Force-overwrite an existing artifact.
   * Used after self-heal to replace a stale artifact with the healed version.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} filename
   * @param {*}      data
   * @returns {{ updated: boolean, path: string, size: number }}
   */
  async updateArtifact(runId, stage, filename, data) {
    const dir = path.join(this.basePath, runId, stage);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, filename);
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, 'utf8');

    console.log(`[ArtifactStore] Updated: ${runId.slice(0, 8)}/${stage}/${filename} (${content.length}B)`);
    return { updated: true, path: filePath, size: content.length };
  }

  /**
   * Force-overwrite the canonical artifact for a stage.
   * Used after self-heal to sync artifacts with healed code.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {*}      data
   * @returns {Promise<object>}
   */
  async updateStageArtifact(runId, stage, data) {
    const filename = STAGE_FILENAMES[stage] || `${stage}.json`;
    return this.updateArtifact(runId, stage, filename, data);
  }

  /**
   * Read an artifact's contents.
   * Returns parsed JSON if content is valid JSON, raw string otherwise.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} filename
   * @returns {*} Parsed content or null if not found
   */
  async readArtifact(runId, stage, filename) {
    const filePath = path.join(this.basePath, runId, stage, filename);
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf8');
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  /**
   * List all artifacts for a run, optionally filtered by stage.
   *
   * @param {string}  runId
   * @param {string}  [stage] - Optional stage filter
   * @returns {Array<{ runId, stage, filename, size, createdAt, url }>}
   */
  async listArtifacts(runId, stage = null) {
    const results = [];

    if (stage) {
      const dir = path.join(this.basePath, runId, stage);
      if (!fs.existsSync(dir)) return [];

      for (const filename of fs.readdirSync(dir)) {
        const filePath = path.join(dir, filename);
        const stat = fs.statSync(filePath);
        results.push({
          runId,
          stage,
          filename,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          url: `/api/pipeline/${runId}/artifacts/${stage}/${filename}`,
        });
      }
    } else {
      const runDir = path.join(this.basePath, runId);
      if (!fs.existsSync(runDir)) return [];

      for (const s of fs.readdirSync(runDir)) {
        const stageDir = path.join(runDir, s);
        if (!fs.statSync(stageDir).isDirectory()) continue;

        for (const filename of fs.readdirSync(stageDir)) {
          const filePath = path.join(stageDir, filename);
          const stat = fs.statSync(filePath);
          results.push({
            runId,
            stage: s,
            filename,
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            url: `/api/pipeline/${runId}/artifacts/${s}/${filename}`,
          });
        }
      }
    }

    // Sort by creation time ascending
    return results.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /**
   * Build a replay timeline: events + artifacts merged chronologically.
   * The full state of a completed run can be reconstructed from this output.
   *
   * @param {string} runId
   * @param {Array}  events - From stateMachine.getEvents(runId)
   * @returns {object} Full replay: { runId, timeline, artifacts, eventCount, artifactCount }
   */
  async buildReplay(runId, events) {
    const artifacts = await this.listArtifacts(runId);

    // Group artifacts by stage
    const artifactsByStage = {};
    for (const artifact of artifacts) {
      if (!artifactsByStage[artifact.stage]) artifactsByStage[artifact.stage] = [];
      artifactsByStage[artifact.stage].push(artifact);
    }

    // Merge events + artifact references into chronological timeline
    const timeline = [];

    for (const event of events) {
      // Parse payload if it's a string
      let payload = event.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { /* keep as string */ }
      }

      timeline.push({
        type: 'event',
        timestamp: event.created_at,
        stage: event.stage,
        status: event.status,
        data: payload,
      });

      // Attach artifacts right after stage_completed event
      if (event.status === 'completed' && artifactsByStage[event.stage]) {
        for (const artifact of artifactsByStage[event.stage]) {
          timeline.push({
            type: 'artifact',
            timestamp: artifact.createdAt,
            stage: artifact.stage,
            filename: artifact.filename,
            size: artifact.size,
            url: artifact.url,
          });
        }
      }
    }

    return {
      runId,
      artifactCount: artifacts.length,
      eventCount: events.length,
      timeline,
      artifacts: artifactsByStage,
    };
  }

  /**
   * Check if a run has any artifacts at all.
   * @param {string} runId
   * @returns {boolean}
   */
  hasArtifacts(runId) {
    return fs.existsSync(path.join(this.basePath, runId));
  }
}

module.exports = { ArtifactStore, STAGE_FILENAMES };
