const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim();
const repositories={ui:'pallas-cat',extension:'integration',wave:'meow-wave'};
function assertOrigin(directory,repository,command=run) {
  const value=command('git',['-C',directory,'remote','get-url','origin'])
    .replace(/^git@github.com:/,'https://github.com/')
    .replace(/^ssh:\/\/git@github.com\//,'https://github.com/')
    .replace(/\/$/,'').replace(/\.git$/,'').toLowerCase();
  if(value!==`https://github.com/mhome-ai/${repository}`)
    throw new Error(`Expected the mhome-ai/${repository} source origin`);
}
function verifySourceTag(directory,repository,tag,commit,command=run) {
  assertOrigin(directory,repository,command);
  command('git',['-C',directory,'fetch','--no-tags','origin',`refs/tags/${tag}`]);
  if(command('git',['-C',directory,'rev-parse','FETCH_HEAD^{commit}'])!==commit)
    throw new Error('Source tag moved');
}
function workPath(phase,platform) {
  for(const value of [process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT])
    if(!/^\d+$/.test(value || ''))throw new Error('A GitHub invocation is required');
  if(!['prepare','accept','promote'].includes(phase)||!['none','darwin-arm64','darwin-x64','linux-arm64','linux-x64','win-x64'].includes(platform))throw new Error('Invalid job identity');
  return path.join(os.homedir(),'.mhome/work',`developer-kit-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${phase}-${platform}`);
}
async function main() {
 const [action,phase,platform='none',...args]=process.argv.slice(2);
 const root=path.join(os.homedir(),'.mhome'),work=workPath(phase,platform);
 if(action==='setup') {
   if(sync.existsSync(work))throw new Error('Owned publication directory already exists');
   await fs.mkdir(work,{recursive:true,mode:0o700});
   if(!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''))throw new Error('Invalid publisher commit');
   assertOrigin(path.join(root,'releases'),'releases');
   run('git',['-C',path.join(root,'releases'),'fetch','--no-tags','origin',process.env.GITHUB_SHA]);
   run('git',['-C',path.join(root,'releases'),'worktree','add','--detach',path.join(work,'releases'),process.env.GITHUB_SHA]);
   console.log(work);return;
 }
 if(action==='clean') {
   for(const repository of [...Object.values(repositories),'releases']) {
     if(sync.existsSync(path.join(work,repository,'.git')))run('git',['-C',path.join(root,repository),'worktree','remove','--force',path.join(work,repository)]);
   }
   await fs.rm(work,{recursive:true,force:true});return;
 }
 const recipe=path.join(work,'releases');
 if(run('git',['-C',recipe,'rev-parse','HEAD'])!==process.env.GITHUB_SHA || run('git',['-C',recipe,'status','--porcelain']))throw new Error('Frozen publisher changed');
 const request=JSON.parse(await fs.readFile(args[0]));
 const {kit,source_tag:tag,source_commit:commit,cli_version:cliVersion}=request;
 if(!Object.hasOwn(repositories,kit)||!new RegExp(`^kit-${kit}-v[0-9]+\\.[0-9]+\\.[0-9]+$`).test(tag)||!/^[a-f0-9]{40}$/.test(commit))throw new Error('Invalid frozen Kit source');
 const version=tag.split('-v').at(-1),repository=repositories[kit];
 const publisher=require('./developer-kit.cjs');
 const artifacts=path.join(work,'artifacts');
 if(action==='pack') {
   const original=path.join(root,repository),source=path.join(work,repository);
   if(!sync.existsSync(path.join(original,'.git')))throw new Error(`Provision ${repository} on this runner first`);
   verifySourceTag(original,repository,tag,commit);
   run('git',['-C',original,'worktree','add','--detach',source,commit]);
   const {pack}=await import('./developer-kit-pack.mjs');
   await pack(kit,source,artifacts,tag,commit);
 } else if(action==='prepare') {
   await publisher.prepare(artifacts,{cliVersion,orchestratorCommit:process.env.GITHUB_SHA,nodeKeyring:args[1]});
 } else if(action==='upload') await publisher.publish(artifacts);
 else if(action==='accept') await require('./developer-kit-accept.cjs').accept(kit,version,platform,path.join(work,'acceptance'));
 else if(action==='promote') {
   // Platform checks can take time. Reject a deleted/moved remote source tag
   // before making this candidate discoverable, even if its old signature is valid.
   verifySourceTag(path.join(root,repository),repository,tag,commit);
   await fs.mkdir(artifacts);
   const bytes=await publisher.download(`${publisher.BASE}/${kit}/${version}/kit.json`);
   const manifest=publisher.decode(bytes,artifacts);
   if(manifest.source.commit!==commit || manifest.source.tag!==tag || manifest.orchestratorCommit!==process.env.GITHUB_SHA)throw new Error('Candidate source/publisher identity differs');
   await fs.writeFile(path.join(artifacts,'kit.json'),bytes);
   await publisher.publish(artifacts,{promote:true});
 } else throw new Error('Unknown publication action');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={workPath,assertOrigin,verifySourceTag};
