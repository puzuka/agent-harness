import type {Assessment} from './types.js';

export interface BoardTask {id:string;state:string;revision:number;gateReady:boolean;releaseReady:false;
  criteria:{target:number;passed:number;stale:number;failed:number;blocked:number};
  reviewMissing:number;openIncidents:number;lastActivity:string|null;error:string|null}
export interface Board {contract:string;projectId:string;generatedAt:string;tasks:BoardTask[]}

const escape=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const badge=(text:string,tone:'ok'|'warn'|'bad'|'mute'):string=>`<span class="b ${tone}">${escape(text)}</span>`;

/** Static, dependency-free overview. Rendering is presentation only; the assessment JSON stays authoritative. */
export function renderBoard(board:Board):string {
  const rows=board.tasks.map(t=>{
    const c=t.criteria;
    const gate=t.error?'—':t.gateReady?badge('gate ready','ok'):badge('gate closed','warn');
    const review=t.reviewMissing?badge(`${t.reviewMissing} review missing`,'bad'):t.error?'':badge('review covered','ok');
    const incidents=t.openIncidents?badge(`${t.openIncidents} open incident`,'bad'):'';
    const detail=t.error?`<td class="err">${escape(t.error)}</td>`:
      `<td>${c.passed}/${c.target} pass${c.stale?` · ${badge(`${c.stale} stale`,'warn')}`:''}${c.failed?` · ${badge(`${c.failed} failed`,'bad')}`:''}${c.blocked?` · ${badge(`${c.blocked} blocked`,'mute')}`:''}</td>`;
    return `<tr><td class="id">${escape(t.id)}</td><td>${badge(t.state,t.state==='COMPLETED'?'ok':t.state==='BLOCKED'?'bad':'mute')}</td>`+
      `<td>r${t.revision}</td><td>${gate}</td>${detail}<td>${review}</td><td>${incidents}</td><td class="dim">${t.lastActivity?escape(t.lastActivity):'—'}</td></tr>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Harness Board — ${escape(board.projectId)}</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:#f6f8fb;color:#1f2937}
 header{background:linear-gradient(135deg,#4f46e5,#0ea5e9);color:#fff;padding:28px 32px}
 header h1{margin:0;font-size:22px}header p{margin:6px 0 0;opacity:.9;font-size:14px}
 main{padding:24px 32px 60px}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(31,41,55,.06)}
 th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #e5e9f0;font-size:14px;vertical-align:top}
 th{background:#eef2ff;color:#4f46e5;font-size:12px;letter-spacing:.4px;text-transform:uppercase}
 tr:last-child td{border-bottom:none}.id{font-weight:700;font-family:ui-monospace,Menlo,monospace}
 .dim{color:#5b6572}.err{color:#b91c1c;font-weight:600}
 .b{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;white-space:nowrap}
 .ok{background:#f0fdf4;color:#16a34a}.warn{background:#fffbeb;color:#b45309}.bad{background:#fef2f2;color:#b91c1c}.mute{background:#f1f5f9;color:#475569}
 footer{padding:0 32px 40px;color:#5b6572;font-size:12.5px}
</style></head><body>
<header><h1>🛡️ Agent Harness Board</h1><p>project <strong>${escape(board.projectId)}</strong> · generated ${escape(board.generatedAt)} · trust ASSISTED · releaseReady is always false</p></header>
<main><table>
<thead><tr><th>Task</th><th>State</th><th>Rev</th><th>Gate</th><th>Criteria (target)</th><th>Review</th><th>Incidents</th><th>Last activity</th></tr></thead>
<tbody>
${rows||'<tr><td colspan="8" class="dim">No tasks in this project yet. Create one with: harness new-task … then harness create --file …</td></tr>'}
</tbody></table></main>
<footer>Gate states are recomputed live from recorded evidence; a rendered board never certifies release. Stale = inputs changed after the evidence was recorded.</footer>
</body></html>`;
}
