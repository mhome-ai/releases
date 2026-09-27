const { execFileSync } = require('node:child_process');
const REQUIRED = ['Plugin quality (ubuntu-22.04)', 'Plugin quality (macos-14)'];
function validateProtection(protection) {
  if (!protection.enforce_admins?.enabled ||
      !protection.required_pull_request_reviews?.require_code_owner_reviews ||
      !protection.required_pull_request_reviews?.dismiss_stale_reviews ||
      protection.required_pull_request_reviews.required_approving_review_count < 1)
    throw new Error('Plugin main must enforce owner review, stale-review dismissal and protection for administrators');
}
function validateChecks(checks, revision) {
  for (const name of REQUIRED) {
    const latest = checks.filter(c => c.name === name && c.head_sha === revision && c.app?.slug === 'github-actions')
      .sort((a,b) => b.id-a.id)[0];
    if (latest?.status !== 'completed' || latest.conclusion !== 'success')
      throw new Error(`Reviewed Plugin source is missing successful ${name} at ${revision}`);
  }
}
function verifyPluginSource(clone, revision) {
  const git = (...args) => execFileSync('git', ['-C', clone, ...args], {encoding:'utf8'}).trim();
  git('fetch','origin','refs/heads/main:refs/remotes/origin/main');
  git('merge-base','--is-ancestor',revision,'origin/main');
  const api = endpoint => JSON.parse(execFileSync('gh',['api', endpoint],{encoding:'utf8', env: {...process.env, GH_TOKEN: process.env.PLUGIN_SOURCE_READ_TOKEN || process.env.GH_TOKEN}}));
  validateProtection(api('repos/mhome-ai/plugin/branches/main/protection'));
  const runs = api(`repos/mhome-ai/plugin/commits/${revision}/check-runs?per_page=100`);
  validateChecks(runs.check_runs, revision);
}
module.exports = { verifyPluginSource, validateChecks, validateProtection };
