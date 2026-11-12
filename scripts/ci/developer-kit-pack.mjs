import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import publisher from './developer-kit.cjs';
const {verifySource,SOURCE,config}=publisher;
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
export async function pack(kit,source,output,tag,commit) {
  await verifySource(source,{kit,tag,commit});
  source=path.resolve(source);output=path.resolve(output);
  if(kit==='ui') {
    run('npm',['ci','--prefix','tools/card-devkit','--userconfig',path.join(source,'.npmrc'),
      '--omit=optional','--ignore-scripts','--no-bin-links','--workspaces=false'],{cwd:source});
    const {packDevkit}=await import(pathToFileURL(path.join(source,'script/cards/pack-devkit.cjs')));
    return packDevkit(output,{sourceTag:tag,sourceCommit:commit});
  }
  if(kit==='extension') {
    run('npm',['ci','--omit=dev','--ignore-scripts','--no-bin-links','--no-audit','--no-fund'],{cwd:source});
  }
  await fs.mkdir(output);
  const files=[],payloads={};
  const add=async name=>{const bytes=await fs.readFile(path.join(output,name));files.push({path:name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});};
  const manifest=JSON.parse(await fs.readFile(path.join(source,SOURCE[kit].manifest)));
  if(manifest.license !== 'Apache-2.0')throw new Error('First-party Kit license must be Apache-2.0');
  for(const platform of kit==='wave'?['portable']:Object.keys(config.platforms)) {
    const stage=path.join(output,`.stage-${platform}`);
    await fs.mkdir(stage);
    try {
      if(kit==='extension') {
        const {stageDevkit}=await import(pathToFileURL(path.join(source,'tools/devkit/stage.mjs')));
        stageDevkit(path.join(stage,'kit'));
        await fs.copyFile(path.join(source,'tools/devkit/package-lock.json'),path.join(stage,'kit/package-lock.json'));
        const [os,cpu]=platform.split('-');
        run('npm',['ci','--omit=dev','--ignore-scripts','--no-bin-links','--no-audit','--no-fund',
          '--os',os==='win'?'win32':os,'--cpu',cpu,...(os==='linux'?['--libc','glibc']:[])],{cwd:path.join(stage,'kit')});
        if(!(await fs.stat(path.join(stage,'kit/node_modules/@mhome/script-build/src/testing.mjs'))).isFile())throw new Error('Publish the required Script testing library before the Kit');
      } else {
        await fs.mkdir(path.join(stage,'kit'));
        for(const name of ['worker.cjs','worker.mjs','src','package.json','README.md'])
          await fs.cp(path.join(source,'tools/devkit',name),path.join(stage,'kit',name),{recursive:true});
        for(const name of ['LICENSE','NOTICE'])
          await fs.copyFile(path.join(source,name),path.join(stage,'kit',name));
      }
      if(kit==='wave') {
        await fs.mkdir(path.join(stage,'kit/examples'));
        await fs.copyFile(path.join(source,'examples/binding-contract/wave.bindings.json'),path.join(stage,'kit/examples/wave.bindings.json'));
      }
      const archive=kit==='wave'?'kit.tar.gz':`kit-${platform}.tar.gz`;
      run('python3',[fileURLToPath(new URL('./developer-kit-archive.py',import.meta.url)),stage,path.join(output,archive)]);
      await add(archive);
      if(platform!=='portable')payloads[platform]=archive;
    } finally {await fs.rm(stage,{recursive:true,force:true});}
  }
  if(kit==='wave') {
    for(const [from,to] of [['tests/fixtures/contracts.export.json','contracts.fixture.json'],['examples/binding-contract/wave.bindings.json','bindings.fixture.json']]){
      await fs.copyFile(path.join(source,from),path.join(output,to));await add(to);
    }
  }
  const built={schemaVersion:1,kit,version:manifest.version,workerProtocol:1,minimumCliVersion:kit==='extension'?(manifest.minimumCliVersion??'1.16.0'):'1.7.0',
    source:{repository:`mhome-ai/${SOURCE[kit].repository}`,tag,commit},files,...(kit==='extension'?{payloads}:{})};
  await fs.writeFile(path.join(output,'kit-build.json'),JSON.stringify(built,null,2)+'\n');
  return built;
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await pack(...process.argv.slice(2))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
