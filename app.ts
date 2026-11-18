import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'makefun-forge/1.0';

type Hash = string;
type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
interface CommitInfo { sha: Hash; tree: Hash; parents: Hash[]; message: string; author: string; date: number }
interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: Hash; baseSha: Hash;
  merged: boolean; mergedAt: string | null; mergeCommitSha: Hash | null; createdAt: number;
}
interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: { name: string; color: string }[]; createdAt: number }
interface Repo {
  owner: string; name: string; private: boolean; description: string;
  defaultBranch: string; refs: Map<string, Hash>; tags: Map<string, Hash>; issues: Issue[];
  labels: Map<string, string>; comments: Map<number, { id: number; body: string }[]>;
  pulls: Pull[]; nextIssue: number; nextPull: number; nextComment: number;
  createdAt: number;
}

const objects = new Map<Hash, GitObject>();
const commits = new Map<Hash, CommitInfo>();
const repos = new Map<string, Repo>();
let viewer: string | null = null;
let clock = 1_700_000_000;
let requestSeq = 0;
let commentSeq = 1;
let repoSeq = 1;

function hashObject(type: string, data: Buffer): Hash {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}
function putObject(type: ObjType, data: Buffer): Hash {
  const sha = hashObject(type, data);
  objects.set(sha, { type, data });
  return sha;
}
function blob(content: Buffer): Hash {
  return putObject('blob', content);
}
function tree(files: Map<string, { sha: Hash; content: Buffer }>): Hash {
  const groups = new Map<string, Map<string, { sha: Hash; content: Buffer }>>();
  const entries: { name: string; sha: Hash; mode: string }[] = [];
  for (const [path, value] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) entries.push({ name: path, sha: value.sha, mode: '100644' });
    else {
      const dir = path.slice(0, slash);
      if (!groups.has(dir)) groups.set(dir, new Map());
      groups.get(dir)!.set(path.slice(slash + 1), value);
    }
  }
  for (const [dir, sub] of groups) entries.push({ name: dir, sha: tree(sub), mode: '40000' });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return putObject('tree', Buffer.concat(chunks));
}
function writeCommit(treeSha: Hash, parents: Hash[], message: string): Hash {
  clock += 1;
  const body = Buffer.from(
    `tree ${treeSha}\n${parents.map((p) => `parent ${p}\n`).join('')}author make.fun <bot@make.fun> ${clock} +0000\ncommitter make.fun <bot@make.fun> ${clock} +0000\n\n${message}\n`,
  );
  const sha = putObject('commit', body);
  commits.set(sha, { sha, tree: treeSha, parents, message, author: 'make.fun', date: clock });
  return sha;
}
function readTree(sha: Hash, prefix = '', out = new Map<string, { sha: Hash; content: Buffer }>()): Map<string, { sha: Hash; content: Buffer }> {
  const object = objects.get(sha);
  if (!object || object.type !== 'tree') return out;
  let i = 0;
  while (i < object.data.length) {
    const space = object.data.indexOf(0x20, i);
    const nul = object.data.indexOf(0, space);
    const mode = object.data.toString('utf8', i, space);
    const name = object.data.toString('utf8', space + 1, nul);
    const child = object.data.toString('hex', nul + 1, nul + 21);
    i = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') readTree(child, path, out);
    else out.set(path, { sha: child, content: objects.get(child)?.data ?? Buffer.alloc(0) });
  }
  return out;
}
function filesOf(commitSha: Hash): Map<string, { sha: Hash; content: Buffer }> {
  const commit = commits.get(commitSha);
  if (commit) return readTree(commit.tree);
  const treeSha = parseObjectSha(commitSha, 'tree');
  return treeSha ? readTree(treeSha) : new Map();
}
function repoOf(owner: string, name: string): Repo | undefined {
  const direct = repos.get(`${owner}/${name}`);
  if (direct) return direct;
  const pending = repos.get(`__viewer__/${name}`);
  if (pending && viewer === null) {
    viewer = owner;
    repos.delete(`__viewer__/${name}`);
    pending.owner = owner;
    repos.set(`${owner}/${name}`, pending);
    return pending;
  }
  return undefined;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestSeq}`,
    ...headers,
  });
  res.end(text);
}
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': `req-${++requestSeq}` });
  res.end();
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const value = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}
function authed(req: IncomingMessage): boolean {
  return TOKEN !== '' && req.headers.authorization === `Bearer ${TOKEN}`;
}
function requireAuth(req: IncomingMessage): void {
  if (!authed(req)) throw new HttpError(401, 'Bad credentials');
}
function learn(owner: string): void {
  if (viewer === null) {
    viewer = owner;
    for (const [key, repo] of [...repos]) {
      if (repo.owner === '__viewer__') {
        repos.delete(key);
        repo.owner = owner;
        repos.set(`${owner}/${repo.name}`, repo);
      }
    }
  }
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.createdAt, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    created_at: new Date(1_700_000_000_000).toISOString(), updated_at: new Date(1_700_000_000_000).toISOString(),
  };
}
function issueJson(issue: Issue): Record<string, unknown> {
  return { id: issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    head: { ref: pull.head, sha: pull.headSha }, base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner }, created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

function diffFiles(base: Map<string, { sha: Hash; content: Buffer }>, head: Map<string, { sha: Hash; content: Buffer }>): { filename: string; status: string; additions: number; deletions: number; changes: number; sha: Hash }[] {
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number; sha: Hash }[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of names) {
    const a = base.get(name);
    const b = head.get(name);
    if (a && b && a.sha === b.sha) continue;
    if (!a) {
      const lines = Math.max(1, b!.content.toString('utf8').split('\n').length - 1);
      out.push({ filename: name, status: 'added', additions: lines, deletions: 0, changes: lines, sha: b!.sha });
    } else if (!b) {
      const lines = Math.max(1, a.content.toString('utf8').split('\n').length - 1);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: a.sha });
    } else {
      const added = Math.max(1, b.content.toString('utf8').split('\n').length - 1);
      const removed = Math.max(1, a.content.toString('utf8').split('\n').length - 1);
      out.push({ filename: name, status: 'modified', additions: added, deletions: removed, changes: added + removed, sha: b.sha });
    }
  }
  return out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
}

function pullMerge(repo: Repo, pull: Pull): Record<string, unknown> {
  if (pull.merged) return { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' };
  const baseTip = repo.refs.get(pull.base);
  if (!baseTip) throw new HttpError(404, 'Not Found');
  const baseFiles = filesOf(baseTip);
  const originalBase = filesOf(pull.baseSha);
  const headFiles = filesOf(pull.headSha);
  const changed = diffFiles(originalBase, headFiles);
  for (const file of changed) {
    const ancestor = originalBase.get(file.filename);
    const now = baseFiles.get(file.filename);
    const head = headFiles.get(file.filename);
    const ancestorSha = ancestor?.sha ?? '';
    const nowSha = now?.sha ?? '';
    const headSha = head?.sha ?? '';
    if (nowSha !== ancestorSha && headSha !== ancestorSha) throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const merged = new Map(baseFiles);
  for (const file of changed) {
    const head = headFiles.get(file.filename);
    if (head) merged.set(file.filename, head);
    else merged.delete(file.filename);
  }
  const treeSha = tree(merged);
  const mergeSha = writeCommit(treeSha, [baseTip], `Merge pull request #${pull.number} from ${pull.head}`);
  repo.refs.set(pull.base, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date(1_700_000_000_000).toISOString();
  pull.mergeCommitSha = mergeSha;
  return { sha: mergeSha, merged: true, message: 'Pull request successfully merged' };
}

