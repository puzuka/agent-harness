import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CONTRACT,type Assessment,type Criterion,type RunEvidence,type TaskDefinition} from './types.js';
import {array,id,integer,nullable,object,text,hash} from './schema.js';
import {digest,fileRef} from './files.js';
import type {StoredRecord} from './store.js';

export const REVIEW_REQUEST_CONTRACT='harness-review-request/1' as const;
const VERDICT_LINE=/^VERDICT: (PASS|BLOCK(?: \(\d+ findings?\)))$/;
const TAIL=4000;

export interface ReviewRequest {
  contract:typeof REVIEW_REQUEST_CONTRACT;taskId:string;taskDigest:string;candidateDigest:string;
  policy:{requireReview:boolean;reviewerIds:string[]};criteria:Criterion[];
  inputPaths:{path:string;sha256:string;bytes:number}[];
  runs:{id:string;taskId:string;bindingId:string;outcome:string;exitCode:number|null;finishedAt:string;
    tests:{selector:string;status:string}[];stdoutTail:string;stderrTail:string;reasonCodes:string[]}[];
  prompt:string;
}
const runSummarySchema=object({id,taskId:id,bindingId:id,outcome:text,exitCode:nullable(integer(0,255)),finishedAt:text,
  tests:array(object({selector:text,status:text}),0),stdoutTail:text,stderrTail:text,reasonCodes:array(text,0)});
export const reviewRequestSchema=object({
  contract:{const:REVIEW_REQUEST_CONTRACT},taskId:id,taskDigest:hash,candidateDigest:hash,
  policy:object({requireReview:{type:'boolean'},reviewerIds:array(id,0)}),
  criteria:array(object({id,requirementId:nullable(id),target:{type:'boolean'},bindingIds:array(id,0,true)}),1),
  inputPaths:array(object({path:text,sha256:hash,bytes:integer(0)}),1),
  runs:array(runSummarySchema,0),prompt:text});

export interface VerdictCheck {wellFormed:boolean;verdict:'PASS'|'BLOCK'|null;coverage:{id:string;status:string}[];
  missingCriteria:string[];unknownRunIds:string[];citedRunIds:string[];findingsCount:number;sha256:string}

const DEFAULT_PROMPT=`You are an independent REVIEWER. You do not know what the author intended.
Trust evidence only. Grade the acceptance criteria against the packaged runs.

## Inputs
- Task: {taskId} (digest {taskDigest}, candidate {candidateDigest})
- Criteria to cover: {criteria}
- Run evidence: see the packaged runs section.

## Required output
AC coverage:
| AC-ID | evidence note | PASS or BLOCK |
...one row per target criterion above...

Findings:
| # | severity (block/should fix/note) | finding | evidence | file:line | fix |

Runs cited: <comma-separated run ids from the packaged runs section>

Rules
- No courtesy praise. Every finding needs concrete evidence. "Looks right" is not evidence.
- Last line exactly one of: VERDICT: PASS (0 blocks and every criterion evidenced) or VERDICT: BLOCK (n finding).
`;

const tail=(value:string):string=>value.length>TAIL?value.slice(-TAIL):value;

export function buildRequest(root:string,task:TaskDefinition,candidateDigest:string,runs:RunEvidence[]):ReviewRequest {
  const template=join(root,'.agents/templates/reviewer-prompt.md');
  const criteria=structuredClone(task.criteria) as Criterion[];
  const prompt=(existsSync(template)?readFileSync(template,'utf8'):DEFAULT_PROMPT)
    .replaceAll('{taskId}',task.id).replaceAll('{taskDigest}',digest(task)).replaceAll('{candidateDigest}',candidateDigest)
    .replaceAll('{criteria}',criteria.filter(c=>c.target).map(c=>c.id).join(', '));
  return {contract:REVIEW_REQUEST_CONTRACT,taskId:task.id,taskDigest:digest(task),candidateDigest,
    policy:{requireReview:task.policy.requireReview,reviewerIds:[...task.policy.reviewerIds]},
    criteria,inputPaths:task.inputPaths.map(p=>fileRef(root,p)),
    runs:runs.map(r=>({id:r.id,taskId:r.taskId,bindingId:r.bindingId,outcome:r.outcome,exitCode:r.exitCode,finishedAt:r.finishedAt,
      tests:r.tests.map(t=>({selector:t.selector,status:t.status})),stdoutTail:tail(r.stdout),stderrTail:tail(r.stderr),reasonCodes:[...r.reasonCodes]})),
    prompt};
}

/** Structural check of an independent reviewer's verdict document. It never scores the product. */
export function checkVerdict(task:TaskDefinition,runIds:ReadonlySet<string>,verdictText:string):VerdictCheck {
  const lines=verdictText.split('\n').map(l=>l.trim()).filter(Boolean);
  const last=lines.at(-1)??'';const match=VERDICT_LINE.exec(last);
  const verdict=match?(match[1]==='PASS'?'PASS':'BLOCK'):null;
  const coverage:VerdictCheck['coverage']=[];
  const coverageRows=/^\|\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)\s*\|([^|]*)\|\s*(PASS|BLOCK)\s*\|$/gm;
  for(const m of verdictText.matchAll(coverageRows))coverage.push({id:m[1]!,status:m[3]!});
  const targetIds=task.criteria.filter(c=>c.target).map(c=>c.id);
  const missingCriteria=targetIds.filter(id=>!coverage.some(row=>row.id===id));
  const citedLine=lines.find(l=>/^runs? cited:/i.test(l))??'';
  const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const citedRunIds=citedLine?[...new Set(citedLine.match(uuid)??[])]:[];
  const unknownRunIds=citedRunIds.filter(runId=>!runIds.has(runId));
  const findingsMatch=/VERDICT: BLOCK \((\d+) findings?\)/.exec(last);
  const findingsCount=findingsMatch?Number(findingsMatch[1]):verdict==='BLOCK'?-1:0;
  const wellFormed=verdict!==null&&missingCriteria.length===0&&unknownRunIds.length===0&&citedRunIds.length>0&&
    (verdict==='PASS'?findingsCount===0:findingsCount>0)&&
    !(verdict==='BLOCK'&&coverage.every(row=>row.status==='PASS'));
  return {wellFormed,verdict,coverage,missingCriteria,unknownRunIds,citedRunIds,findingsCount,
    sha256:createHash('sha256').update(verdictText).digest('hex')};
}

export function requestRecord(taskId:string,request:ReviewRequest):StoredRecord {
  const value={at:new Date().toISOString(),packageSha256:digest(request),candidateDigest:request.candidateDigest,
    runIds:request.runs.map(r=>r.id),contract:REVIEW_REQUEST_CONTRACT};
  return {id:`review-request:${randomUUID()}`,kind:'review-request',taskId,
    value,hash:digest(value),origin:'LOCAL'};
}

export function checkRecord(taskId:string,taskDigest:string,check:VerdictCheck):StoredRecord {
  const value={at:new Date().toISOString(),verdictSha256:check.sha256,taskDigest,wellFormed:check.wellFormed,
    verdict:check.verdict,citedRunIds:check.citedRunIds,missingCriteria:check.missingCriteria,contract:'harness-review-check/1' as const};
  return {id:`review-check:${randomUUID()}`,kind:'review-check',taskId,value,hash:digest(value),origin:'LOCAL'};
}

/** Referenced so callers can assert the packaged evidence belongs to this contract family. */
export const CONTRACT_FAMILY=CONTRACT;
