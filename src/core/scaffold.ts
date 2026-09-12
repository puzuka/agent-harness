import {existsSync} from 'node:fs';
import {readCatalog} from './catalog.js';
import {parseTask} from './contract.js';
import {atomicWrite,safePath} from './files.js';
import type {Binding,Criterion,TaskDefinition} from './types.js';

export interface ScaffoldSpec {root:string;projectId:string;authorId:string;sessionId:string;taskId:string;
  bindings:string[];selectors:string[];expects:string[];mutations:string[];artifacts:string[];inputs:string[];maps:string[];
  srs?:string;target?:string;reqs:string[];crits:string[];outsides:string[];warns:string[];
  reviewer?:string;timeoutMs:number;maxOutputBytes:number;maxAttempts:number;out?:string}

const KINDS=new Set(['node-test','cargo-test','vitest','command']);
const unescape=(text:string)=>text.replaceAll('\\n','\n').replaceAll('\\t','\t');

/** Deterministic generator: builds a creatable task draft from compact CLI grammar. It never writes the store. */
export function scaffoldTask(spec:ScaffoldSpec):{task:TaskDefinition;warnings:string[]} {
  const bindings:Binding[]=spec.bindings.map(entry=>{
    const eq=entry.indexOf('='),id=entry.slice(0,eq),rest=entry.slice(eq+1),colon=rest.indexOf(':');
    const kind=colon<0?rest:rest.slice(0,colon),arg=colon<0?'':rest.slice(colon+1);
    if(!id||!KINDS.has(kind))throw new Error('BINDING_SPEC_INVALID: '+entry);
    const binding:Binding={id,profile:kind,kind:kind as Binding['kind'],argv:[],selectors:[],expectedExit:0,expectedStdout:null,mutation:false,artifacts:[]};
    if(kind==='command')binding.argv=arg?arg.split('+').map(unescape):[];
    else if(arg)binding.argv=arg.split(',').map(unescape);
    return binding;
  });
  const byId=(id:string)=>{const binding=bindings.find(b=>b.id===id);if(!binding)throw new Error('BINDING_NOT_IN_SCAFFOLD: '+id);return binding;};
  for(const entry of spec.selectors) {const colon=entry.indexOf(':'),id=entry.slice(0,colon),selector=unescape(entry.slice(colon+1));byId(id).selectors.push(selector);}
  for(const entry of spec.mutations)byId(entry).mutation=true;
  for(const entry of spec.artifacts) {const eq=entry.indexOf('=');byId(entry.slice(0,eq)).artifacts.push(unescape(entry.slice(eq+1)));}
  for(const entry of spec.expects) {
    const eq=entry.indexOf('='),id=entry.slice(0,eq),value=entry.slice(eq+1),colon=value.indexOf(':');
    const binding=byId(id);binding.expectedExit=Number(colon<0?value:value.slice(0,colon));
    if(!Number.isInteger(binding.expectedExit)||binding.expectedExit<0||binding.expectedExit>255)throw new Error('EXPECT_EXIT_INVALID: '+entry);
    if(colon>=0)binding.expectedStdout=unescape(value.slice(colon+1));
  }
  const inputs=new Set(spec.inputs);
  if(spec.srs)inputs.add(spec.srs);
  for(const binding of bindings) {
    for(const path of binding.argv)if(!path.startsWith('$')&&!path.startsWith('-')&&/\.[cm]?[jt]sx?$|\.mjs$/.test(path))inputs.add(path);
    if(binding.kind==='vitest')inputs.add('node_modules/vitest/vitest.mjs');
    for(const artifact of binding.artifacts)if(inputs.has(artifact))throw new Error('ARTIFACT_INPUT_CYCLE');
  }
  for(const name of ['package.json','package-lock.json','tsconfig.json'])if(existsSync(`${spec.root}/${name}`))inputs.add(name);
  let requirementIds:string[],criteria:Criterion[],baseline:TaskDefinition['baseline'];
  if(spec.srs) {
    const catalog=readCatalog(spec.root,spec.srs);
    requirementIds=catalog.requirementIds;
    const targets=spec.target?spec.target.split(',').filter(Boolean):null;
    criteria=catalog.criteria.map(row=>({id:row.id,requirementId:row.requirementId,target:targets?targets.includes(row.id):true,bindingIds:bindings.map(b=>b.id)}));
    baseline={path:spec.srs,sha256:catalog.sourceSha256,warningDispositions:catalog.warnings.map(w=>{
      const entry=spec.warns.find(v=>v.startsWith(w.id+':'));
      if(!entry)throw new Error('WARNING_DISPOSITION_REQUIRED: '+w.id);return {id:w.id,reason:unescape(entry.slice(w.id.length+1))};})};
    const extra=spec.warns.filter(v=>!catalog.warnings.some(w=>v.startsWith(w.id+':')));
    if(extra.length)throw new Error('UNKNOWN_WARNING_ID: '+extra.join(','));
  } else {
    requirementIds=[...spec.reqs];
    const parse=(entry:string,target:boolean):Criterion=>{
      const colon=entry.indexOf(':'),id=colon<0?entry:entry.slice(0,colon),req=colon<0?null:entry.slice(colon+1);
      if(req&&!requirementIds.includes(req))requirementIds.push(req);
      return {id,requirementId:req,target,bindingIds:bindings.map(b=>b.id)};};
    criteria=[...spec.crits.map(v=>parse(v,true)),...spec.outsides.map(v=>parse(v,false))];
  }
  const mapEntries=spec.maps;
  for(const entry of mapEntries) {const eq=entry.indexOf('='),id=entry.slice(0,eq),ids=entry.slice(eq+1).split(',');
    const criterion=criteria.find(c=>c.id===id);if(!criterion)throw new Error('MAP_CRITERION_NOT_FOUND: '+id);
    for(const bindingId of ids)if(!bindings.some(b=>b.id===bindingId))throw new Error('MAP_BINDING_NOT_FOUND: '+bindingId);
    criterion.bindingIds=ids;}
  const draft:TaskDefinition={contract:'harness-runtime/1',id:spec.taskId,revision:1,projectId:spec.projectId,authorId:spec.authorId,sessionId:spec.sessionId,
    requirementIds,criteria,bindings,inputPaths:[...inputs],
    ...(baseline?{baseline}:{}),
    policy:{id:`POLICY-${spec.taskId}`,reviewerIds:spec.reviewer?[spec.reviewer]:[],requireReview:Boolean(spec.reviewer),
      timeoutMs:spec.timeoutMs,maxOutputBytes:spec.maxOutputBytes,maxAttempts:spec.maxAttempts}};
  const task=parseTask(draft);
  const warnings=spec.reviewer?[]:['requireReview=false: pass --reviewer ID so completion is gated on independent review.'];
  if(spec.out)atomicWrite(safePath(spec.root,spec.out,true),JSON.stringify(task,null,2)+'\n');
  return {task,warnings};
}
