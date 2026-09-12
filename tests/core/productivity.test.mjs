import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordRun} from '../../dist/core/recorder.js';
import {Harness} from '../../dist/core/service.js';
import {operatorId} from '../../dist/cli/project.js';
import {scaffoldTask} from '../../dist/core/scaffold.js';
import {renderBoard} from '../../dist/core/board.js';
import {author, owner, reviewer, definition, project, service} from './helpers.mjs';

const bin = fileURLToPath(new URL('../../bin/harness.mjs', import.meta.url));
function commandTask(script, patch = {}) {
  const t = definition();
  t.bindings[0] = {...t.bindings[0], kind: 'command', argv: ['$NODE', '-e', script], selectors: [], expectedStdout: 'ok\n', ...patch};
  return t;
}
const cargo = spawnSync('cargo', ['--version'], {encoding: 'utf8'}).status === 0;

test('review prepare packages current evidence and records an audit trail', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  s.create(owner, definition());
  const r = await s.run(author, 'TASK-1', 'B-1');
  const result = s.reviewPrepare(owner, 'TASK-1', 'review-request.json');
  assert.equal(result.prepared, true); assert.deepEqual(result.runIds, [r.id]);
  const request = JSON.parse(readFileSync(join(root, 'review-request.json'), 'utf8'));
  assert.equal(request.runs.length, 1); assert.equal(request.taskId, 'TASK-1');
  assert.ok(request.prompt.length > 0); assert.match(request.prompt, /AC-1/);
  const records = s.export(owner, 'TASK-1').records.filter(x => x.kind === 'review-request');
  assert.equal(records.length, 1); assert.equal(records[0].origin, 'LOCAL');
  assert.equal(records[0].value.packageSha256, result.packageSha256);
});

test('review check validates verdict structure without opening the gate', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  s.create(owner, definition());
  const r = await s.run(author, 'TASK-1', 'B-1');
  const good = `AC coverage:\n| AC-1 | assertion observed in recorded run | PASS |\n\nRuns cited: ${r.id}\n\nVERDICT: PASS\n`;
  const checked = s.reviewCheck(owner, 'TASK-1', good);
  assert.equal(checked.check.wellFormed, true); assert.equal(checked.check.verdict, 'PASS');
  assert.deepEqual(checked.check.missingCriteria, []);
  assert.equal(s.export(owner, 'TASK-1').records.filter(x => x.kind === 'review-check').length, 1);
  assert.equal(s.assess(author, 'TASK-1').gateReady, false, 'a checked verdict is not a recorded Review');
  assert.throws(() => s.review(author, 'TASK-1', {verdict: 'PASS', summary: 'self-approved via bridge',
    criterionIds: ['AC-1'], runIds: [r.id]}), /REVIEWER|AUTHORIZED/);
  const malformed = [
    {text: 'no verdict line here', why: 'missing verdict'},
    {text: `AC coverage:\nRuns cited: ${r.id}\nVERDICT: PASS`, why: 'missing coverage row'},
    {text: `AC coverage:\n| AC-1 | x | PASS |\nRuns cited: 00000000-0000-4000-8000-000000000000\nVERDICT: PASS`, why: 'unknown run id'},
    {text: `AC coverage:\n| AC-1 | x | PASS |\nRuns cited: ${r.id}\nVERDICT: BLOCK`, why: 'BLOCK without count'},
    {text: `AC coverage:\n| AC-1 | x | PASS |\nRuns cited: ${r.id}\nVERDICT: BLOCK (2 finding)`, why: 'count mismatch'},
  ];
  for (const case_ of malformed) assert.equal(s.reviewCheck(owner, 'TASK-1', case_.text).check.wellFormed, false, case_.why);
});

test('scaffold generates a creatable command task end to end', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  writeFileSync(join(root, 'check.cjs'), "process.stdout.write('ok\\n');\n");
  const {task, warnings} = scaffoldTask({root, projectId: 'demo', authorId: author.id, sessionId: author.sessionId, taskId: 'SCAFFOLD-1',
    bindings: ['B-1=command:$NODE+check.cjs'], selectors: [], expects: ['B-1=0:ok\\n'], mutations: [], artifacts: [],
    inputs: [], maps: [], reqs: ['REQ-1'], crits: ['AC-1:REQ-1'], outsides: [], warns: [],
    timeoutMs: 30000, maxOutputBytes: 65536, maxAttempts: 2});
  assert.deepEqual(warnings.length, 1, 'unreviewed scaffolds warn');
  s.create(owner, task);
  const r = await s.run(author, 'SCAFFOLD-1', 'B-1');
  assert.equal(r.outcome, 'PASS');
  assert.equal(s.assess(author, 'SCAFFOLD-1').gateReady, true);
  assert.equal(s.complete(author, 'SCAFFOLD-1').state, 'COMPLETED');
});

