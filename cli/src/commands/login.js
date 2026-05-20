/**
 * `buildorbit login` — store API key locally
 */

import readline from 'readline';
import chalk from 'chalk';
import { setToken, getToken, BASE_URL } from '../lib/config.js';
import { getStatus } from '../lib/api.js';

export async function loginCommand(options) {
  console.log(chalk.bold.cyan('\nBuildOrbit Login'));
  console.log(chalk.dim('─'.repeat(40)));
  console.log();
  console.log('Get your API key at:');
  console.log(chalk.cyan(`  ${BASE_URL}/settings/api-keys`));
  console.log();
  console.log(chalk.dim('Your key starts with bk_ or bo_live_'));
  console.log();

  // If token passed directly via --token flag
  let token = options.token;

  if (!token) {
    token = await promptToken();
  }

  if (!token || !token.trim()) {
    console.log(chalk.red('\n✗ No token provided.\n'));
    process.exit(1);
  }

  token = token.trim();

  // Validate token format
  if (!token.startsWith('bk_') && !token.startsWith('bo_live_') && !token.startsWith('bo_mock_')) {
    console.log(chalk.yellow('\n⚠  Unexpected token format. Expected bk_ or bo_live_ prefix.'));
    console.log(chalk.dim('  Saving anyway — the API will reject it if invalid.\n'));
  }

  // Save locally first
  setToken(token);

  // Verify against the server
  console.log(chalk.dim('\n  Verifying key…'));
  try {
    const res = await fetch(`${BASE_URL}/auth/verify-key`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const email = data.email ? chalk.cyan(data.email) : 'your account';
      console.log(chalk.green('\n✓') + ` Authenticated as ${email}`);
      console.log(chalk.dim(`  Token saved to ~/.buildorbit/config.json\n`));
    } else {
      // Key saved but invalid — warn and exit non-zero so user knows
      console.log(chalk.yellow('\n⚠  Key saved, but the server rejected it (invalid or expired).'));
      console.log(chalk.dim('  Generate a fresh key at: ') + chalk.cyan(`${BASE_URL}/settings/api-keys\n`));
      process.exit(1);
    }
  } catch {
    // Offline / network error — still saved, proceed with warning
    console.log(chalk.green('\n✓') + ' Token saved to ~/.buildorbit/config.json');
    console.log(chalk.yellow('  (Could not reach server to verify — check your connection)\n'));
  }

  console.log(chalk.dim(`  Run ${chalk.cyan('buildorbit run "your task"')} to start building.\n`));
}

function promptToken() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Don't echo the token
    const query = chalk.bold('API Key: ');
    process.stdout.write(query);

    let token = '';
    // Use raw mode if available to hide input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      process.stdin.on('data', function handler(char) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          rl.close();
          resolve(token);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (token.length > 0) {
            token = token.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          token += char;
          process.stdout.write('*');
        }
      });
    } else {
      // Non-TTY (pipe, CI) — read normally
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}
