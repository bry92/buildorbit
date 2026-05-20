#!/usr/bin/env node
/**
 * BuildOrbit CLI — npm-publishable developer tool
 * Wraps the BuildOrbit A2A endpoint at buildorbit.polsia.app/a2a/execute
 *
 * Usage:
 *   buildorbit run "Build a SaaS landing page"
 *   buildorbit login
 *   buildorbit status [run-id]
 *   buildorbit history
 */

import { Command } from 'commander';
import { runCommand } from '../src/commands/run.js';
import { loginCommand } from '../src/commands/login.js';
import { statusCommand } from '../src/commands/status.js';
import { historyCommand } from '../src/commands/history.js';
import { healthCommand } from '../src/commands/health.js';
import { getToken, clearToken } from '../src/lib/config.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('buildorbit')
  .description('Deterministic 6-phase AI builder — stream your build from the terminal')
  .version('1.0.0');

// ── run ────────────────────────────────────────────────────────────────────

program
  .command('run <task>')
  .description('Execute a build and stream the 6-phase pipeline')
  .option('-i, --intent-class <class>',
    'Override intent classification (STATIC_SURFACE|INTERACTIVE_LIGHT_APP|PRODUCT_SYSTEM)')
  .option('-o, --output <dir>', 'Output directory for artifacts', './output')
  .option('--name <name>', 'Product name (context for generation)')
  .option('--tagline <tagline>', 'Product tagline')
  .option('--color <hex>', 'Primary brand color (e.g. #6366f1)')
  .option('--domain <domain>', 'Product domain')
  .action(runCommand);

// ── login ──────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with your BuildOrbit API key')
  .option('--token <token>', 'Provide API key directly (skips prompt)')
  .action(loginCommand);

// ── logout ─────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Remove stored API key')
  .action(() => {
    clearToken();
    console.log(chalk.green('\n✓') + ' Logged out. Token removed from ~/.buildorbit/config.json\n');
  });

// ── status ─────────────────────────────────────────────────────────────────

program
  .command('status [runId]')
  .description('Show status of a run (omit runId to use the last run)')
  .action(statusCommand);

// ── history ────────────────────────────────────────────────────────────────

program
  .command('history')
  .description('List recent local run history')
  .option('-l, --limit <n>', 'Number of runs to show', '10')
  .option('-v, --verbose', 'Show live URLs')
  .action(historyCommand);

// ── health ─────────────────────────────────────────────────────────────────

program
  .command('health')
  .description('Check that the BuildOrbit API is reachable')
  .action(healthCommand);

// ── whoami ─────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show currently saved API key (masked)')
  .action(() => {
    const token = getToken();
    if (!token) {
      console.log(chalk.dim('\n  Not authenticated. Run `buildorbit login`.\n'));
    } else {
      const masked = token.slice(0, 8) + '...' + token.slice(-4);
      console.log(`\n  ${chalk.bold('Token:')} ${chalk.dim(masked)}`);
      console.log(chalk.dim('  Config: ~/.buildorbit/config.json\n'));
    }
  });

// ── default help ───────────────────────────────────────────────────────────

program.addHelpText('beforeAll', chalk.bold.cyan('\nBuildOrbit') + chalk.dim(' — buildorbit.polsia.app\n'));
program.addHelpText('afterAll', `
${chalk.bold('Examples:')}
  ${chalk.cyan('buildorbit login')}
  ${chalk.cyan('buildorbit run "Build a SaaS waitlist page with email capture"')}
  ${chalk.cyan('buildorbit run "Build a mortgage calculator" --intent-class INTERACTIVE_LIGHT_APP')}
  ${chalk.cyan('buildorbit status')}
  ${chalk.cyan('buildorbit history')}
`);

program.parse();