test('scaffold refuses oracle-less commands and honors criterion maps', async t => {
  const root = project(t);
  writeFileSync(join(root, 'check.cjs'), '');
  assert.throws(() => scaffoldTask({root, projectId: 'demo', authorId: author.id, sessionId: author.sessionId, taskId: 'S-2',
    bindings: ['B-1=command:$NODE+check.cjs'], selectors: [], expects: [], mutations: [], artifacts: [], inputs: [], maps: [],
    reqs: ['REQ-1'], crits: ['AC-1:REQ-1'], outsides: [], warns: [], timeoutMs: 30000, maxOutputBytes: 65536, maxAttempts: 2}), /COMMAND_ORACLE_REQUIRED/);
  const {task} = scaffoldTask({root, projectId: 'demo', authorId: author.id, sessionId: author.sessionId, taskId: 'S-3',
    bindings: ['B-1=command:$NODE+check.cjs', 'B-2=node-test:sample.test.mjs'], selectors: ['B-2:sample.test.mjs::AC-pass'],
    expects: ['B-1=0:ok\\n'], mutations: [], artifacts: [], inputs: [], maps: ['AC-1=B-1', 'AC-2=B-2'],
    reqs: [], crits: ['AC-1', 'AC-2'], outsides: [], warns: [],
    timeoutMs: 30000, maxOutputBytes: 65536, maxAttempts: 2});
  assert.deepEqual(task.criteria[0].bindingIds, ['B-1']);
  assert.deepEqual(task.criteria[1].bindingIds, ['B-2']);
  assert.equal(task.inputPaths.includes('node_modules/vitest/vitest.mjs'), false);
});

test('scaffold reads an SRS catalog into requirements, criteria and baseline', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-scaffold-'))); t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'plans'), {recursive: true});
  const fixture = fileURLToPath(new URL('../../skills/requirements-spec/tests/fixtures/good.md', import.meta.url));
  writeFileSync(join(root, 'plans', 'spec.md'), readFileSync(fixture));
  writeFileSync(join(root, 'check.cjs'), "process.stdout.write('ok\\n');\n");
  const {task} = scaffoldTask({root, projectId: 'demo', authorId: author.id, sessionId: author.sessionId, taskId: 'SRS-TASK',
    bindings: ['B-1=command:$NODE+check.cjs'], selectors: [], expects: ['B-1=0:ok\\n'], mutations: [], artifacts: [], inputs: [], maps: [],
    srs: 'plans/spec.md', target: 'AC-001,AC-002', reqs: [], crits: [], outsides: [], warns: [],
    timeoutMs: 30000, maxOutputBytes: 65536, maxAttempts: 2});
  assert.deepEqual(task.requirementIds, ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005', 'REQ-006']);
  const targets = task.criteria.filter(c => c.target).map(c => c.id);
  assert.deepEqual(targets, ['AC-001', 'AC-002']);
  assert.equal(task.baseline.path, 'plans/spec.md');
  const s = service(root, join(root, '.harness', 'state.sqlite')); t.after(() => s.close());
  s.create(owner, task);
  const stored = s.export(owner, 'SRS-TASK').task.definition;
  assert.deepEqual(stored.criteria.filter(c => c.target).map(c => c.id), ['AC-001', 'AC-002']);
  assert.equal(s.assess(author, 'SRS-TASK').criteria.length, stored.criteria.length);
});

