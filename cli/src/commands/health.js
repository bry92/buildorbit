/**
 * health — check that the BuildOrbit API is reachable and healthy
 */

import { BASE_URL } from '../lib/config.js';
import chalk from 'chalk';

export async function healthCommand() {
  process.stdout.write('\n  Checking ' + chalk.dim(BASE_URL + '/health') + ' ... ');
  const start = Date.now();

  try {
    const response = await fetch(`${BASE_URL}/health`);
    const elapsed = Date.now() - start;

    if (!response.ok) {
      console.log(chalk.red('✗'));
      console.log(`\n  ${chalk.red('Error:')} HTTP ${response.status}\n`);
      process.exit(1);
    }

    let body = {};
    try { body = await response.json(); } catch { /* plain-text fallback */ }

    console.log(chalk.green('✓') + chalk.dim(` ${elapsed}ms`));
    console.log('');
    console.log(`  ${chalk.bold('Status:')} ${chalk.green(body.status || 'ok')}`);
    console.log(`  ${chalk.bold('URL:')}    ${chalk.dim(BASE_URL)}`);
    if (body.db !== undefined) {
      console.log(`  ${chalk.bold('DB:')}     ${body.db ? chalk.green('connected') : chalk.red('disconnected')}`);
    }
    console.log('');
  } catch (err) {
    console.log(chalk.red('✗'));
    console.log(`\n  ${chalk.red('Error:')} ${err.message}`);
    console.log(`  ${chalk.dim('Is the server reachable?')}\n`);
    process.exit(1);
  }
}