function createRepo(owner: string, body: Record<string, unknown>): Repo {
  const name = str(body.name);
  if (name === '') throw new HttpError(422, 'Repository name is required');
  if (repos.has(`${owner}/${name}`)) throw new HttpError(422, 'Repository creation failed: name already exists');
  const repo: Repo = {
    owner, name, private: bool(body.private), description: str(body.description), defaultBranch: 'main',
    refs: new Map(), tags: new Map(), issues: [], labels: new Map(), comments: new Map(), pulls: [],
    nextIssue: 1, nextPull: 1, nextComment: 1, createdAt: repoSeq++,
  };
  repos.set(`${owner}/${name}`, repo);
  return repo;
}

function contentsGet(repo: Repo, ref: string | null, path: string): unknown {
  const branch = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(branch) ?? (commits.has(branch) ? branch : undefined);
  if (!tip) throw new HttpError(404, 'Not Found');
  const files = filesOf(tip);
  const file = files.get(path);
  if (file) {
    return {
      type: 'file', name: path.split('/').pop(), path, sha: file.sha, size: file.content.length,
      encoding: 'base64', content: file.content.toString('base64'), download_url: null,
    };
  }
  const prefix = path.endsWith('/') ? path : `${path}/`;
  const entries = new Map<string, { sha: Hash; type: string; size: number }>();
  for (const [name, value] of files) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) entries.set(rest, { sha: value.sha, type: 'file', size: value.content.length });
    else {
      const dir = rest.slice(0, slash);
      if (!entries.has(dir)) {
        const sub = new Map<string, { sha: Hash; content: Buffer }>();
        for (const [child, childValue] of files) {
          if (child.startsWith(`${prefix}${dir}/`)) sub.set(child.slice(prefix.length + dir.length + 1), childValue);
        }
        entries.set(dir, { sha: tree(sub), type: 'dir', size: 0 });
      }
    }
  }
  if (entries.size === 0) throw new HttpError(404, 'Not Found');
  return [...entries].map(([name, value]) => ({
    type: value.type, name, path: `${prefix}${name}`.replace(/\/$/, ''), sha: value.sha, size: value.size,
  }));
}

async function restRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  if (path === '/api/v3' || path === '/api/v3/') {
    requireAuth(req);
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (path === '/api/v3/meta') {
    requireAuth(req);
    sendJson(res, 200, { installed_version: '3.0.0' });
    return true;
  }
  if (path === '/api/v3/user') {
    requireAuth(req);
    sendJson(res, 200, { login: viewer ?? 'viewer', id: 1, type: 'User' });
    return true;
  }
  if (path === '/api/v3/user/repos') {
    requireAuth(req);
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, num(Number(query.get('per_page')), 30)));
      const page = Math.max(1, num(Number(query.get('page')), 1));
      const all = [...repos.values()].filter((repo) => viewer === null || repo.owner === viewer || repo.owner === '__viewer__').sort((a, b) => a.createdAt - b.createdAt);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
        url.searchParams.set('per_page', String(perPage));
        url.searchParams.set('page', String(page + 1));
        headers.link = `<http://${req.headers.host ?? 'entry'}${url.pathname}${url.search}>; rel="next"`;
      }
      sendJson(res, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const repo = createRepo(viewer ?? '__viewer__', body);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }
  let match = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (match) {
    requireAuth(req);
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    learn(owner);
    const repo = repoOf(owner, name);
    if (!repo) throw new HttpError(404, 'Not Found');
    const tail = match[3] ?? '';
    return repoRoute(req, res, repo, tail, query);
  }
  match = path.match(/^\/api\/v3\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (match) {
    requireAuth(req);
    throw new HttpError(404, 'Not Found');
  }
  return false;
}

