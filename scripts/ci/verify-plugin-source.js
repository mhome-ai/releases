const { execFileSync } = require('node:child_process');
function verifyPluginSource(clone, revision, { allowPublicationBranch = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Expected a full Plugin source commit');
  const git = (...args) => execFileSync('git', ['-C', clone, ...args], {encoding:'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (allowPublicationBranch) {
    git('fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--prune', 'origin',
      '+refs/heads/main:refs/remotes/origin/main',
      '+refs/heads/repo-update/*:refs/remotes/origin/repo-update/*');
    if (!git('for-each-ref', `--contains=${revision}`, '--format=%(refname)',
      'refs/remotes/origin/main', 'refs/remotes/origin/repo-update/')) {
      throw new Error('Check source must be on main or a repo-update publication branch');
    }
  } else {
    git('fetch','origin','refs/heads/main:refs/remotes/origin/main');
    git('merge-base','--is-ancestor',revision,'origin/main');
  }
  // Review policy belongs to GitHub. The release runs quality-gate.sh against
  // this frozen commit, rather than depending on a cross-repository API token.
}
module.exports = { verifyPluginSource };
