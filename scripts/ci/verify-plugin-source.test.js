const test = require('node:test');
const assert = require('node:assert/strict');
const {validateChecks, validateProtection} = require('./verify-plugin-source');
test('only both successful CI checks on the exact source revision admit a release', () => {
  const revision = 'a'.repeat(40);
  const runs = ['ubuntu-22.04','macos-14'].map((os,i) => ({id:i+1,head_sha:revision, app:{slug:'github-actions'},name:`Plugin quality (${os})`,status:'completed',conclusion:'success'}));
  validateChecks(runs, revision);
  assert.throws(() => validateChecks(runs, 'b'.repeat(40)), /missing successful/);
  assert.throws(() => validateChecks([...runs,{...runs[0],id:3,conclusion:'failure'}],revision), /missing successful/);
  assert.throws(() => validateChecks(runs.slice(1),revision), /missing successful/);
});
test('source publication requires enforced code-owner review, including admins', () => {
  const policy = {enforce_admins:{enabled:true},required_pull_request_reviews:{require_code_owner_reviews:true,dismiss_stale_reviews:true,required_approving_review_count:1}};
  validateProtection(policy);
  for (const key of ['require_code_owner_reviews','dismiss_stale_reviews','required_approving_review_count'])
    assert.throws(() => validateProtection({...policy,required_pull_request_reviews:{...policy.required_pull_request_reviews,[key]:false}}));
  assert.throws(() => validateProtection({...policy,enforce_admins:{enabled:false}}));
});
