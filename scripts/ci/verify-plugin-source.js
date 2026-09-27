const { execFileSync } = require('node:child_process');
function verifyPluginSource(clone, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Expected a full Plugin source commit');
  const git = (...args) => execFileSync('git', ['-C', clone, ...args], {encoding:'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('fetch','origin','refs/heads/main:refs/remotes/origin/main');
  git('merge-base','--is-ancestor',revision,'origin/main');
  // Review policy belongs to GitHub. The release runs quality-gate.sh against
  // this frozen commit, rather than depending on a cross-repository API token.
}
module.exports = { verifyPluginSource };
