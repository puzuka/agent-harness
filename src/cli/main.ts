import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safePath, redact } from '../core/files.js';
import { initialize, many, one, parseOptions, project, readInput, resolveRoot } from './project.js';
import { scaffoldTask } from '../core/scaffold.js';
import { renderBoard } from '../core/board.js';
import { serveMcp } from '../core/mcp.js';

const print = (value: unknown): void => { console.log(JSON.stringify(value, null, 2)); };
const number = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('OPTION_NUMBER_OUT_OF_RANGE');
  return parsed;
};
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

export async function main(argv: string[]): Promise<void> {
  const { command, options } = parseOptions(argv);
  if (command === 'help') {
    print({ commands: ['doctor', 'init --project ID [--apply]', 'identity', 'create --file task.json', 'new-task --task ID [spec options] [--out FILE]', 'review --task ID --prepare [--out FILE] | review --task ID --check --file verdict.md',
      'revise --task ID --file task.json', 'run --task ID --binding ID', 'status --task ID [--why]', 'watch --task ID --binding ID [--interval S] [--max-seconds S]', 'complete --task ID', 'cancel --task ID', 'recover --task ID', 'export --task ID', 'board [--out FILE]', 'mcp  (read-only MCP stdio server)', 'migrate --task ID --file legacy.json'],
      mode: 'ASSISTED', review: 'Independent review is host-owned. review --prepare/--check package and structurally validate verdicts; they cannot record a Review or manufacture a reviewer identity.' }); return;
  }
  if (command === 'doctor') {
    const root = resolveRoot(options), repo = fileURLToPath(new URL('../../', import.meta.url));
    const manifestPath = join(repo, 'dist/build-manifest.json');
    let current = false;
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { source: string; output: string; sourceSha256: string; outputSha256: string }[] };
      current = manifest.files.length > 0 && manifest.files.every(file => {
        try { return createHash('sha256').update(readFileSync(safePath(repo, file.source))).digest('hex') === file.sourceSha256 &&
          createHash('sha256').update(readFileSync(safePath(repo, file.output))).digest('hex') === file.outputSha256; } catch { return false; }
      });
    }
    const supported = Number(process.versions.node.split('.')[0]) >= 24;
    print({ runtime: process.version, runtimeSupported: supported, buildCurrent: current, projectInitialized: existsSync(join(root, '.harness/project.json')),
      trust: 'ASSISTED', nativePermissionEnforced: false, independentReview: 'HOST_INTEGRATION_REQUIRED', releaseReady: false });
    if (!supported || !current) process.exitCode = 1; return;
  }
  if (command === 'init') { print(initialize(options)); return; }
  const local = project(options), caller = local.caller;
  if (command === 'identity') { print({ caller, projectId: local.configuration.projectId, mode: 'ASSISTED' }); return; }
  const harness = local.open();
  try {
    if (command === 'create') { print(harness.create(caller, JSON.parse(readInput(local.root, options).text))); return; }
    if (command === 'new-task') {
      const taskId = one(options, 'task'); if (!taskId) throw new Error('TASK_OPTION_REQUIRED');
      const result = scaffoldTask({ root: local.root, projectId: local.configuration.projectId, authorId: caller.id, sessionId: caller.sessionId, taskId,
        bindings: many(options, 'binding'), selectors: many(options, 'selector'), expects: many(options, 'expect'), mutations: many(options, 'mutation'),
        artifacts: many(options, 'artifact'), inputs: many(options, 'input'), maps: many(options, 'map'),
        srs: one(options, 'srs'), target: one(options, 'target'), reqs: many(options, 'req'), crits: many(options, 'crit'),
        outsides: many(options, 'outside'), warns: many(options, 'warn'), reviewer: one(options, 'reviewer'),
        timeoutMs: number(one(options, 'timeout'), 120000, 10, 600000), maxOutputBytes: number(one(options, 'max-output'), 1048576, 1024, 16777216),
        maxAttempts: number(one(options, 'max-attempts'), 2, 1, 20), out: one(options, 'out') });
      for (const warning of result.warnings) console.error(JSON.stringify({ warning }));
      const out = one(options, 'out');
      print(out ? { writtenTo: out, id: result.task.id, revision: result.task.revision } : result.task);
      return;
    }
    if (command === 'review') {
      if (!options.task) throw new Error('TASK_OPTION_REQUIRED');
      const taskId = options.task as string;
      if (one(options, 'prepare')) {
        print(harness.reviewPrepare(caller, taskId, one(options, 'out'))); return;
      }
      if (one(options, 'check')) {
        options.file = one(options, 'check');
        const input = readInput(local.root, options);
        print(harness.reviewCheck(caller, taskId, input.text)); return;
      }
      throw new Error('REVIEW_MODE_REQUIRED: pass --prepare or --check');
    }
    if (command === 'board') {
      const board = harness.board(caller);
      const out = one(options, 'out');
      if (out) { const { writeFileSync } = await import('node:fs'); writeFileSync(safePath(local.root, out, true), renderBoard(board)); print({ writtenTo: out, tasks: board.tasks.length }); }
      else print(board);
      return;
    }
    if (command === 'mcp') {
      await serveMcp({
        serverInfo: { name: 'agent-harness-mcp', version: '0.1.0' },
        tools: [
          { name: 'harness_list', description: 'List every task in this project with gate summary (read-only).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          { name: 'harness_status', description: 'Explain a task acceptance state: per-criterion outcomes, why the gate is open or closed, and which inputs went stale.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
          { name: 'harness_export', description: 'Full task definition, immutable records and current assessment.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
          { name: 'harness_board', description: 'Board summary for every task (same data as harness board).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        ],
        call: (name, args) => {
          if (name === 'harness_list' || name === 'harness_board') return harness.board(caller);
          if (name === 'harness_status') return harness.explain(caller, String(args.taskId ?? ''));
          if (name === 'harness_export') return harness.export(caller, String(args.taskId ?? ''));
          throw new Error('UNKNOWN_TOOL');
        },
      });
      return;
    }
    if (!options.task) throw new Error('TASK_OPTION_REQUIRED');
    const taskId = options.task as string;
    if (command === 'revise') { print(harness.revise(caller, taskId, JSON.parse(readInput(local.root, options).text))); return; }
    if (command === 'run') {
      if (!options.binding) throw new Error('BINDING_OPTION_REQUIRED');
      const cancel = (): void => { try { harness.cancel(caller, taskId); } catch { /* state remains inspectable */ } };
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { const result = await harness.run(caller, taskId, options.binding as string); print(result); if (result.outcome !== 'PASS') process.exitCode = 1; }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); } return;
    }
    if (command === 'status') {
      if (one(options, 'why')) { const result = harness.explain(caller, taskId); print(result); if (!result.gateReady) process.exitCode = 2; return; }
      const result = harness.assess(caller, taskId); print(result); if (!result.gateReady) process.exitCode = 2; return;
    }
    if (command === 'watch') {
      if (!options.binding) throw new Error('BINDING_OPTION_REQUIRED');
      const bindingId = options.binding as string;
      const interval = number(one(options, 'interval'), 5, 1, 60);
      const deadline = Date.now() + number(one(options, 'max-seconds'), 1800, 10, 86400) * 1000;
      let stopped = false; const stop = (): void => { stopped = true; };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        while (!stopped && Date.now() < deadline) {
          const row = harness.get(caller, taskId);
          if (row.state === 'COMPLETED' || row.state === 'CANCELLED') { print({ watch: 'done', state: row.state }); return; }
          if (harness.assess(caller, taskId).gateReady) { print({ watch: 'gate-ready', taskId }); return; }
          const remaining = harness.attemptsRemaining(caller, taskId, bindingId);
          if (remaining <= 0) { print({ watch: 'budget-exhausted', hint: 'Revise the task (a new revision resets the attempt budget) or raise policy.maxAttempts.' }); process.exitCode = 1; return; }
          const assessment = harness.assess(caller, taskId);
          const evidenceDriven = assessment.criteria.some(c => c.freshness !== 'CURRENT' || (c.outcome !== 'PASS' && c.outcome !== 'NOT_RUN'));
          if (!evidenceDriven) { print({ watch: 'waiting-review', hint: 'Evidence is current; the open gate condition is not something another run can fix.', reasonCodes: assessment.reasonCodes }); return; }
          const run = await harness.run(caller, taskId, bindingId);
          const gateReady = harness.assess(caller, taskId).gateReady;
          print({ watch: 'ran', bindingId, outcome: run.outcome, reasonCodes: run.reasonCodes, gateReady, at: new Date().toISOString() });
          if (run.outcome !== 'PASS' && run.outcome !== 'FAIL') { process.exitCode = 1; return; }
          if (gateReady) { print({ watch: 'gate-ready', taskId }); return; }
          const nap = Math.min(interval, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
          for (let waited = 0; waited < nap && !stopped; waited++) await sleep(1000);
        }
        print({ watch: 'stopped', reason: stopped ? 'signal' : 'deadline' });
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      return;
    }
    if (command === 'complete') { print(harness.complete(caller, taskId)); return; }
    if (command === 'cancel') { print(harness.cancel(caller, taskId)); return; }
    if (command === 'recover') { print(harness.recover(caller, taskId)); return; }
    if (command === 'export') { print(harness.export(caller, taskId)); return; }
    if (command === 'migrate') {
      const input = readInput(local.root, options);
      if (redact(input.text) !== input.text) throw new Error('SECRET_LIKE_LEGACY_INPUT_REJECTED');
      const imported = harness.importLegacy(caller, taskId, { path: input.path, sha256: input.sha256, raw: input.text, parsed: JSON.parse(input.text) });
      print({ id: imported.id, assessment: imported.assessment, sourceHash: input.sha256 }); return;
    }
    throw new Error('UNKNOWN_COMMAND');
  } finally { harness.close(); }
}
