/**
 * UI helpers — terminal rendering for BuildOrbit phases
 */

import chalk from 'chalk';

// ── Phase definitions ──────────────────────────────────────────────────────

const PHASES = ['INTENT_GATE', 'PLAN', 'SCAFFOLD', 'CODE', 'SAVE', 'VERIFY'];
const PHASE_NUMBERS = { INTENT_GATE: 1, PLAN: 2, SCAFFOLD: 3, CODE: 4, SAVE: 5, VERIFY: 6 };

const PHASE_ICONS = {
  INTENT_GATE: '🔍',
  PLAN:        '📋',
  SCAFFOLD:    '🏗️ ',
  CODE:        '💻',
  SAVE:        '💾',
  VERIFY:      '✅',
};

// ── Progress bar ───────────────────────────────────────────────────────────

function progressBar(current, total, width = 20) {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return chalk.cyan('━'.repeat(filled)) + chalk.gray('─'.repeat(empty));
}

// ── Phase rendering ────────────────────────────────────────────────────────

export function printPhaseStart(phase, phaseNumber, totalPhases) {
  const icon = PHASE_ICONS[phase] || '▶';
  const bar = progressBar(phaseNumber - 1, totalPhases);
  const label = chalk.bold.cyan(`[${phaseNumber}/${totalPhases}] ${phase}`);
  console.log(`\n${icon} ${label} ${bar} ${chalk.dim('generating...')}`);
}

export function printPhaseComplete(phase, phaseNumber, totalPhases, artifact) {
  const icon = PHASE_ICONS[phase] || '✓';
  const bar = progressBar(phaseNumber, totalPhases);
  const label = chalk.bold.green(`[${phaseNumber}/${totalPhases}] ${phase}`);
  process.stdout.write(`\r${icon} ${label} ${bar} ${chalk.green('done')}    \n`);

  if (artifact) {
    printArtifact(phase, artifact);
  }
}

export function printPhaseError(phase, phaseNumber, message) {
  const label = chalk.bold.red(`[${phaseNumber || '?'}/6] ${phase}`);
  console.log(`\n❌ ${label} — ${chalk.red(message)}`);
}

function printArtifact(phase, artifact) {
  const indent = '   ';

  if (phase === 'INTENT_GATE' && artifact.intent_class) {
    console.log(`${indent}${chalk.dim('intent:')} ${chalk.yellow(artifact.intent_class)}`);
    if (artifact.constraint_contract?.constraints) {
      const c = artifact.constraint_contract.constraints;
      const keys = Object.keys(c).slice(0, 4);
      keys.forEach(k => {
        console.log(`${indent}${chalk.dim(k + ':')} ${JSON.stringify(c[k])}`);
      });
    }
  }

  if (phase === 'PLAN' && artifact.raw_markdown) {
    const preview = artifact.raw_markdown.split('\n').slice(0, 5).join('\n');
    console.log(chalk.dim(preview.split('\n').map(l => indent + l).join('\n')));
  }

  if (phase === 'SCAFFOLD' && artifact.tree) {
    const lines = artifact.tree.slice(0, 8);
    lines.forEach(l => console.log(`${indent}${chalk.dim(l)}`));
    if (artifact.tree.length > 8) {
      console.log(`${indent}${chalk.dim(`... ${artifact.tree.length - 8} more files`)}`);
    }
  }

  if (phase === 'CODE') {
    const fileCount = artifact.files ? Object.keys(artifact.files).length : 0;
    const lines = artifact.total_lines || 0;
    if (fileCount) console.log(`${indent}${chalk.dim(`${fileCount} files, ~${lines} lines`)}`);
  }

  if (phase === 'SAVE' && artifact.version_id) {
    console.log(`${indent}${chalk.dim('version:')} ${chalk.dim(artifact.version_id)}`);
  }

  if (phase === 'VERIFY' && artifact.checks) {
    printVerifyChecks(artifact.checks, indent);
  }
}

export function printVerifyChecks(checks, indent = '   ') {
  if (!checks || !checks.length) return;
  for (const check of checks) {
    const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
    const name = check.passed
      ? chalk.dim(check.name)
      : chalk.red(check.name);
    const msg = check.message ? chalk.dim(` — ${check.message}`) : '';
    console.log(`${indent}${icon} ${name}${msg}`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

export function printSummary(event) {
  const { run_id, passed, verification, execution_time_ms, live_url, artifacts_url } = event;

  console.log('\n' + chalk.bold('─'.repeat(60)));

  if (passed) {
    console.log(chalk.bold.green('✅  Build complete'));
  } else {
    console.log(chalk.bold.red('❌  Build failed'));
  }

  if (execution_time_ms) {
    console.log(chalk.dim(`    Time: ${(execution_time_ms / 1000).toFixed(1)}s`));
  }

  if (verification) {
    const { checks_passed, total_checks, errors, warnings } = verification;
    console.log(chalk.dim(`    Verify: ${checks_passed}/${total_checks} checks passed`));
    if (errors?.length) {
      errors.forEach(e => console.log(chalk.red(`    ✗ ${e}`)));
    }
    if (warnings?.length) {
      warnings.forEach(w => console.log(chalk.yellow(`    ⚠ ${w}`)));
    }
  }

  if (live_url) {
    console.log(`\n    ${chalk.bold('Live:')}     ${chalk.cyan(live_url)}`);
  }
  if (artifacts_url) {
    console.log(`    ${chalk.bold('Artifacts:')} ${chalk.cyan(artifacts_url)}`);
  }
  if (run_id) {
    console.log(`    ${chalk.bold('Run ID:')}   ${chalk.dim(run_id)}`);
  }

  console.log(chalk.bold('─'.repeat(60)));
}

export function printError(msg) {
  console.error(`\n${chalk.red('✗')} ${chalk.bold(msg)}\n`);
}

export function printSuccess(msg) {
  console.log(`\n${chalk.green('✓')} ${msg}\n`);
}

export function printInfo(msg) {
  console.log(chalk.dim(`  ${msg}`));
}

export function printHeader() {
  console.log(chalk.bold.cyan('\nBuildOrbit') + chalk.dim(' — deterministic 6-phase builder'));
  console.log(chalk.dim('  buildorbit.polsia.app') + '\n');
}