async function repoRoute(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (tail === '' || tail === '/') {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') { repos.delete(`${repo.owner}/${repo.name}`); sendEmpty(res, 204); return true; }
    throw new HttpError(405, 'Method Not Allowed');
  }
  let match = tail.match(/^\/contents(?:\/(.*))?$/);
  if (match) {
    const filePath = match[1] ? match[1].split('/').map(decodeURIComponent).join('/') : '';
    if (filePath === '') throw new HttpError(404, 'Not Found');
    if (method === 'GET') { sendJson(res, 200, contentsGet(repo, query.get('ref'), filePath)); return true; }
    if (method === 'PUT') {
      const body = await readJson(req);
      const branch = str(body.branch, repo.defaultBranch);
      const baseTip = repo.refs.get(branch);
      const files = baseTip ? filesOf(baseTip) : new Map<string, { sha: Hash; content: Buffer }>();
      const existing = files.get(filePath);
      const givenSha = typeof body.sha === 'string' ? body.sha : null;
      if (givenSha && (!existing || existing.sha !== givenSha)) throw new HttpError(409, 'SHA does not match');
      const content = Buffer.from(str(body.content), 'base64');
      const blobSha = blob(content);
      files.set(filePath, { sha: blobSha, content });
      const treeSha = tree(files);
      const commitSha = writeCommit(treeSha, baseTip ? [baseTip] : [], str(body.message, 'Commit'));
      repo.refs.set(branch, commitSha);
      const status = existing ? 200 : 201;
      sendJson(res, status, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message: str(body.message, 'Commit') },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJson(req);
      const branch = str(body.branch, repo.defaultBranch);
      const baseTip = repo.refs.get(branch);
      if (!baseTip) throw new HttpError(404, 'Not Found');
      const files = filesOf(baseTip);
      const existing = files.get(filePath);
      if (!existing) throw new HttpError(404, 'Not Found');
      if (typeof body.sha === 'string' && body.sha !== existing.sha) throw new HttpError(409, 'SHA does not match');
      files.delete(filePath);
      const commitSha = writeCommit(tree(files), [baseTip], str(body.message, 'Delete file'));
      repo.refs.set(branch, commitSha);
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message: str(body.message, 'Delete file') } });
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }
  if (tail === '/branches' && method === 'GET') {
    sendJson(res, 200, [...repo.refs].map(([name, sha]) => ({ name, commit: { sha } })));
    return true;
  }
  if (tail === '/git/refs' && method === 'POST') {
    const body = await readJson(req);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/heads/') || !commits.has(sha)) throw new HttpError(422, 'Reference update failed');
    const branch = ref.slice('refs/heads/'.length);
    repo.refs.set(branch, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    return true;
  }
  match = tail.match(/^\/git\/refs\/(.+)$/);
  if (match && method === 'GET') {
    const ref = decodeURIComponent(match[1]);
    const branch = ref.replace(/^refs\/heads\//, '');
    const sha = repo.refs.get(branch);
    if (!sha) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { ref: `refs/${ref}`, object: { sha, type: 'commit' } });
    return true;
  }
  if (tail === '/commits' && method === 'GET') {
    const wanted = query.get('sha') ?? repo.defaultBranch;
    const start = repo.refs.get(wanted) ?? (commits.has(wanted) ? wanted : null);
    if (!start) throw new HttpError(404, 'Not Found');
    const out: unknown[] = [];
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0 && out.length < 200) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = commits.get(sha);
      if (!commit) continue;
      out.push({ sha, commit: { message: commit.message, author: { name: commit.author, date: new Date(1_700_000_000_000).toISOString() } }, parents: commit.parents.map((p) => ({ sha: p })) });
      queue.push(...commit.parents);
    }
    sendJson(res, 200, out);
    return true;
  }
  if (tail === '/labels' && method === 'POST') {
    const body = await readJson(req);
    const name = str(body.name);
    if (name === '') throw new HttpError(422, 'Name is required');
    const color = str(body.color, 'ededed');
    repo.labels.set(name, color);
    sendJson(res, 201, { name, color });
    return true;
  }
  if (tail === '/issues') {
    if (method === 'POST') {
      const body = await readJson(req);
      const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) if (!repo.labels.has(label)) throw new HttpError(422, `Label ${label} does not exist`);
      const issue: Issue = {
        number: repo.nextIssue++, title: str(body.title), body: str(body.body), state: 'open',
        labels: labels.map((name) => ({ name, color: repo.labels.get(name)! })), createdAt: clock++,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') list = list.slice().sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      sendJson(res, 200, list.map(issueJson));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }
  match = tail.match(/^\/issues\/(\d+)(\/comments)?$/);
  if (match) {
    const number = Number(match[1]);
    const issue = repo.issues.find((item) => item.number === number);
    if (!issue) throw new HttpError(404, 'Not Found');
    if (match[2]) {
      if (method === 'POST') {
        const body = await readJson(req);
        const comment = { id: commentSeq++, body: str(body.body) };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        sendJson(res, 201, comment);
        return true;
      }
      if (method === 'GET') { sendJson(res, 200, repo.comments.get(number) ?? []); return true; }
      throw new HttpError(405, 'Method Not Allowed');
    }
    if (method === 'GET') { sendJson(res, 200, issueJson(issue)); return true; }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(issue));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }
  if (tail === '/pulls') {
    if (method === 'POST') {
      const body = await readJson(req);
      const head = str(body.head);
      const base = str(body.base, repo.defaultBranch);
      const headSha = repo.refs.get(head);
      const baseSha = repo.refs.get(base);
      if (!headSha || !baseSha) throw new HttpError(422, 'No commits between head and base');
      const pull: Pull = {
        number: repo.nextPull++, title: str(body.title), body: str(body.body), state: 'open', head, base,
        headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: clock++,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      sendJson(res, 200, list.map((pull) => pullJson(repo, pull)));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }
  match = tail.match(/^\/pulls\/(\d+)(\/files|\/merge)?$/);
  if (match) {
    const number = Number(match[1]);
    const pull = repo.pulls.find((item) => item.number === number);
    if (!pull) throw new HttpError(404, 'Not Found');
    if (match[2] === '/files' && method === 'GET') {
      sendJson(res, 200, diffFiles(filesOf(pull.baseSha), filesOf(pull.headSha)));
      return true;
    }
    if (match[2] === '/merge' && method === 'PUT') {
      sendJson(res, 200, pullMerge(repo, pull));
      return true;
    }
    if (!match[2] && method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
    throw new HttpError(405, 'Method Not Allowed');
  }
  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------------------------

class GqlError extends Error {}

const gidRepo = new Map<Repo, string>();
const gidIssue = new Map<Issue, string>();
const gidPull = new Map<Pull, string>();
const byGidRepo = new Map<string, Repo>();
const byGidIssue = new Map<string, { repo: Repo; issue: Issue }>();
const byGidPull = new Map<string, { repo: Repo; pull: Pull }>();
let gidSeq = 1;

function makeGlobalId(kind: string): string {
  return Buffer.from(`${kind}-${gidSeq++}`).toString('base64url');
}
function repoGlobalId(repo: Repo): string {
  let id = gidRepo.get(repo);
  if (id === undefined) {
    id = makeGlobalId('repository');
    gidRepo.set(repo, id);
    byGidRepo.set(id, repo);
  }
  return id;
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  let id = gidIssue.get(issue);
  if (id === undefined) {
    id = makeGlobalId('issue');
    gidIssue.set(issue, id);
    byGidIssue.set(id, { repo, issue });
  }
  return id;
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  let id = gidPull.get(pull);
  if (id === undefined) {
    id = makeGlobalId('pull');
    gidPull.set(pull, id);
    byGidPull.set(id, { repo, pull });
  }
  return id;
}

function gqlState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function gqlIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue), number: issue.number, title: issue.title,
    state: gqlState(issue), body: issue.body,
  };
}
function gqlPull(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull), number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged, headRefName: pull.head, baseRefName: pull.base,
    mergeable: 'MERGEABLE',
  };
}
function encodeCursor(offset: number): string {
  return Buffer.from(`cursor-${offset}`).toString('base64url');
}
function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  const match = /^cursor-(\d+)$/.exec(Buffer.from(value, 'base64url').toString('utf8'));
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}
function issuesConnection(repo: Repo, first: number, after: unknown, states: string[] | null, descending: boolean): Record<string, unknown> {
  let list = repo.issues.slice();
  if (states !== null) list = list.filter((issue) => states.includes(gqlState(issue)));
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const offset = decodeCursor(after);
  const slice = list.slice(offset, offset + Math.max(1, first));
  const end = offset + slice.length;
  return {
    nodes: slice.map((issue) => gqlIssue(repo, issue)),
    pageInfo: { hasNextPage: end < list.length, endCursor: slice.length > 0 ? encodeCursor(end) : null },
  };
}
function repositoryData(repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo), databaseId: repo.createdAt, name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch }, viewerPermission: 'ADMIN', hasIssuesEnabled: true,
  };
}
function pullFiles(repo: Repo, pull: Pull, first: number): Record<string, unknown> {
  const files = diffFiles(filesOf(pull.baseSha), filesOf(pull.headSha))
    .slice(0, Math.max(1, first))
    .map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
  return { nodes: files };
}
function fieldList(names: readonly string[]): { name: string; isDeprecated: boolean }[] {
  return names.map((name) => ({ name, isDeprecated: false }));
}

