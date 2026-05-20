/**
 * `buildorbit run "task description"` — execute a build and stream phases
 */

import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { executeStream } from '../lib/api.js';
import { getToken, appendHistory } from '../lib/config.js';
import {
  printPhaseStart,
  printPhaseComplete,
  printPhaseError,
  printSummary,
  printError,
  printHeader,
} from '../lib/ui.js';

export async function runCommand(taskDescription, options) {
  const token = getToken();
  if (!token) {
    printError('Not authenticated. Run `buildorbit login` first.');
    process.exit(1);
  }

  printHeader();
  console.log(chalk.bold('Task: ') + taskDescription + '\n');

  // Build payload
  const payload = { task_description: taskDescription };
  if (options.intentClass) payload.intent_class = options.intentClass;
  if (options.name || options.tagline || options.color || options.domain) {
    payload.product_context = {};
    if (options.name) payload.product_context.name = options.name;
    if (options.tagline) payload.product_context.tagline = options.tagline;
    if (options.color) payload.product_context.primary_color = options.color;
    if (options.domain) payload.product_context.domain = options.domain;
  }

  // Set up output directory
  const outputDir = options.output || './output';
  let runId = null;
  let finalEvent = null;
  let codeFiles = null;
  const startTime = Date.now();
  const currentPhases = {};

  try {
    for await (const { event, data } of executeStream(payload)) {
      switch (event) {
        case 'connected': {
          runId = data.run_id;
          console.log(chalk.dim(`  Run ID: ${runId}`));
          console.log(chalk.dim(`  Phases: ${data.total_phases}`));
          break;
        }

        case 'phase_start': {
          const { phase, phase_number, total_phases } = data;
          currentPhases[phase] = { start: Date.now(), phase_number };
          printPhaseStart(phase, phase_number, total_phases);
          break;
        }

        case 'phase_complete': {
          const { phase, phase_number, total_phases, artifact } = data;
          printPhaseComplete(phase, phase_number, total_phases, artifact);

          // Capture code files for writing to output/
          if (phase === 'CODE' && artifact?.files) {
            codeFiles = artifact.files;
          }
          break;
        }

        case 'artifact': {
          // Intermediate artifact (same data, already handled in phase_complete)
          if (data.artifact_type === 'generated_files' && data.content?.files) {
            codeFiles = data.content.files;
          }
          break;
        }

        case 'phase_error': {
          printPhaseError(data.phase, data.phase_number, data.message);
          break;
        }

        case 'complete': {
          finalEvent = data;
          runId = data.run_id || runId;
          break;
        }

        case 'error': {
          printError(data.message || 'Pipeline error');
          break;
        }

        default:
          // Unknown event type — ignore
          break;
      }
    }

    // Write artifacts to ./output/
    if (codeFiles && Object.keys(codeFiles).length > 0) {
      await writeArtifacts(codeFiles, outputDir, runId);
    }

    // Print final summary
    if (finalEvent) {
      printSummary(finalEvent);
    } else {
      console.log(chalk.dim('\nStream ended.'));
    }

    // Record in history
    const historyEntry = {
      run_id: runId,
      task: taskDescription,
      status: finalEvent?.passed ? 'passed' : (finalEvent ? 'failed' : 'incomplete'),
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      live_url: finalEvent?.live_url || null,
      artifacts_url: finalEvent?.artifacts_url || null,
    };
    appendHistory(historyEntry);

  } catch (err) {
    printError(err.message);
    process.exit(1);
  }
}

async function writeArtifacts(files, outputDir, runId) {
  // Create versioned output directory
  const slug = runId ? runId.slice(0, 8) : Date.now().toString();
  const dir = join(outputDir, slug);

  try {
    mkdirSync(dir, { recursive: true });

    let written = 0;
    for (const [filename, content] of Object.entries(files)) {
      // Sanitize path to prevent directory traversal
      const safe = filename.replace(/\.\./g, '_').replace(/^\/+/, '');
      const fullPath = join(dir, safe);

      // Ensure parent dirs exist
      const parts = safe.split('/');
      if (parts.length > 1) {
        mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
      }

      const ws = createWriteStream(fullPath);
      await new Promise((resolve, reject) => {
        ws.write(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
        ws.end();
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      written++;
    }

    console.log(`\n${chalk.green('📁')} Artifacts written to ${chalk.cyan(dir)} (${written} files)`);
  } catch (err) {
    console.log(chalk.yellow(`\n⚠  Could not write artifacts: ${err.message}`));
  }
}
