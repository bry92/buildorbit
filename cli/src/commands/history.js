/**
 * `buildorbit history` — list recent local run history
 */

import chalk from 'chalk';
import { readHistory } from '../lib/config.js';
import { printError } from '../lib/ui.js';

export function historyCommand(options) {
  const limit = parseInt(options.limit || '10', 10);
  const history = readHistory();

  if (!history.length) {
    console.log(chalk.dim('\n  No runs yet. Try: buildorbit run "your task"\n'));
    return;
  }

  console.log(chalk.bold.cyan('\nBuildOrbit Run History'));
  console.log(chalk.dim('─'.repeat(70)));

  const rows = history.slice(0, limit);

  for (const run of rows) {
    const statusIcon = run.status === 'passed'
      ? chalk.green('✓')
      : run.status === 'failed'
      ? chalk.red('✗')
      : chalk.yellow('~');

    const ts = new Date(run.timestamp);
    const when = formatRelativeTime(ts);
    const dur = run.duration_ms ? chalk.dim(`${(run.duration_ms / 1000).toFixed(1)}s`) : '';
    const id = chalk.dim(run.run_id?.slice(0, 8) || '????????');
    const task = run.task?.length > 50
      ? run.task.slice(0, 50) + '…'
      : (run.task || '(untitled)');

    console.log(`  ${statusIcon} ${id}  ${chalk.dim(when.padEnd(12))} ${dur.padEnd(8)} ${task}`);

    if (options.verbose && run.live_url) {
      console.log(`         ${chalk.cyan(run.live_url)}`);
    }
  }

  console.log(chalk.dim('─'.repeat(70)));
  console.log(chalk.dim(`  Showing ${rows.length} of ${history.length} runs. Local history only.\n`));

  if (history.length > limit) {
    console.log(chalk.dim(`  Run with --limit ${history.length} to see all\n`));
  }
}

function formatRelativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