test('cargo-test binding collects real cargo observations', {skip: !cargo}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cargo-'))); t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n');
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'lib.rs'), '#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_works() { assert!(true); }\n    #[test]\n    fn broken() { assert!(false); }\n}\n');
  const inputs = ['Cargo.toml', 'src/lib.rs'];
  const binding = patch => ({id: 'C-1', profile: 'cargo-test', kind: 'cargo-test', argv: [], selectors: [], expectedExit: 0,
    expectedStdout: null, mutation: false, artifacts: [], ...patch});
  const def = patch => ({...definition(), policy: {...definition().policy, timeoutMs: 120000}, inputPaths: inputs,
    bindings: [binding(patch)]});
  const pass = await recordRun(root, def({argv: ['it_works'], selectors: ['tests::it_works']}), def({argv: ['it_works'], selectors: ['tests::it_works']}).bindings[0], author, {invocationId: randomUUID()});
  assert.equal(pass.outcome, 'PASS', JSON.stringify(pass.reasonCodes));
  assert.deepEqual(pass.tests.map(x => x.selector), ['tests::it_works']);
  const all = await recordRun(root, def({selectors: ['tests::it_works', 'tests::broken']}), def({}).bindings[0], author, {invocationId: randomUUID()});
  assert.equal(all.outcome, 'FAIL', 'the failing sibling test must fail the collection');
  assert.ok(all.tests.some(x => x.selector === 'tests::broken' && x.status === 'FAIL'));
  const missing = await recordRun(root, def({selectors: ['tests::never_written']}), def({selectors: ['tests::never_written']}).bindings[0], author, {invocationId: randomUUID()});
  assert.ok(missing.reasonCodes.includes('COLLECTION_INCOMPLETE'));
});

test('vitest binding pins its runner and rejects non-JSON reporter output', async t => {
  const root = project(t);
  mkdirSync(join(root, 'node_modules', 'vitest'), {recursive: true});
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'process.exit(0);\n');
  writeFileSync(join(root, 'ui.test.js'), '');
  const def = {...definition(), bindings: [{id: 'V-1', profile: 'vitest', kind: 'vitest', argv: ['ui.test.js'],
    selectors: ['ui.test.js::works'], expectedExit: 0, expectedStdout: null, mutation: false, artifacts: []}],
    inputPaths: ['sample.test.mjs', 'ui.test.js']};
  await assert.rejects(() => recordRun(root, def, def.bindings[0], author), /VITEST_RUNNER_NOT_PINNED/);
  const pinned = {...def, inputPaths: [...def.inputPaths, 'node_modules/vitest/vitest.mjs']};
  const r = await recordRun(root, pinned, pinned.bindings[0], author);
  assert.notEqual(r.outcome, 'PASS');
  assert.ok(r.reasonCodes.includes('VITEST_REPORTER_PROTOCOL'));
});

test('explain attributes stale inputs and missing evidence', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  s.create(owner, commandTask("console.log('ok')"));
  const before = s.explain(owner, 'TASK-1');
  assert.ok(before.criteria[0].detail.some(d => /No run has ever executed/.test(d)));
  await s.run(author, 'TASK-1', 'B-1');
  const current = s.explain(owner, 'TASK-1');
  assert.equal(current.criteria[0].freshness, 'CURRENT');
  assert.equal(current.criteria[0].staleInputs, null);
  writeFileSync(join(root, 'sample.test.mjs'), "import {test} from 'node:test'; test('AC-pass',()=>{assert.ok(true)});\n");
  const stale = s.explain(owner, 'TASK-1');
  assert.equal(stale.criteria[0].freshness, 'STALE');
  assert.deepEqual(stale.criteria[0].staleInputs.map(x => x.path), ['sample.test.mjs']);
  assert.match(stale.criteria[0].lastPass.runId, /[0-9a-f-]{36}/);
});

test('attempt budget accounting exposes remaining attempts', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  const d = commandTask("console.log('wrong')"); d.policy.maxAttempts = 2;
  s.create(owner, d);
  assert.equal(s.attemptsRemaining(owner, 'TASK-1', 'B-1'), 2);
  await s.run(author, 'TASK-1', 'B-1');
  assert.equal(s.attemptsRemaining(owner, 'TASK-1', 'B-1'), 1);
  await s.run(author, 'TASK-1', 'B-1');
  assert.equal(s.attemptsRemaining(owner, 'TASK-1', 'B-1'), 0);
  await assert.rejects(() => s.run(author, 'TASK-1', 'B-1'), /BUDGET/);
});

test('board summarizes tasks and renders escaped HTML', async t => {
  const root = project(t), s = service(root); t.after(() => s.close());
  s.create(owner, definition());
  await s.run(author, 'TASK-1', 'B-1');
  const board = s.board(owner);
  assert.equal(board.tasks.length, 1);
  const row = board.tasks[0];
  assert.equal(row.id, 'TASK-1'); assert.equal(row.state, 'WAITING_REVIEW');
  assert.equal(row.criteria.passed, 1); assert.equal(row.criteria.target, 1);
  assert.equal(row.gateReady, false); assert.equal(row.reviewMissing, 1);
  assert.ok(row.lastActivity);
  const html = renderBoard(board);
  assert.match(html, /gate closed/); assert.match(html, /TASK-1/); assert.match(html, /<!DOCTYPE html>/);
});

