/**
 * In-Process Pipeline Job Queue
 *
 * Since BuildOrbit runs as a single Express service (no separate workers),
 * this is an in-process queue that processes pipeline runs sequentially.
 *
 * Jobs flow through 5 deterministic stages via the state machine.
 * Each stage is independently retryable and idempotent.
 */

const EventEmitter = require('events');

class PipelineJobQueue extends EventEmitter {
  constructor(stateMachine, executor) {
    super();
    this.stateMachine = stateMachine;
    this.executor = executor;
    this.queue = [];
    this.processing = false;
    this.activeJobs = new Map(); // runId → { aborted }
    this.concurrency = 1; // Single-threaded execution
  }

  /**
   * Enqueue a pipeline run for execution.
   */
  enqueue(runId, prompt) {
    this.queue.push({ runId, prompt, retries: 0 });
    console.log(`[Queue] Enqueued run ${runId.slice(0, 8)}... (queue size: ${this.queue.length})`);
    this.processNext();
  }

  /**
   * Process the next job in the queue.
   */
  async processNext() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift();

    console.log(`[Queue] Processing run ${job.runId.slice(0, 8)}...`);

    const jobContext = { aborted: false };
    this.activeJobs.set(job.runId, jobContext);

    try {
      await this.executeJob(job, jobContext);
    } catch (err) {
      console.error(`[Queue] Job ${job.runId.slice(0, 8)}... failed:`, err.message);
    } finally {
      this.activeJobs.delete(job.runId);
      this.processing = false;
      // Process next job if any
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  /**
   * Execute a pipeline job through all 5 stages.
   * Each stage: transition to running → execute → transition to complete
   */
  async executeJob(job, jobContext) {
    const { runId, prompt } = job;
    const stages = ['plan', 'scaffold', 'code', 'save', 'verify'];

    for (const stage of stages) {
      if (jobContext.aborted) {
        console.log(`[Queue] Run ${runId.slice(0, 8)}... aborted`);
        return;
      }

      // Check if stage already completed (idempotent)
      const alreadyDone = await this.stateMachine.isStageCompleted(runId, stage);
      if (alreadyDone) {
        console.log(`[Queue] Stage ${stage} already completed for ${runId.slice(0, 8)}..., skipping`);
        continue;
      }

      try {
        // Transition: → stage_running
        await this.stateMachine.transition(runId, stage, 'started');

        // Execute the stage
        const result = await this.executor.executeStage(runId, stage, prompt);

        // Transition: → stage_complete
        await this.stateMachine.transition(runId, stage, 'completed', result);

      } catch (err) {
        console.error(`[Queue] Stage ${stage} failed for ${runId.slice(0, 8)}...:`, err.message);

        try {
          await this.stateMachine.transition(runId, stage, 'failed', null, err.message);
        } catch (transErr) {
          console.error(`[Queue] Failed to record failure:`, transErr.message);
        }

        // Don't continue to next stage
        return;
      }
    }

    console.log(`[Queue] Run ${runId.slice(0, 8)}... completed all stages`);
  }

  /**
   * Get queue status.
   */
  getStatus() {
    return {
      queued: this.queue.length,
      processing: this.processing,
      activeJobs: Array.from(this.activeJobs.keys()),
    };
  }
}

module.exports = { PipelineJobQueue };
