/**
 * `buildorbit status [runId]` — show status of a run (or last run)
 */

import chalk from 'chalk';
import { getStatus } from '../lib/api.js';
import { getToken, getLastRun } from '../lib/config.js';
import { printVerifyChecks, printError } from '../lib/ui.js';

export async function statusCommand(runId, options) {
  const token = getToken();
  if (!token) {
    printError('Not authenticated. Run `buildorbit login` first.');
    process.exit(1);
  }

  // If no runId provided, use last run
  let targetRunId = runId;
  if (!targetRunId) {
    const last = getLastRun();
    if (!last) {
      printError('No run ID provided and no previous runs found.');
      console.log(chalk.dim('  Usage: buildorbit status <run-id>'));
      process.exit(1);
    }
    targetRunId = last.run_id;
    console.log(chalk.dim(`  Using last run: ${targetRunId}\n`));
  }

  try {
    const data = await getStatus(targetRunId, token);
    printRunStatus(data);
  } catch (err) {
    printError(err.message);
    process.exit(1);
  }
}

function printRunStatus(data) {
  const { run_id, status, phase, task_description, passed, verification,
          live_url, artifacts_url, execution_time_ms, created_at } = data;

  console.log(chalk.bold.cyan('\nBuildOrbit Run Status'));
  console.log(chalk.dim('─'.repeat(50)));

  const statusColor = {
    completed: chalk.green,
    failed: chalk.red,
    running: chalk.yellow,
    pending: chalk.blue,
  }[status] || chalk.white;

  console.log(`  ${chalk.bold('Run ID:')}    ${chalk.dim(run_id)}`);
  if (task_description) {
    const preview = task_description.length > 60
      ? task_description.slice(0, 60) + '...'
      : task_description;
    console.log(`  ${chalk.bold('Task:')}      ${preview}`);
  }
  console.log(`  ${chalk.bold('Status:')}    ${statusColor(status?.toUpperCase() || 'UNKNOWN')}`);
  if (phase) {
    console.log(`  ${chalk.bold('Phase:')}     ${phase}`);
  }
  if (execution_time_ms) {
    console.log(`  ${chalk.bold('Duration:')} ${(execution_time_ms / 1000).toFixed(1)}s`);
  }
  if (created_at) {
    console.log(`  ${chalk.bold('Started:')}   ${new Date(created_at).toLocaleString()}`);
  }

  if (verification?.checks?.length) {
    console.log(`\n  ${chalk.bold('Verification:')}`);
    printVerifyChecks(verification.checks, '    ');
  } else if (passed !== undefined) {
    console.log(`\n  ${chalk.bold('Result:')} ${passed ? chalk.green('PASSED') : chalk.red('FAILED')}`);
  }

  if (live_url) {
    console.log(`\n  ${chalk.bold('Live URL:')}   ${chalk.cyan(live_url)}`);
  }
  if (artifacts_url) {
    console.log(`  ${chalk.bold('Artifacts:')} ${chalk.cyan(artifacts_url)}`);
  }

  console.log(chalk.dim('\n' + '─'.repeat(50)));
}