function lineReader(child) {
  const queue = []; let notify = null; let buffer = '';
  child.stdout.on('data', d => {
    buffer += d; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (notify) { const done = notify; notify = null; done(line); } else queue.push(line);
    }
  });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { notify = resolve; });
}

test('mcp stdio server answers initialize, tools list and read-only calls', async t => {
  const root = project(t);
  const {s, identity} = cliProject(t, root);
  s.create({...identity}, definition()); s.close();
  const child = spawn(process.execPath, [bin, 'mcp', '--root', root], {stdio: ['pipe', 'pipe', 'pipe']});
  const errors = [];
  child.stderr.on('data', d => errors.push(String(d)));
  t.after(() => { child.kill('SIGKILL'); });
  const next = lineReader(child);
  const call = payload => { child.stdin.write(JSON.stringify(payload) + '\n'); return next().then(JSON.parse); };
  const init = await call({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2024-11-05'}});
  assert.equal(init.error, undefined, 'server stderr: ' + errors.join(''));
  assert.equal(init.result.serverInfo.name, 'agent-harness-mcp');
  const tools = await call({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.deepEqual(tools.result.tools.map(x => x.name), ['harness_list', 'harness_status', 'harness_export', 'harness_board']);
  const listed = await call({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'harness_list', arguments: {}}});
  const board = JSON.parse(listed.result.content[0].text);
  assert.equal(board.tasks[0].id, 'TASK-1');
  const status = await call({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'harness_status', arguments: {taskId: 'TASK-1'}}});
  const explained = JSON.parse(status.result.content[0].text);
  assert.equal(explained.criteria[0].outcome, 'NOT_RUN');
  const bad = await call({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'harness_status', arguments: {taskId: 'NOPE'}}});
  assert.equal(bad.result.isError, true);
  child.stdin.end();
});

function cliProject(t, root) {
  mkdirSync(join(root, '.harness'), {recursive: true});
  const identity = {id: operatorId(), sessionId: randomUUID()};
  writeFileSync(join(root, '.harness', 'project.json'), JSON.stringify({contract: 'harness-local-project/1', projectId: 'demo',
    root: realpathSync(root), ownerId: identity.id, sessionId: identity.sessionId, mode: 'ASSISTED'}, null, 2) + '\n');
  const s = new Harness({root, projectId: 'demo', database: join(root, '.harness', 'state.sqlite'),
    authorize: (p, a) => p.id === identity.id && p.sessionId === identity.sessionId && a !== 'review'});
  t.after(() => { try { s.close(); } catch { /* already closed */ } });
  return {s, identity};
}

test('watch loop stops on budget exhaustion instead of spinning', async t => {
  const root = project(t), {s, identity} = cliProject(t, root);
  const d = commandTask("console.log('wrong')"); d.policy.maxAttempts = 1;
  d.authorId = identity.id; d.sessionId = identity.sessionId; s.create({...identity}, d); s.close();
  const child = spawnSync(process.execPath, [bin, 'watch', '--root', root, '--task', 'TASK-1', '--binding', 'B-1', '--interval', '1', '--max-seconds', '15'], {encoding: 'utf8', timeout: 30000});
  assert.match(child.stdout, /"watch": "ran"/, 'stderr: ' + child.stderr);
  assert.match(child.stdout, /budget-exhausted/);
  assert.equal(child.status, 1);
});

test('watch reports a gate closed only by review without burning attempts', async t => {
  const root = project(t), {s, identity} = cliProject(t, root);
  const d = definition(); d.authorId = identity.id; d.sessionId = identity.sessionId;
  s.create({...identity}, d);
  await s.run({...identity}, 'TASK-1', 'B-1');
  const remaining = s.attemptsRemaining({...identity}, 'TASK-1', 'B-1'); s.close();
  const child = spawnSync(process.execPath, [bin, 'watch', '--root', root, '--task', 'TASK-1', '--binding', 'B-1', '--interval', '1', '--max-seconds', '15'], {encoding: 'utf8', timeout: 30000});
  assert.match(child.stdout, /waiting-review/, 'stderr: ' + child.stderr);
  assert.equal(remaining, 2);
});
