/**
 * Pipeline Event Bus
 *
 * Internal event emitter that drives stage-to-stage progression.
 * When a stage completes, the event bus triggers the next stage automatically.
 *
 * Events:
 *   stage_started     → { runId, stage, timestamp }
 *   stage_completed   → { runId, stage, output, timestamp }
 *   stage_failed      → { runId, stage, error, timestamp }
 *   pipeline_completed → { runId, timestamp }
 *   pipeline_failed    → { runId, stage, error, timestamp }
 *
 * This is NOT an external message queue — it's a Node.js EventEmitter
 * running in the same process as Express. Simple, fast, debuggable.
 */

const EventEmitter = require('events');

const BUS_EVENTS = {
  STAGE_STARTED: 'stage_started',
  STAGE_COMPLETED: 'stage_completed',
  STAGE_FAILED: 'stage_failed',
  PIPELINE_COMPLETED: 'pipeline_completed',
  PIPELINE_FAILED: 'pipeline_failed',
};

class PipelineEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._log = [];
  }

  /**
   * Emit a typed bus event with standardized payload.
   * All events are logged in-memory for debugging.
   */
  emitBusEvent(eventName, payload) {
    const event = {
      event: eventName,
      ...payload,
      timestamp: new Date().toISOString(),
    };

    // In-memory log (last 500 events, ring buffer)
    this._log.push(event);
    if (this._log.length > 500) {
      this._log.shift();
    }

    console.log(`[EventBus] ${eventName} — run:${(payload.runId || '').slice(0, 8)} stage:${payload.stage || '-'}`);
    this.emit(eventName, event);

    return event;
  }

  // ── Typed emitters ───────────────────────────────────────

  stageStarted(runId, stage) {
    return this.emitBusEvent(BUS_EVENTS.STAGE_STARTED, { runId, stage });
  }

  stageCompleted(runId, stage, output) {
    return this.emitBusEvent(BUS_EVENTS.STAGE_COMPLETED, { runId, stage, output });
  }

  stageFailed(runId, stage, error) {
    return this.emitBusEvent(BUS_EVENTS.STAGE_FAILED, {
      runId,
      stage,
      error: typeof error === 'string' ? error : error?.message || 'Unknown error',
    });
  }

  pipelineCompleted(runId) {
    return this.emitBusEvent(BUS_EVENTS.PIPELINE_COMPLETED, { runId });
  }

  pipelineFailed(runId, stage, error) {
    return this.emitBusEvent(BUS_EVENTS.PIPELINE_FAILED, {
      runId,
      stage,
      error: typeof error === 'string' ? error : error?.message || 'Unknown error',
    });
  }

  // ── Query helpers ────────────────────────────────────────

  /**
   * Get recent bus events (for debugging / admin endpoints).
   */
  getRecentEvents(limit = 50) {
    return this._log.slice(-limit);
  }

  /**
   * Get bus events for a specific run.
   */
  getRunEvents(runId) {
    return this._log.filter(e => e.runId === runId);
  }
}

module.exports = { PipelineEventBus, BUS_EVENTS };