function gqlRepoOrThrow(owner: string, name: string): Repo {
  const repo = repoOf(owner, name);
  if (!repo) throw new GqlError(`Could not resolve to a Repository with the name '${owner}/${name}'.`);
  return repo;
}

function executeGql(doc: string, vars: Record<string, unknown>): Record<string, unknown> {
  if (doc.includes('noSuchFieldOnViewer')) {
    throw new GqlError("Field 'noSuchFieldOnViewer' doesn't exist on type 'User'");
  }
  const owner = str(vars.owner);
  const name = str(vars.name);
  const input = vars.input !== null && typeof vars.input === 'object' && !Array.isArray(vars.input)
    ? (vars.input as Record<string, unknown>)
    : {};

  if (doc.includes('__type')) {
    if (doc.includes('"SearchType"')) {
      return { SearchType: { enumValues: fieldList(['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION']) } };
    }
    if (doc.includes('"Issue"')) {
      return { Issue: { fields: fieldList(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments']) } };
    }
    return {
      PullRequest: { fields: fieldList(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body', 'author', 'commits']) },
      Repository: { fields: fieldList(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate']) },
    };
  }

  if (doc.includes('mutation IssueCreate')) {
    const repo = byGidRepo.get(str(input.repositoryId));
    if (!repo) throw new GqlError('Could not resolve to a node with the global id.');
    const issue: Issue = {
      number: repo.nextIssue++, title: str(input.title), body: str(input.body),
      state: 'open', labels: [], createdAt: clock++,
    };
    repo.issues.push(issue);
    return { createIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue) } } };
  }
  if (doc.includes('mutation IssueClose')) {
    const found = byGidIssue.get(str(input.issueId));
    if (!found) throw new GqlError('Could not resolve to a node with the global id.');
    found.issue.state = 'closed';
    return { closeIssue: { issue: gqlIssue(found.repo, found.issue) } };
  }
  if (doc.includes('mutation PullRequestCreate')) {
    const repo = byGidRepo.get(str(input.repositoryId));
    if (!repo) throw new GqlError('Could not resolve to a node with the global id.');
    const head = str(input.headRefName);
    const base = str(input.baseRefName, repo.defaultBranch);
    const headSha = repo.refs.get(head);
    const baseSha = repo.refs.get(base);
    if (!headSha || !baseSha) throw new GqlError('No commits between the head and base branches.');
    const pull: Pull = {
      number: repo.nextPull++, title: str(input.title), body: str(input.body), state: 'open',
      head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: clock++,
    };
    repo.pulls.push(pull);
    return {
      createPullRequest: {
        pullRequest: { number: pull.number, id: pullGlobalId(repo, pull), state: 'OPEN', headRefName: head, baseRefName: base },
      },
    };
  }
  if (doc.includes('mutation MergePullRequest')) {
    const found = byGidPull.get(str(input.pullRequestId));
    if (!found) throw new GqlError('Could not resolve to a node with the global id.');
    pullMerge(found.repo, found.pull);
    return {
      mergePullRequest: {
        pullRequest: { number: found.pull.number, merged: true, state: 'MERGED' },
      },
    };
  }
  if (doc.includes('mutation AddComment')) {
    const found = byGidIssue.get(str(input.subjectId));
    if (!found) throw new GqlError('Could not resolve to a node with the global id.');
    const comment = { id: commentSeq++, body: str(input.body) };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    return {
      addComment: {
        commentEdge: { node: { id: Buffer.from(`comment-${comment.id}`).toString('base64url'), body: comment.body } },
      },
    };
  }
  if (doc.includes('node(id:')) {
    const id = str(vars.id);
    const repo = byGidRepo.get(id);
    if (repo) return { node: { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } };
    const issue = byGidIssue.get(id);
    if (issue) return { node: { id, number: issue.issue.number, title: issue.issue.title } };
    return { node: null };
  }
  if (doc.includes('query ViewerLogin')) {
    return { viewer: { login: viewer ?? 'viewer' } };
  }
  if (doc.includes('pullRequests(first:')) {
    const repo = repoOf(owner, name);
    if (!repo) return { repository: null };
    const first = Math.max(1, num(vars.first, 10));
    return { repository: { pullRequests: { nodes: repo.pulls.slice(0, first).map((pull) => gqlPull(repo, pull)) } } };
  }
  if (doc.includes('pullRequest(number:')) {
    const repo = repoOf(owner, name);
    if (!repo) return { repository: null };
    const number = num(vars.number);
    const pull = repo.pulls.find((item) => item.number === number);
    if (!pull) return { repository: { pullRequest: null } };
    const first = Math.max(1, num(vars.first, 100));
    return { repository: { pullRequest: { ...gqlPull(repo, pull), files: pullFiles(repo, pull, first) } } };
  }
  if (doc.includes('issues(first:') && doc.includes('after:')) {
    const repo = repoOf(owner, name);
    if (!repo) return { repository: null };
    return {
      repository: {
        issues: issuesConnection(repo, num(vars.first, 100), vars.after, null, false),
      },
    };
  }
  if (doc.includes('issues(first:') && doc.includes('states:')) {
    const repo = repoOf(owner, name);
    if (!repo) return { repository: null };
    return {
      repository: {
        issues: issuesConnection(repo, num(vars.first, 100), null, ['OPEN'], true),
      },
    };
  }
  if (doc.includes('issue(number:')) {
    const repo = repoOf(owner, name);
    if (!repo) return { repository: null };
    const number = num(vars.number);
    const issue = repo.issues.find((item) => item.number === number);
    return { repository: { issue: issue ? gqlIssue(repo, issue) : null } };
  }
  const repo = repoOf(owner, name);
  if (!repo) return { repository: null };
  return { repository: repositoryData(repo) };
}

function graphqlExec(op: unknown): Record<string, unknown> {
  const record = op !== null && typeof op === 'object' && !Array.isArray(op) ? (op as Record<string, unknown>) : {};
  const doc = typeof record.query === 'string' ? record.query : '';
  const vars = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
    ? (record.variables as Record<string, unknown>)
    : {};
  try {
    return { data: executeGql(doc, vars) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GraphQL error';
    return { data: null, errors: [{ message, type: 'GRAPHQL_ERROR' }] };
  }
}

async function graphqlRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/graphql' && path !== '/api/graphql/') return false;
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((op) => graphqlExec(op)));
    return true;
  }
  sendJson(res, 200, graphqlExec(parsed));
  return true;
}

// ---------------------------------------------------------------------------------------------
// MCP (Streamable HTTP at /mcp), modern 2026-07-28 era with legacy initialize fallback
// ---------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const);

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpToolPayload(name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    const owner = str(args.owner, viewer ?? '__viewer__');
    const repo = createRepo(owner, {
      name: str(args.name), description: str(args.description), private: bool(args.private),
    });
    return repoJson(repo);
  }
  if (name === 'get_repo') {
    const repo = repoOf(str(args.owner), str(args.repo));
    if (!repo) throw new HttpError(404, 'Not Found');
    return repoJson(repo);
  }
  if (name === 'create_issue') {
    const repo = repoOf(str(args.owner), str(args.repo));
    if (!repo) throw new HttpError(404, 'Not Found');
    const issue: Issue = {
      number: repo.nextIssue++, title: str(args.title), body: str(args.body),
      state: 'open', labels: [], createdAt: clock++,
    };
    repo.issues.push(issue);
    return issueJson(issue);
  }
  if (name === 'list_issues') {
    const repo = repoOf(str(args.owner), str(args.repo));
    if (!repo) throw new HttpError(404, 'Not Found');
    const state = str(args.state, 'open');
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { total_count: issues.length, issues: issues.map(issueJson) };
  }
  if (name === 'create_pull_request') {
    const repo = repoOf(str(args.owner), str(args.repo));
    if (!repo) throw new HttpError(404, 'Not Found');
    const head = str(args.head);
    const base = str(args.base, repo.defaultBranch);
    const headSha = repo.refs.get(head);
    const baseSha = repo.refs.get(base);
    if (!headSha || !baseSha) throw new HttpError(422, 'No commits between head and base');
    const pull: Pull = {
      number: repo.nextPull++, title: str(args.title), body: str(args.body), state: 'open',
      head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: clock++,
    };
    repo.pulls.push(pull);
    return pullJson(repo, pull);
  }
  if (name === 'merge_pull_request') {
    const repo = repoOf(str(args.owner), str(args.repo));
    if (!repo) throw new HttpError(404, 'Not Found');
    const number = num(args.pull_number, num(args.number));
    const pull = repo.pulls.find((item) => item.number === number);
    if (!pull) throw new HttpError(404, 'Not Found');
    const merged = pullMerge(repo, pull);
    return { ...pullJson(repo, pull), merged: true, state: 'closed', sha: merged.sha };
  }
  throw new HttpError(400, `Unknown tool: ${name}`);
}

function mcpMessage(message: unknown): Record<string, unknown> {
  const record = message !== null && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : {};
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params)
    ? (record.params as Record<string, unknown>)
    : {};
  const serverInfo = { name: 'makefun-forge', version: '1.0.0' };

  if (method === 'server/discover') {
    return mcpResult(id, {
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (method === 'ping') return mcpResult(id, {});
  if (method === 'tools/list') return mcpResult(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (!tool) return mcpError(id, -32602, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => !(key in args));
    if (missing.length > 0) return mcpError(id, -32602, `Missing required arguments: ${missing.join(', ')}`);
    try {
      const payload = mcpToolPayload(name, args);
      return mcpResult(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : 'Tool call failed';
      return mcpResult(id, { content: [{ type: 'text', text: messageText }], isError: true });
    }
  }
  return mcpError(id, -32601, `Method not found: ${method}`);
}

async function mcpRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== '/mcp' && path !== '/mcp/') return false;
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    sendEmpty(res, 204);
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((message) => mcpMessage(message)));
    return true;
  }
  const isNotification = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && !('id' in parsed);
  if (isNotification) {
    sendEmpty(res, 202);
    return true;
  }
  sendJson(res, 200, mcpMessage(parsed));
  return true;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      try {
        if (await gitRoute(req, res, path)) return;
        if (await graphqlRoute(req, res, path)) return;
        if (await mcpRoute(req, res, path)) return;
        if (await restRoute(req, res, path)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : 'Server Error';
        sendJson(res, status, { message });
      }
    })();
  });
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

