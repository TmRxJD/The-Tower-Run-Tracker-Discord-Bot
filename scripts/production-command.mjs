/* eslint-env node */
import { execSync } from 'node:child_process'
import process from 'node:process'
import { assertDeployment } from './deployment-guard.mjs'
assertDeployment()
const commands = {
  start: 'pm2 start ecosystem.config.cjs --env production',
  restart: 'pm2 restart trackerbot --update-env',
  refresh: 'pnpm run build:refresh && pm2 restart trackerbot --update-env',
  stop: 'pm2 stop trackerbot',
  register: 'pnpm exec cross-env DEPLOYMENT_MODE=prod NODE_ENV=production BOT_LOG_LEVEL=error ts-node-dev --transpile-only --no-notify --exit-child src/scripts/register-commands.ts --mode=prod',
  run: 'pnpm exec cross-env DEPLOYMENT_MODE=prod NODE_ENV=production node dist/bot.js',
}
const command = commands[process.argv[2]]
if (!command) throw new Error('Unsupported production action')
execSync(command, { stdio: 'inherit', env: process.env })
