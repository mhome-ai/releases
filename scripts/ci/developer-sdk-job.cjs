const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const registryConfig = () => require('./developer-sdk-registry.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command,args,options={}) => execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim();
const names = ['mhome-plugin-service-api','mhome-plugin-runtime','mhome-plugin-sdk'];
function normalizeLock(text) {
  const aliases={'node-core':'mhome-plugin-runtime','service-api':'mhome-plugin-service-api'};
  return text.replace(/(^name = "|^\s+")(node-core|service-api)(?=\s|")/gm,(_,prefix,name)=>prefix+aliases[name]);
}

function inventory(directory, relative='') {
  return fs.readdirSync(path.join(directory,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const name=path.posix.join(relative,entry.name), file=path.join(directory,name);
    if(entry.isDirectory())return inventory(directory,name);
    if(!entry.isFile())throw new Error('SDK source must contain regular files only');
    return [{path:name,sha256:hash(fs.readFileSync(file))}];
  });
}
function verifyPlan(plan,directory) {
  if(plan.schemaVersion!==1 || plan.packages?.map(item=>item.name).join(',')!==names.join(','))throw new Error('Invalid SDK publication plan');
  for(const item of plan.packages)if(!/^\d+\.\d+\.\d+$/.test(item.version))throw new Error('SDK versions must be exact');
  const lock=path.join(path.dirname(directory),'dependency.lock');
  if(!fs.lstatSync(lock).isFile() || hash(fs.readFileSync(lock))!==plan.dependencyLockSha256)throw new Error('Frozen SDK dependency lock changed');
  if(JSON.stringify(inventory(directory))!==JSON.stringify(plan.files))throw new Error('Frozen SDK source changed');
}
function publishSdk(plan,directory,tool,{command=run}={}) {
  verifyPlan(plan,directory);
  if(hash(fs.readFileSync(tool))!==registryConfig().sha256)throw new Error('Registry verifier differs from the pinned source');
  const publication=path.join(path.dirname(directory),'publication');fs.mkdirSync(publication);
  for(const item of plan.packages) {
    const project=path.join(publication,item.name);
    fs.cpSync(path.join(directory,item.name),project,{recursive:true});
    // Preserve captured dependency versions on exact retries. Only the source
    // packages' registry identities change; unrelated dependencies do not update.
    fs.copyFileSync(path.join(path.dirname(directory),'dependency.lock'),path.join(project,'Cargo.lock'));
    command('cargo',['update','--workspace'],{cwd:project});
    const target=path.join(publication,'target');
    command('cargo',['test','--locked','--lib','--tests','--target-dir',target],{cwd:project});
    command('cargo',['publish','--locked','--dry-run','--target-dir',target],{cwd:project});
    command('cargo',['package','--locked','--no-verify','--offline','--target-dir',target],{cwd:project});
    const archive=path.join(target,'package',`${item.name}-${item.version}.crate`);
    if(!fs.statSync(archive).isFile())throw new Error('SDK package archive is missing');
    const check=action=>command('python3',['-B',tool,action,'crate',item.name,item.version,...(action==='verify'?[archive]:[])]);
    let exists;
    try {check('exists');exists=true;} catch(error) {if(error.status!==3)throw error;exists=false;}
    if(!exists) {
      // An uncertain upload gets read-only resolution, never another upload.
      try {command('cargo',['publish','--locked','--target-dir',target],{cwd:project});}
      catch {process.stderr.write(`Checking uncertain upload of ${item.name} without retrying it\n`);}
      check('wait');
    }
    check('verify');
  }
}
function workPath() {
  for(const value of [process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT])if(!/^\d+$/.test(value||''))throw new Error('A GitHub invocation is required');
  return path.join(os.homedir(),'.mhome/work',`developer-sdk-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
}
async function main() {
  const [action,invocation]=process.argv.slice(2), work=workPath(), originals=path.join(os.homedir(),'.mhome');
  if(action==='clean') {
    for(const name of ['integration','foundation','releases'])if(fs.existsSync(path.join(work,name,'.git')))run('git',['-C',path.join(originals,name),'worktree','remove','--force',path.join(work,name)]);
    fs.rmSync(work,{recursive:true,force:true});return;
  }
  const publisher=path.join(work,'releases');
  if(action==='setup') {
    if(!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''))throw new Error('Invalid publisher commit');
    if(fs.existsSync(work))throw new Error('Owned SDK publication directory already exists');
    fs.mkdirSync(work,{recursive:true,mode:0o700});
    const original=path.join(originals,'releases');
    const origin=run('git',['-C',original,'remote','get-url','origin']);
    if(!['git@github.com:mhome-ai/releases.git','https://github.com/mhome-ai/releases.git','ssh://git@github.com/mhome-ai/releases.git'].includes(origin))throw new Error('Expected the mhome-ai/releases source origin');
    run('git',['-C',original,'fetch','--no-tags','origin',process.env.GITHUB_SHA]);
    run('git',['-C',original,'worktree','add','--detach',publisher,process.env.GITHUB_SHA]);
    console.log(work);return;
  }
  const {verifySourceTag}=require('./developer-kit-job.cjs'), registry=registryConfig();
  if(run('git',['-C',publisher,'rev-parse','HEAD'])!==process.env.GITHUB_SHA || run('git',['-C',publisher,'status','--porcelain']))throw new Error('Frozen SDK publisher changed');
  const request=JSON.parse(fs.readFileSync(invocation)), {source_tag:tag,source_commit:commit}=request;
  if(!/^sdk-plugin-v\d+\.\d+\.\d+$/.test(tag)||!/^[a-f0-9]{40}$/.test(commit||''))throw new Error('Expected exact SDK tag and full source commit');
  const source=path.join(work,'integration'), tools=path.join(work,'foundation'), artifacts=path.join(work,'artifacts'), sdk=path.join(artifacts,'sdk');
  if(action==='build') {
    for(const [name,sourceTag,sha] of [['integration',tag,commit],['foundation',registry.tag,registry.commit]]) {
      const original=path.join(originals,name);verifySourceTag(original,name,sourceTag,sha);
      run('git',['-C',original,'worktree','add','--detach',path.join(work,name),sha]);
    }
    run('npm',['ci','--prefix','tools/devkit','--ignore-scripts','--no-audit','--no-fund'],{cwd:source});
    run('node',['--test','tools/devkit/native-sdk.test.mjs'],{cwd:source});
    fs.mkdirSync(artifacts);
    const {stageNativeSdk}=await import(pathToFileURL(path.join(source,'tools/devkit/stage-native.mjs')));
    const packages=stageNativeSdk(sdk,{tag,commit}).map(({name,version})=>({name,version}));
    if(tag!==`sdk-plugin-v${packages.at(-1).version}`)throw new Error('SDK tag does not match the public facade version');
    const lock=normalizeLock(fs.readFileSync(path.join(source,'Cargo.lock'),'utf8'));
    fs.writeFileSync(path.join(artifacts,'dependency.lock'),lock);
    const plan={schemaVersion:1,source:{tag,commit},packages,dependencyLockSha256:hash(lock),files:inventory(sdk)};
    verifyPlan(plan,sdk);fs.writeFileSync(path.join(artifacts,'sdk-plan.json'),JSON.stringify(plan,null,2)+'\n');
  } else if(action==='publish') {
    verifySourceTag(path.join(originals,'integration'),'integration',tag,commit);
    const plan=JSON.parse(fs.readFileSync(path.join(artifacts,'sdk-plan.json')));
    if(plan.source.commit!==commit || plan.source.tag!==tag)throw new Error('SDK candidate source identity differs');
    publishSdk(plan,sdk,path.join(tools,registry.path));
  } else throw new Error('Expected setup, build, publish or clean');
}
module.exports={inventory,verifyPlan,publishSdk,names,normalizeLock};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
