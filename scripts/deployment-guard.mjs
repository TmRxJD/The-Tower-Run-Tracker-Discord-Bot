/* eslint-env node */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

export const repository = 'TmRxJD/The-Tower-Run-Tracker-Discord-Bot'
const productionDirectory = 'C:/bots/trackerbot/the-tower-run-tracker-discord-bot'
export function validateDeployment(state) {
  const fail = message => { throw new Error(`Production deployment denied: ${message}. Push to main and use the self-hosted deployment workflow.`) }
  if (state.actions !== 'true' || state.runner !== 'self-hosted' || !/^\d+$/.test(state.runId || '')) fail('GitHub self-hosted runner context required')
  if (state.repository !== repository || state.event !== 'push' || state.ref !== 'refs/heads/main') fail('only this repository main push may deploy')
  if (!/^[a-f0-9]{40}$/.test(state.sha || '')) fail('exact pushed revision required')
  if (state.directory !== resolve(productionDirectory).toLowerCase()) fail('wrong production directory')
  if (!/^(https:\/\/github\.com\/|git@github\.com:)TmRxJD\/The-Tower-Run-Tracker-Discord-Bot(?:\.git)?$/i.test(state.origin)) fail('unexpected origin')
  if (state.branch !== 'main' || state.head !== state.sha || state.remote !== state.sha) fail('HEAD and remote main must equal the triggering SHA')
  if (state.dirty.trim()) fail('checkout contains unpublished changes')
}
export function assertDeployment() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const env = process.env
  // Reject before running any commands outside the runner.
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'self-hosted') {
    throw new Error('Production deployment denied: use a pushed main revision through the self-hosted workflow')
  }
  validateDeployment({ actions: env.GITHUB_ACTIONS, runner: env.RUNNER_ENVIRONMENT, runId: env.GITHUB_RUN_ID,
    repository: env.GITHUB_REPOSITORY, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
    directory: resolve(process.cwd()).toLowerCase(), origin: git('remote', 'get-url', 'origin'),
    branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'),
    remote: git('ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s/)[0],
    dirty: git('status', '--porcelain', '--untracked-files=normal') })
}
