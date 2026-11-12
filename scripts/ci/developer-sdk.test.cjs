const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {inventory,verifyPlan,prepareSdkDependencies,publishSdk,archiveSdkRecord,names,normalizeLock}=require('./developer-sdk-job.cjs');
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
  const plan={schemaVersion:2,source:{repository:'mhome-ai/integration',tag:'sdk-plugin-v0.1.0',commit:'a'.repeat(40)},
    publisher:{repository:'mhome-ai/releases',commit:'b'.repeat(40)},packages,
    dependencyLockSha256:createHash('sha256').update(lock).digest('hex'),files:inventory(source)}, calls=[];
  fs.writeFileSync(path.join(root,'sdk-plan.json'),JSON.stringify(plan,null,2)+'\n');
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
test('cold SDK preparation fetches the independent staged graph without an upload credential',t=>{
  const f=fixture(t),before=inventory(f.source),previous=process.env.CARGO_REGISTRY_TOKEN;
  process.env.CARGO_REGISTRY_TOKEN='fixture-upload-token';
  let checked;
  try {
    prepareSdkDependencies(f.source,{command:(name,args,options)=>{
      assert.equal(name,'cargo');assert.equal(args[0],'fetch');
      assert.equal(Object.hasOwn(options.env,'CARGO_REGISTRY_TOKEN'),false);
      checked=options.cwd;
      const manifest=fs.readFileSync(args[args.indexOf('--manifest-path')+1],'utf8');
      for(const name of names) {
        assert(manifest.includes(`${name} = { path = "crates/${name}" }`));
        assert.equal(fs.readFileSync(path.join(options.cwd,'crates',name,'Cargo.toml'),'utf8'),
          fs.readFileSync(path.join(f.source,name,'Cargo.toml'),'utf8'));
      }
    }});
  } finally {
    if(previous===undefined)delete process.env.CARGO_REGISTRY_TOKEN;
    else process.env.CARGO_REGISTRY_TOKEN=previous;
  }
  assert(checked);assert(!fs.existsSync(checked));
  assert.deepEqual(inventory(f.source),before,'fetching must preserve the frozen candidate');
});
test('a dependency fetch failure stops and removes only its own preparation files',t=>{
  const f=fixture(t);let check;
  assert.throws(()=>prepareSdkDependencies(f.source,{command:(_name,_args,options)=>{
    check=options.cwd;throw new Error('missing registry dependency');
  }}),/missing registry dependency/);
  assert(!fs.existsSync(check));assert(fs.existsSync(f.source));
  assert.doesNotThrow(()=>verifyPlan(f.plan,f.source));
});
test('SDK packages publish in dependency order and share compiled dependency output',t=>{
  const f=fixture(t);const receipt=publishSdk(f.plan,f.source,f.tool,{command:f.command});
  const uploads=f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run'));
  assert.deepEqual(uploads.map(c=>path.basename(c.cwd)),names);
  for(let i=1;i<names.length;i++) {
    const verified=f.calls.findIndex(c=>c.name==='python3'&&c.args[2]==='verify'&&c.args[4]===names[i-1]);
    const next=f.calls.findIndex(c=>c.name==='cargo'&&c.cwd.endsWith(names[i]));assert(verified<next);
  }
  assert.equal(new Set(uploads.map(c=>c.args[c.args.indexOf('--target-dir')+1])).size,1);
  assert.equal(receipt.planSha256,createHash('sha256').update(fs.readFileSync(path.join(path.dirname(f.source),'sdk-plan.json'))).digest('hex'));
  assert.deepEqual(receipt.packages.map(({name,version})=>({name,version})),f.plan.packages);
  for(const item of receipt.packages) {
    const file=path.join(path.dirname(f.source),'publication/target/package',`${item.name}-${item.version}.crate`),bytes=fs.readFileSync(file);
    assert.equal(item.preparedArchive.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(item.preparedArchive.size,bytes.length);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(f.source),'sdk-publication.json'))),receipt);
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
    assert(!fs.existsSync(path.join(path.dirname(f.source),'sdk-publication.json')));
});
test('uncertain SDK uploads are resolved by reads without retrying a write',t=>{
  const f=fixture(t);f.uncertain();publishSdk(f.plan,f.source,f.tool,{command:f.command});
  assert.equal(f.calls.filter(c=>c.name==='cargo'&&c.args[0]==='publish'&&!c.args.includes('--dry-run')).length,3);
  assert.equal(f.calls.filter(c=>c.name==='python3'&&c.args[2]==='wait').length,3);
});
test('changed source, invalid order and altered registry verifier fail before publication',t=>{
  const f=fixture(t);
  assert.throws(()=>verifyPlan({...f.plan,packages:[...f.plan.packages].reverse()},f.source),/Invalid SDK/);
  assert.throws(()=>verifyPlan({...f.plan,source:{...f.plan.source,tag:'sdk-plugin-v0.2.0'}},f.source),/provenance/);
  assert.throws(()=>verifyPlan({...f.plan,publisher:{repository:'mhome-ai/releases',commit:'short'}},f.source),/provenance/);
  fs.writeFileSync(f.tool,'changed verifier');assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:f.command}),/pinned source/);
  fs.writeFileSync(path.join(f.source,names[0],'Cargo.toml'),'changed source');
  assert.throws(()=>verifyPlan(f.plan,f.source),/source changed/);assert.equal(f.calls.length,0);
});

