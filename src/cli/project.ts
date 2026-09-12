import { existsSync, readFileSync, mkdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Harness } from '../core/service.js';
import { Store } from '../core/store.js';
import { safePath } from '../core/files.js';
import type { Principal } from '../core/types.js';

export interface Options { apply?: boolean; [key: string]: string | boolean | string[] | undefined }
export const one = (options: Options, key: string): string | undefined => { const v = options[key]; return typeof v === 'string' ? v : undefined; };
export const many = (options: Options, key: string): string[] => { const v = options[key]; return Array.isArray(v) ? v : typeof v === 'string' ? [v] : []; };
interface Configuration { contract: string; projectId: string; root: string; ownerId: string; sessionId: string; mode: 'ASSISTED' }
const REPEATABLE = new Set(['req', 'crit', 'outside', 'warn', 'binding', 'selector', 'expect', 'mutation', 'artifact', 'input', 'map']);
export function parseOptions(argv: string[]): { command: string; options: Options } {
  const [command = 'help', ...args] = argv, options: Options = {};
  const allowed = new Set(['root', 'project', 'file', 'task', 'binding', 'apply', 'out', 'prepare', 'check', 'why',
    'interval', 'max-seconds', 'srs', 'target', 'req', 'crit', 'outside', 'warn', 'selector', 'expect', 'mutation',
    'artifact', 'input', 'reviewer', 'timeout', 'max-output', 'max-attempts', 'map']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error('UNKNOWN_OR_DUPLICATE_OPTION');
    const key = flag.slice(2);
    if (key === 'apply') options[key] = true;
    else {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('OPTION_VALUE_REQUIRED');
      if (!REPEATABLE.has(key) && options[key] !== undefined) throw new Error('UNKNOWN_OR_DUPLICATE_OPTION');
      const existing = options[key];
      options[key] = existing === undefined || key === 'apply' ? value : [...(Array.isArray(existing) ? existing : [String(existing)]), value];
    }
  }
  return { command, options };
}
export function operatorId(): string {
  const user = userInfo();
  return 'local-' + createHash('sha256').update(`${user.username}|${user.uid}`).digest('hex').slice(0, 20);
}
export const resolveRoot = (options: Options): string => realpathSync(resolve(one(options, 'root') ?? process.cwd()));
export function initialize(options: Options): unknown {
  const root = resolveRoot(options), home = join(root, '.harness'), path = join(home, 'project.json'), projectId = one(options, 'project');
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)) throw new Error('PROJECT_ID_REQUIRED');
  if (existsSync(home) && lstatSync(home).isSymbolicLink()) throw new Error('PROJECT_STATE_SYMLINK');
  if (existsSync(path)) throw new Error('ALREADY_INITIALIZED: existing policy and history were not replaced');
  if (!options.apply) return { dryRun: true, destination: path, projectId, ownerId: operatorId() };
  const config: Configuration = { contract: 'harness-local-project/1', projectId, root, ownerId: operatorId(), sessionId: randomUUID(), mode: 'ASSISTED' };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const database = join(home, 'state.sqlite');
  if (existsSync(database)) throw new Error('EXISTING_STATE_WITHOUT_CONFIG: recover explicitly');
  const store = new Store(database); store.close();
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { initialized: true, ...config };
}
export function project(options: Options, readOnly = false): { root: string; caller: Principal; configuration: Configuration; open: () => Harness } {
  const root = resolveRoot(options), config = JSON.parse(readFileSync(safePath(root, '.harness/project.json'), 'utf8')) as Configuration;
  if (config.contract !== 'harness-local-project/1' || config.root !== root || config.ownerId !== operatorId() || config.mode !== 'ASSISTED' || !config.sessionId) throw new Error('PROJECT_POLICY_MISMATCH');
  const database = safePath(root, '.harness/state.sqlite', true);
  const caller = { id: config.ownerId, sessionId: config.sessionId };
  return { root, caller, configuration: config,
    open: () => new Harness({ root, projectId: config.projectId, database,
      authorize: (principal, action, subject) => principal.id === caller.id && principal.sessionId === caller.sessionId && subject.projectId === config.projectId &&
        (readOnly ? action === 'read' : action !== 'review') }) };
}
export function readInput(root: string, options: Options): { path: string; text: string; sha256: string } {
  const file = one(options, 'file');
  if (!file) throw new Error('FILE_OPTION_REQUIRED');
  const bytes = readFileSync(safePath(root, file));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('INPUT_SIZE_LIMIT');
  return { path: file, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
}
