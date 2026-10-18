import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { validateDeployment } from './deployment-guard.mjs'
const sha = 'a'.repeat(40)
const good = { actions: 'true', runner: 'self-hosted', runId: '123', repository: 'TmRxJD/The-Tower-Run-Tracker-Discord-Bot', event: 'push', ref: 'refs/heads/main', sha, directory: resolve('C:/bots/trackerbot/the-tower-run-tracker-discord-bot').toLowerCase(), origin: 'https://github.com/TmRxJD/The-Tower-Run-Tracker-Discord-Bot.git', branch: 'main', head: sha, remote: sha, dirty: '' }
test('accepts only a clean exact pushed main on the intended runner and repository', () => assert.doesNotThrow(() => validateDeployment(good)))
for (const [key, value] of Object.entries({ actions: '', runner: 'github-hosted', runId: '', repository: 'other/repo', event: 'repository_dispatch', ref: 'refs/heads/dev', sha: '', directory: 'elsewhere', origin: 'https://example.com/repo', branch: 'dev', head: 'b'.repeat(40), remote: 'b'.repeat(40), dirty: ' M src/bot.ts' })) {
  test(`rejects invalid ${key} before deployment`, () => assert.throws(() => validateDeployment({ ...good, [key]: value }), /denied/))
}