function objectStore({lost=false,denied=false,corrupt=false}={}) {
  const objects=new Map(),calls=[];
  const command=(name,args,options)=>{
    assert.equal(name,'aws');assert.equal(Object.hasOwn(options.env,'CARGO_REGISTRY_TOKEN'),false);
    assert(args.includes('--cli-connect-timeout')&&args.includes('--cli-read-timeout'));assert.equal(options.timeout,45000);
    const key=args[args.indexOf('--key')+1];calls.push({action:args[1],key});
    if(args[1]==='put-object') {
      assert.equal(args[args.indexOf('--if-none-match')+1],'*');
      if(denied)throw new Error('AccessDenied');
      if(objects.has(key))throw new Error('PreconditionFailed');
      objects.set(key,fs.readFileSync(args[args.indexOf('--body')+1]));
      if(lost)throw new Error('upload response lost');
    } else {
      assert.equal(args[1],'get-object');
      if(!objects.has(key))throw new Error('NoSuchKey');
      const destination=args[args.indexOf('--key')+2];
      fs.writeFileSync(destination,corrupt?'altered provenance':objects.get(key));
    }
    return '{}';
  };
  return {objects,calls,command};
}
test('partial SDK publication preserves its archived plan without a false completion receipt',t=>{
  const f=fixture(t),store=objectStore();
  archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command});
  assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:(name,args,options)=>{
    const result=f.command(name,args,options);
    if(name==='python3'&&args[2]==='verify'&&args[4]===names[1])throw new Error('runtime verification failed');
    return result;
  }}),/runtime verification failed/);
  assert.equal(store.objects.size,1);
  assert(!fs.existsSync(path.join(path.dirname(f.source),'sdk-publication.json')));
  assert(!f.calls.some(call=>call.cwd?.endsWith(names[2])));
});
test('an altered SDK plan fails preflight or completion instead of changing its recorded provenance',t=>{
  const f=fixture(t),file=path.join(path.dirname(f.source),'sdk-plan.json'),original=fs.readFileSync(file);
  fs.writeFileSync(file,JSON.stringify({...f.plan,publisher:{...f.plan.publisher,commit:'d'.repeat(40)}}));
  assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:f.command}),/Frozen SDK plan changed/);
  assert.equal(f.calls.length,0);fs.writeFileSync(file,original);
  assert.throws(()=>publishSdk(f.plan,f.source,f.tool,{command:(name,args,options)=>{
    const result=f.command(name,args,options);
    if(name==='python3'&&args[2]==='verify'&&args[4]===names[2])fs.appendFileSync(file,'\n');
    return result;
  }}),/Frozen SDK plan changed/);
  assert(!fs.existsSync(path.join(path.dirname(f.source),'sdk-publication.json')));
});
test('SDK provenance survives cleanup in immutable content-addressed storage and exact retries',t=>{
  const f=fixture(t),store=objectStore(),record=archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command});
  assert.deepEqual(archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command}),record);
  assert.equal(store.objects.size,1);assert(record.url.startsWith('https://install.mhome.ai/devkits/extension/sdk/sdk-plugin-v0.1.0/'));
  const bytes=fs.readFileSync(path.join(path.dirname(f.source),'sdk-plan.json'));
  assert.equal(record.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.existsSync(path.join(path.dirname(f.source),'.existing-sdk-plan.json')),false);
  fs.rmSync(path.dirname(f.source),{recursive:true,force:true});
  assert.deepEqual([...store.objects.values()],[bytes]);
});
test('SDK provenance resolves an uncertain write by identical readback without retrying the write',t=>{
  const f=fixture(t),store=objectStore({lost:true});
  assert.doesNotThrow(()=>archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command}));
  assert.deepEqual(store.calls.map(call=>call.action),['put-object','get-object']);
});
for(const [options,error] of [[{denied:true},/AccessDenied/],[{corrupt:true},/Immutable SDK provenance differs/]])
  test('unreadable or different SDK provenance fails instead of assuming successful archival',t=>{
    const f=fixture(t),store=objectStore(options);
    assert.throws(()=>archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command}),error);
    assert.equal(fs.existsSync(path.join(path.dirname(f.source),'.existing-sdk-plan.json')),false);
  });
test('only a matching fully verified SDK receipt is archived, and other publisher plans coexist',t=>{
  const f=fixture(t),store=objectStore();
  const first=archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command});
  publishSdk(f.plan,f.source,f.tool,{command:f.command});
  const published=archiveSdkRecord(f.source,'sdk-publication.json',{command:store.command});
  assert(published.url.endsWith('/sdk-publication.json'));assert.equal(store.objects.size,2);
  const file=path.join(path.dirname(f.source),'sdk-publication.json'),receipt=JSON.parse(fs.readFileSync(file));
  receipt.planSha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(receipt));
  assert.throws(()=>archiveSdkRecord(f.source,'sdk-publication.json',{command:store.command}),/differs from the frozen plan/);
  f.plan.publisher.commit='c'.repeat(40);
  fs.writeFileSync(path.join(path.dirname(f.source),'sdk-plan.json'),JSON.stringify(f.plan,null,2)+'\n');
  const next=archiveSdkRecord(f.source,'sdk-plan.json',{command:store.command});
  assert.notEqual(next.url,first.url);assert.equal(store.objects.size,3);
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