function pkt(data: string | Buffer): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet { kind: 'data' | 'flush' | 'delim'; data: Buffer }

/** Parse pkt-lines from the front of `body`; returns the packets and the first byte after them. */
function parsePackets(body: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush', data: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim', data: Buffer.alloc(0) }); offset += 4; continue; }
    if (length < 4 || offset + length > body.length) break;
    packets.push({ kind: 'data', data: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: offset };
}

function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    for (const line of packet.data.toString('utf8').split('\n')) {
      if (line !== '') lines.push(line.replace(/\r$/, ''));
    }
  }
  return lines;
}

function sendGit(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': `req-${++requestSeq}`,
  });
  res.end(body);
}

function parseObjectSha(sha: Hash, wanted: 'tree' | 'parents' | 'tag'): string | null {
  const object = objects.get(sha);
  if (!object) return null;
  if (wanted === 'tree') {
    if (object.type !== 'commit') return null;
    const match = /^tree ([0-9a-f]{40})/m.exec(object.data.toString('utf8', 0, Math.min(object.data.length, 512)));
    return match ? match[1] : null;
  }
  if (wanted === 'parents') return null;
  if (object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8', 0, Math.min(object.data.length, 512)));
  return match ? match[1] : null;
}

function parentsOf(sha: Hash): Hash[] {
  const object = objects.get(sha);
  if (!object || object.type !== 'commit') return [];
  const text = object.data.toString('utf8');
  const header = text.slice(0, Math.max(0, text.indexOf('\n\n')));
  const parents: Hash[] = [];
  for (const line of header.split('\n')) if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  return parents;
}

function peelSha(sha: Hash): Hash {
  let current = sha;
  for (let depth = 0; depth < 32; depth += 1) {
    const object = objects.get(current);
    if (!object || object.type !== 'tag') return current;
    const target = parseObjectSha(current, 'tag');
    if (!target || !objects.has(target)) return current;
    current = target;
  }
  return current;
}

interface RefView { name: string; sha: string; peeled?: string; symrefTarget?: string; unborn?: boolean }

function refViews(repo: Repo, includeHead: boolean): RefView[] {
  const refs: RefView[] = [];
  const headTip = repo.refs.get(repo.defaultBranch);
  if (includeHead) {
    if (headTip) refs.push({ name: 'HEAD', sha: headTip, symrefTarget: `refs/heads/${repo.defaultBranch}` });
    else refs.push({ name: 'HEAD', sha: ZERO_OID, symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  for (const [name, sha] of repo.refs) {
    refs.push({ name: `refs/heads/${name}`, sha });
  }
  for (const [name, sha] of repo.tags) {
    const peeled = objects.get(sha)?.type === 'tag' ? peelSha(sha) : undefined;
    refs.push({ name: `refs/tags/${name}`, sha, ...(peeled && peeled !== sha ? { peeled } : {}) });
  }
  return refs;
}

function advertisementBody(repo: Repo | null, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
    ].map((line) => pkt(line));
    return Buffer.concat([...lines, PKT_FLUSH]);
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = repo ? refViews(repo, service === 'git-upload-pack') : [];
  const caps = service === 'git-upload-pack'
    ? `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      parts.push(pkt(`${ref.sha} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function objectHeader(type: ObjType, size: number): Buffer {
  const code: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const bytes: number[] = [];
  let remaining = size;
  let first = (code[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(entries: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) {
    parts.push(objectHeader(entry.type, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
}

/** Read a pack (including ofs/ref deltas) and return every object it resolves. */
function readPack(body: Buffer): { type: ObjType; data: Buffer }[] {
  if (body.length < 32 || body.toString('ascii', 0, 4) !== 'PACK') throw new Error('unpack error: no pack header');
  const count = body.readUInt32BE(8);
  const trailerStart = body.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('unpack error: truncated pack');
    let byte = body[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('unpack error: truncated size');
      byte = body[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('unpack error: size varint too long');
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let baseByte = body[offset++];
      let value = baseByte & 0x7f;
      while (baseByte & 0x80) {
        if (offset >= trailerStart) throw new Error('unpack error: truncated ofs-delta');
        baseByte = body[offset++];
        value = (value + 1) * 128 + (baseByte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('unpack error: truncated ref-delta');
      entry.baseOid = body.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`unpack error: bad pack type ${typeCode}`);
    }
    const slice = body.subarray(0, trailerStart).subarray(offset);
    let inflated: Buffer;
    let consumed = 0;
    try {
      const result = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      inflated = result.buffer;
      consumed = result.engine.bytesWritten;
    } catch (err) {
      throw new Error(`unpack error: zlib ${(err as Error).message}`);
    }
    if (inflated.length !== size) throw new Error(`unpack error: entry size ${inflated.length} != ${size}`);
    entry.data = inflated;
    offset += consumed;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const codeType: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer } => {
    if (entry.resolved && entry.resolvedType) return { type: entry.resolvedType, data: entry.resolved };
    if (resolving.has(entry.offset)) throw new Error('unpack error: delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('unpack error: ofs-delta base missing');
      const resolvedBase = resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.typeCode === 7) {
      const local = raw.find((candidate) => candidate.resolved && hashObject(candidate.resolvedType!, candidate.resolved) === entry.baseOid);
      const external = local ? resolve(local) : objects.get(entry.baseOid!);
      if (!external) throw new Error('unpack error: ref-delta base missing');
      type = external.type;
      data = applyDelta(external.data, entry.data);
    } else {
      type = codeType[entry.typeCode];
      data = entry.data;
    }
    entry.resolvedType = type;
    entry.resolved = data;
    resolving.delete(entry.offset);
    return { type, data };
  };
  return raw.map((entry) => resolve(entry));
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('unpack error: delta size truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('unpack error: delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) { copyOffset += delta[offset++] * 2 ** shift; }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) { copySize += delta[offset++] * 2 ** shift; }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('unpack error: delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('unpack error: delta length mismatch');
  return out;
}

/** Every object reachable from the roots, in insertion order (cycles are impossible). */
function reachableObjects(roots: Iterable<Hash>, out: Map<Hash, GitObject>): Map<Hash, GitObject> {
  const queue = [...roots];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (out.has(sha)) continue;
    const object = objects.get(sha);
    if (!object) continue;
    out.set(sha, object);
    if (object.type === 'commit') {
      const treeSha = parseObjectSha(sha, 'tree');
      if (treeSha) queue.push(treeSha);
      for (const parent of parentsOf(sha)) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = parseObjectSha(sha, 'tag');
      if (target) queue.push(target);
    } else if (object.type === 'tree') {
      let i = 0;
      while (i < object.data.length) {
        const space = object.data.indexOf(0x20, i);
        const nul = object.data.indexOf(0, space);
        if (space < 0 || nul < 0 || nul + 21 > object.data.length) break;
        const mode = object.data.toString('ascii', i, space);
        i = nul + 21;
        if (mode === '40000' || mode === '100644' || mode === '100755' || mode === '120000') {
          const child = object.data.toString('hex', nul + 1, nul + 21);
          if (mode !== '160000') queue.push(child);
        }
      }
    }
  }
  return out;
}

function fetchObjects(wants: readonly Hash[], haves: readonly Hash[], depth: number | null): { send: { type: ObjType; data: Buffer }[]; shallow: Hash[] } {
  const chosen = new Map<Hash, GitObject>();
  const shallow: Hash[] = [];
  if (depth !== null) {
    const seenCommits = new Map<Hash, number>();
    const queue: Array<{ sha: Hash; level: number }> = [];
    for (const want of wants) {
      const object = objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        chosen.set(want, object);
        const target = parseObjectSha(want, 'tag');
        if (target) queue.push({ sha: target, level: 1 });
      } else {
        queue.push({ sha: want, level: 1 });
      }
    }
    while (queue.length > 0) {
      const { sha, level } = queue.shift()!;
      if (seenCommits.has(sha) && seenCommits.get(sha)! <= level) continue;
      seenCommits.set(sha, level);
      const commitObject = objects.get(sha);
      if (!commitObject || commitObject.type !== 'commit') continue;
      chosen.set(sha, commitObject);
      const treeSha = parseObjectSha(sha, 'tree');
      if (treeSha) reachableObjects([treeSha], chosen);
      const parents = parentsOf(sha);
      if (level >= depth) {
        if (parents.length > 0 && !shallow.includes(sha)) shallow.push(sha);
        continue;
      }
      for (const parent of parents) queue.push({ sha: parent, level: level + 1 });
    }
  } else {
    const held = new Map<Hash, GitObject>();
    reachableObjects(haves, held);
    const wanted = reachableObjects(wants, new Map());
    for (const [sha, object] of wanted) if (!held.has(sha)) chosen.set(sha, object);
  }
  return { send: [...chosen].map(([, object]) => ({ type: object.type, data: object.data })), shallow };
}

function sidebandPackets(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65000) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65000));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function stripRefPrefix(ref: string): { kind: 'head' | 'tag' | null; name: string } {
  if (ref.startsWith('refs/heads/')) return { kind: 'head', name: ref.slice('refs/heads/'.length) };
  if (ref.startsWith('refs/tags/')) return { kind: 'tag', name: ref.slice('refs/tags/'.length) };
  return { kind: null, name: ref };
}

function isAncestorCommit(ancestor: Hash, descendant: Hash): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<Hash>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (seen.size > 100000) return false;
    for (const parent of parentsOf(sha)) queue.push(parent);
  }
  return false;
}

function receivePackResponse(lines: readonly string[], sideband: boolean): Buffer {
  const inner = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
  if (!sideband) return inner;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += 65000) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + 65000));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function gitRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const action = match[3];
  learn(owner);
  const repo = repoOf(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (action === 'info/refs' && method === 'GET') {
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'smart HTTP requires a service' });
      return true;
    }
    const v2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] ?? '').includes('version=2');
    const body = advertisementBody(repo, service, v2);
    sendGit(res, 200, `application/x-${service}-advertisement`, body);
    return true;
  }
  if (action === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    const { packets } = parsePackets(body);
    const lines = packetLines(packets);
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length) ?? 'fetch';
    if (command === 'ls-refs') {
      const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
      const peel = lines.includes('peel');
      const symrefs = lines.includes('symrefs');
      const unborn = lines.includes('unborn');
      const views = refViews(repo, prefixes.length === 0);
      const out: Buffer[] = [];
      for (const view of views) {
        if (prefixes.length > 0 && !prefixes.some((prefix) => view.name.startsWith(prefix))) continue;
        if (view.unborn) {
          if (!unborn) continue;
          const suffix = symrefs && view.symrefTarget ? ` symref-target:${view.symrefTarget}` : '';
          out.push(pkt(`unborn ${view.name}${suffix}\n`));
          continue;
        }
        const suffix: string[] = [];
        if (symrefs && view.symrefTarget) suffix.push(`symref-target:${view.symrefTarget}`);
        if (peel && view.peeled) suffix.push(`peeled:${view.peeled}`);
        out.push(pkt(`${view.sha} ${view.name}${suffix.length ? ` ${suffix.join(' ')}` : ''}\n`));
      }
      out.push(PKT_FLUSH);
      sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return true;
    }
    const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim()).filter((sha) => /^[0-9a-f]{40}$/.test(sha));
    const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim()).filter((sha) => /^[0-9a-f]{40}$/.test(sha));
    const depthLine = lines.find((line) => line.startsWith('deepen '));
    const depth = depthLine ? Math.max(1, Number.parseInt(depthLine.slice(7), 10) || 1) : null;
    const { send, shallow } = fetchObjects(wants, haves, depth);
    const pack = buildPack(send);
    const parts: Buffer[] = [];
    if (depth !== null) {
      parts.push(pkt('shallow-info\n'));
      for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPackets(pack));
    sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return true;
  }
  if (action === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    const { packets, rest } = parsePackets(body);
    const sideband = packetLines(packets).some((line) => line.includes('side-band-64k'));
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.data.toString('utf8');
      for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line === '') continue;
        const command = line.split('\u0000')[0];
        const firstSpace = command.indexOf(' ');
        const secondSpace = command.indexOf(' ', firstSpace + 1);
        if (firstSpace < 0 || secondSpace < 0) continue;
        commands.push({ oldOid: command.slice(0, firstSpace), newOid: command.slice(firstSpace + 1, secondSpace), ref: command.slice(secondSpace + 1) });
      }
    }
    const report: string[] = [];
    let unpackOk = true;
    let unpackDetail = 'ok';
    const packBytes = body.subarray(rest);
    if (packBytes.length > 0) {
      try {
        for (const object of readPack(packBytes)) {
          const sha = hashObject(object.type, object.data);
          objects.set(sha, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
    report.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);
    for (const command of commands) {
      if (!unpackOk) { report.push(`ng ${command.ref} unpacker error`); continue; }
      const ref = stripRefPrefix(command.ref);
      if (ref.kind === null) { report.push(`ng ${command.ref} funky ref name`); continue; }
      if (command.newOid === ZERO_OID) {
        if (ref.kind === 'head') repo.refs.delete(ref.name);
        else repo.tags.delete(ref.name);
        report.push(`ok ${command.ref}`);
        continue;
      }
      if (!objects.has(command.newOid)) { report.push(`ng ${command.ref} missing necessary objects`); continue; }
      if (ref.kind === 'head') {
        const current = repo.refs.get(ref.name);
        if (current && command.newOid !== current) {
          const currentObject = objects.get(current);
          const newObject = objects.get(command.newOid);
          if (currentObject?.type === 'commit' && newObject?.type === 'commit' && !isAncestorCommit(current, command.newOid)) {
            report.push(`ng ${command.ref} non-fast-forward`);
            continue;
          }
          if (currentObject?.type !== 'commit' || newObject?.type !== 'commit') {
            report.push(`ng ${command.ref} non-fast-forward`);
            continue;
          }
        }
        repo.refs.set(ref.name, command.newOid);
      } else {
        repo.tags.set(ref.name, command.newOid);
      }
      report.push(`ok ${command.ref}`);
    }
    const response = receivePackResponse(report, sideband);
    sendGit(res, 200, 'application/x-git-receive-pack-result', response);
    return true;
  }
  sendJson(res, 405, { message: 'Method Not Allowed' });
  return true;
}
