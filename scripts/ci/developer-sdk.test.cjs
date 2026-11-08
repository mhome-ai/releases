const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {inventory,verifyPlan,publishSdk,names,normalizeLock}=require('./developer-sdk-job.cjs');
const registry=require('./developer-sdk-registry.json');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'developer-sdk-publisher-'));
  const source=path.join(root,'sdk');fs.mkdirSync(source);
  const tool=path.join(root,'registry.py');fs.writeFileSync(tool,'fixture verifier');
  const oldHash=registry.sha256;registry.sha256=createHash('sha256').update(fs.readFileSync(tool)).digest('hex');
  t.after(()=>{registry.sha256=oldHash;fs.rmSync(root,{recursive:true,force:true});});
  const packages=names.map(name=>({name,version:'0.1.0'}));
  for(const item of packages) {fs.mkdirSync(path.join(source,item.name));fs.writeFileSync(path.join(source,item.name,'Cargo.toml'),`[package]\nname="${item.name}"\nversion="${item.version}"\nlicense="Apache-2.0"\n`);}
  const lock='version = 4\n';fs.writeFileSync(path.join(root,'dependency.lock'),lock);
  const plan={schemaVersion:1,packages,dependencyLockSha256:createHash('sha256').update(lock).digest('hex'),files:inventory(source)}, calls=[];
  let state='absent',uncertain=false;
  const command=(name,args,options)=>{
    calls.push({name,args,cwd:options?.cwd,env:options?.env});
    if(name==='python3') {
      if(args[2]==='exists' && state==='absent')throw Object.assign(new Error('absent'),{status:3});
      if(args[2]==='exists' && state==='error')throw Object.assign(new Error('registry unavailable'),{status:1});
      if(args[2]==='verify' && state==='different')throw new Error('occupied package differs');
      return '';
    }
    if(args[0]==='package') {
      const item=packages.find(item=>options.cwd.endsWith(item.name));
      const archive=path.join(args[args.indexOf('--target-dir')+1],'package',`${item.name}-${item.version}.crate`);
      fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'prepared crate');
    }
    if(args[0]==='publish' && !args.includes('--dry-run') && uncertain)throw new Error('upload response lost');
    return '';
  };
  return {source,tool,plan,calls,command,state:value=>{state=value;},uncertain:()=>{uncertain=true;}};
}
test('SDK packages publish in dependency order and share compiled dependency output',t=>{
  const f=fixture(t);publishSdk(f.plan,f.source,f.tool,{command:f.command});
  const uploads=f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run'));
  assert.deepEqual(uploads.map(c=>path.basename(c.cwd)),names);
  for(let i=1;i<names.length;i++) {
    const verified=f.calls.findIndex(c=>c.name==='python3'&&c.args[2]==='verify'&&c.args[4]===names[i-1]);
    const next=f.calls.findIndex(c=>c.name==='cargo'&&c.cwd.endsWith(names[i]));assert(verified<next);
  }
  assert.equal(new Set(uploads.map(c=>c.args[c.args.indexOf('--target-dir')+1])).size,1);
});
test('existing SDK packages are content-verified without another upload',t=>{
  const f=fixture(t);f.state('exists');publishSdk(f.plan,f.source,f.tool,{command:f.command});
  assert.equal(f.calls.filter(c=>c.name==='python3'&&c.args[2]==='verify').length,3);
  assert.equal(f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run')).length,0);
});
test('only the final no-build SDK upload can inherit the Cargo token',t=>{
  const f=fixture(t),previous=process.env.CARGO_REGISTRY_TOKEN;
  process.env.CARGO_REGISTRY_TOKEN='fixture-upload-token';
  try {publishSdk(f.plan,f.source,f.tool,{command:f.command});}
  finally {
    if(previous===undefined)delete process.env.CARGO_REGISTRY_TOKEN;
    else process.env.CARGO_REGISTRY_TOKEN=previous;
  }
  const uploads=f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run'));
  assert.equal(uploads.length,3);
  for(const call of f.calls) {
    if(uploads.includes(call)) {
      assert(call.args.includes('--no-verify'),'compilation was already verified without credentials');
      assert.equal(call.env,undefined,'the standard upload command inherits its workflow credential');
    } else {
      assert(call.env,'every preparation and verification child receives an explicit environment');
      assert.equal(Object.hasOwn(call.env,'CARGO_REGISTRY_TOKEN'),false);
    }
  }
});
for(const state of ['different','error']) test(`registry ${state} stops before any later package`,t=>{
    const f=fixture(t);f.state(state);
    assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:f.command}),/differs|unavailable/);
    assert(!f.calls.some(c=>c.cwd?.endsWith(names[1])));
    assert(!f.calls.some(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run')));
});
test('uncertain SDK uploads are resolved by reads without retrying a write',t=>{
  const f=fixture(t);f.uncertain();publishSdk(f.plan,f.source,f.tool,{command:f.command});
  assert.equal(f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run')).length,3);
  assert.equal(f.calls.filter(c=>c.name==='python3'&&c.args[2]==='wait').length,3);
});
test('changed source, invalid order and altered registry verifier fail before publication',t=>{
  const f=fixture(t);
  assert.throws(()=>verifyPlan({...f.plan,packages:[...f.plan.packages].reverse()},f.source),/Invalid SDK/);
  fs.writeFileSync(f.tool,'changed verifier');assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:f.command}),/pinned source/);
  fs.writeFileSync(path.join(f.source,names[0],'Cargo.toml'),'changed source');
  assert.throws(()=>verifyPlan(f.plan,f.source),/source changed/);assert.equal(f.calls.length,0);
});
test('SDK bootstrap is standalone before the frozen publisher exists',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'developer-sdk-bootstrap-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'job.cjs');fs.copyFileSync(path.join(__dirname,'developer-sdk-job.cjs'),file);
  const result=spawnSync(process.execPath,[file,'setup'],{encoding:'utf8',env:{...process.env,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'invalid'}});
  assert.equal(result.status,1);assert.match(result.stderr,/Invalid publisher commit/);assert.doesNotMatch(result.stderr,/MODULE_NOT_FOUND/);
});
test('SDK lock normalization only changes the two owned package identities',()=>{
  const source='name = "node-core"\nversion = "0.8.0"\n "service-api",\n "serde 1.0.219",\nname = "other-service-api"\n';
  assert.equal(normalizeLock(source),'name = "mhome-plugin-runtime"\nversion = "0.8.0"\n "mhome-plugin-service-api",\n "serde 1.0.219",\nname = "other-service-api"\n');
});
