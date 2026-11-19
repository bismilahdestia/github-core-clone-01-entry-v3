// REST v3 (/api/v3) handlers. Pure functions over the Forge store; the HTTP
// server in app.ts owns transport, auth and body parsing.
//
// Speed notes (v3): GET-one-issue answers from the issue's cached response
// *buffer* (issueBytes); issues and pull requests are found through the
// repo's by-number maps, never a scan; label colours come from a map; the
// commits endpoint and the pull-request file diff walk through the store's
// memoized commit parses instead of re-parsing; timestamps are formatted
// from epoch seconds by hand (isoForEpoch) instead of building a Date —
// Date.toISOString showed up on every create and every serialization, and
// the hand-rolled formatter is verified byte-identical against Date over
// the whole epoch range the forge can reach (see the v3 perf log).
import { Forge, VIEWER_LOGIN, VIEWER_ID, globalIdFor, bumpRefs, type Repo, type Issue, type PullReq } from './store.ts';
import { isOidString } from './git.ts';

/** One REST request: method, decoded path, query, and body. */
export interface Req {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: Query;
  /** Parsed JSON body (null when no body / not JSON). */
  json: unknown;
  /** Raw body bytes (for contents endpoints). */
  body: Buffer;
  host: string;
}

/**
 * A query string read lazily: the hot paths (GET one issue, POST one issue)
 * carry no query at all, so building a URLSearchParams per request was pure
 * waste. `get` scans the raw string and decodes only the value it returns.
 */
export interface Query {
  get(name: string): string | null;
}

/** Build a lazy Query over a raw query string ('' when absent). */
export function queryOf(raw: string): Query {
  return {
    get(name: string): string | null {
      if (raw === '') return null;
      const needle = `${name}=`;
      let at = raw.indexOf(needle);
      while (at >= 0) {
        // The name must start a parameter (start of string, or after '&').
        if (at === 0 || raw[at - 1] === '&') {
          let end = raw.indexOf('&', at);
          if (end < 0) end = raw.length;
          const encoded = raw.slice(at + needle.length, end);
          try {
            return decodeURIComponent(encoded.replace(/\+/g, ' '));
          } catch {
            return encoded;
          }
        }
        at = raw.indexOf(needle, at + 1);
      }
      return null;
    },
  };
}

/** One REST response: status, JSON body (or cached bytes), optional headers. */
export interface Resp {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const okResp = (status: number, body: unknown, headers?: Record<string, string>): Resp => ({ status, body, headers });
const errResp = (status: number, message: string): Resp => okResp(status, { message });
const nfResp = (): Resp => errResp(404, 'Not Found');

/** ISO timestamp for logical-clock sequence `seq` (epoch 1735689600 + seq). */
function isoForSeq(seq: number): string {
  return isoForEpoch(1735689600 + seq);
}

/**
 * Format an epoch second as an ISO-8601 UTC timestamp with milliseconds,
 * exactly as `new Date(epoch * 1000).toISOString()` renders it — but with
 * integer arithmetic only (Howard Hinnant's civil-from-days algorithm), no
 * Date object, no string parsing. The forge's clock only moves forward from
 * 1735689600, and the formatter is checked against Date in the v3 perf log.
 */
export function isoForEpoch(epoch: number): string {
  const days = Math.floor(epoch / 86400);
  const secs = epoch - days * 86400;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  const p2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${year}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:${p2(ss)}.000Z`;
}

/** The REST shape of a repository. `created_at` and `updated_at` share one seq. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const iso = isoForSeq(repo.seq);
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 + repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: iso,
    updated_at: iso,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

/** The REST shape of an issue. `created_at` and `updated_at` share one seq. */
export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  const iso = isoForSeq(issue.seq);
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labelColors.get(name) ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: iso,
    updated_at: iso,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

/**
 * The GET-one response bytes for an issue, cached on the issue as a Buffer
 * (with its length already known, so the transport never re-measures it).
 * The serialization depends only on the issue, its comment count and the
 * repo's label colors, so every mutation site (PATCH state, comment create,
 * label create, GraphQL close/comment) clears the cache; the cached bytes
 * are byte for byte what JSON.stringify(issueJson(...)) + '\n' produces.
 */
export function issueBytes(issue: Issue, repo: Repo): Buffer {
  if (issue.cachedBuf !== null) return issue.cachedBuf;
  const buf = Buffer.from(`${JSON.stringify(issueJson(issue, repo))}\n`, 'utf8');
  issue.cachedBuf = buf;
  return buf;
}

/** The REST shape of a pull request. `created_at` and `updated_at` share one seq. */
export function pullJson(pull: PullReq, repo: Repo): Record<string, unknown> {
  const iso = isoForSeq(pull.seq);
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: iso,
    updated_at: iso,
  };
}

/** The request's JSON body as an object ({} when it is not one). */
function objBody(ctx: Req): Record<string, unknown> {
  if (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

/** A value as a string, or '' when it is not a string. */
function strVal(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Decode a base64 body field; returns null when it is not valid base64 text. */
function b64decode(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  if (value === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/=\n\r]+$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/\n/g, ''), 'base64');
  } catch {
    return null;
  }
}

/** Route one REST request to its handler. */
export function handleRest(forge: Forge, ctx: Req): Resp {
  const { method, segments: s } = ctx;
  const get = method === 'GET';
  const post = method === 'POST';
  const put = method === 'PUT';
  const patch = method === 'PATCH';
  const del = method === 'DELETE';

  // GET /api/v3/ — the API root.
  if (s.length === 0) {
    if (!get) return nfResp();
    return okResp(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (!get) return nfResp();
    return okResp(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (!get) return nfResp();
    return okResp(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (post) {
      const body = objBody(ctx);
      const name = strVal(body.name);
      if (name === '') return errResp(422, 'name is required');
      if (forge.lookupRepo(VIEWER_LOGIN, name)) return errResp(422, 'Repository already exists');
      const repo = forge.addRepo(VIEWER_LOGIN, name, body.private === true, strVal(body.description));
      return okResp(201, repoJson(repo));
    }
    if (get) {
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '10') || 10));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = forge.ownedRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return okResp(200, slice.map(repoJson), headers);
    }
    return nfResp();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const repo = forge.lookupRepo(owner, name);
    const rest = s.slice(3);
    // A repository belongs to the token owner; any other owner is 404.
    if (!repo || owner !== VIEWER_LOGIN) return nfResp();

    if (rest.length === 0) {
      if (get) return okResp(200, repoJson(repo));
      if (patch) {
        const body = objBody(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        return okResp(200, repoJson(repo));
      }
      if (del) {
        forge.removeRepo(owner, name);
        return { status: 204, body: '' };
      }
      return nfResp();
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (post && rest.length === 2) {
        const body = objBody(ctx);
        const ref = strVal(body.ref);
        const sha = strVal(body.sha);
        if (!ref.startsWith('refs/heads/') || !isOidString(sha)) return errResp(422, 'invalid ref');
        if (!forge.getObj(repo, sha)) return errResp(422, 'unknown sha');
        const branch = ref.slice('refs/heads/'.length);
        repo.refs.set(branch, sha);
        bumpRefs(repo);
        return okResp(201, { ref, object: { sha } });
      }
      if (get && rest.length >= 3) {
        // GET /git/refs/heads/<branch>
        const ref = rest.slice(2).join('/');
        if (!ref.startsWith('heads/')) return nfResp();
        const branch = ref.slice('heads/'.length);
        const sha = repo.refs.get(branch);
        if (!sha) return nfResp();
        return okResp(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return nfResp();
    }

    // branches
    if (rest[0] === 'branches') {
      if (get && rest.length === 1) {
        const out: Record<string, unknown>[] = [];
        for (const [branch, sha] of repo.refs) {
          out.push({ name: branch, commit: { sha } });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return okResp(200, out);
      }
      if (get && rest.length === 2) {
        const sha = repo.refs.get(rest[1] as string);
        if (!sha) return nfResp();
        return okResp(200, { name: rest[1], commit: { sha } });
      }
      return nfResp();
    }

    // commits
    if (rest[0] === 'commits') {
      if (!get) return nfResp();
      const refName = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, refName);
      if (tip === '') return okResp(200, []);
      const commits = forge.walkCommits(repo, tip).map((oid) => {
        const c = forge.commitData(repo, oid);
        return { sha: oid, commit: { message: c ? c.message : '' } };
      });
      return okResp(200, commits);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refName = ctx.query.get('ref') ?? repo.defaultBranch;
      if (put) return writeContent(forge, repo, ctx, path, refName);
      if (del) return removeContent(forge, repo, ctx, path, refName);
      if (get) return readContent(forge, repo, path, refName);
      return nfResp();
    }

    // labels
    if (rest[0] === 'labels') {
      if (post && rest.length === 1) {
        const body = objBody(ctx);
        const name = strVal(body.name);
        if (name === '') return errResp(422, 'name is required');
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const existing = repo.labelColors.get(name);
        if (existing !== undefined) return okResp(201, { name, color: existing });
        forge.addLabel(repo, name, color);
        forge.dropIssueJson(repo);
        return okResp(201, { name, color });
      }
      if (get && rest.length === 1) {
        return okResp(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
      }
      return nfResp();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (post) return newIssue(forge, repo, ctx);
        if (get) return listIssues(forge, repo, ctx);
        return nfResp();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return nfResp();
      const issue = repo.issueByNum.get(num);
      if (rest.length === 2) {
        if (!issue) return nfResp();
        if (get) return okResp(200, issueBytes(issue, repo));
        if (patch) {
          const body = objBody(ctx);
          if (body.state === 'closed') issue.state = 'closed';
          else if (body.state === 'open') issue.state = 'open';
          forge.dropIssueJson(repo);
          return okResp(200, issueJson(issue, repo));
        }
        return nfResp();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return nfResp();
        if (post) {
          const body = objBody(ctx);
          const text = strVal(body.body);
          if (text === '') return errResp(422, 'body is required');
          const id = repo.nextCommentId;
          repo.nextCommentId += 1;
          const { seq } = forge.tickClock();
          const note = { id, globalId: globalIdFor('C', id), body: text, seq };
          issue.comments.push(note);
          forge.dropIssueJson(repo);
          return okResp(201, { id, node_id: note.globalId, body: text });
        }
        if (get) {
          return okResp(200, issue.comments.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body })));
        }
        return nfResp();
      }
      return nfResp();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (post) return newPull(forge, repo, ctx);
        if (get) return listPulls(forge, repo, ctx);
        return nfResp();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return nfResp();
      const pull = repo.pullByNum.get(num);
      if (rest.length === 2) {
        if (!pull) return nfResp();
        if (get) return okResp(200, pullJson(pull, repo));
        return nfResp();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return nfResp();
        if (!get) return nfResp();
        return okResp(200, pullFiles(forge, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return nfResp();
        if (!put) return nfResp();
        return doMerge(forge, repo, pull, ctx);
      }
      return nfResp();
    }

    return nfResp();
  }

  return nfResp();
}

// ---------------------------------------------------------------- contents

/** PUT /contents/:path — create or update a file (base64 content, new commit). */
function writeContent(forge: Forge, repo: Repo, ctx: Req, path: string, refName: string): Resp {
  const body = objBody(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const content = b64decode(body.content);
  if (content === null) return errResp(422, 'content must be base64');
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const tip = repo.refs.get(branch) ?? '';
  const existing = tip === '' ? undefined : forge.lookup(repo, forge.treeAt(repo, branch), path);
  if (typeof body.sha === 'string' && body.sha !== '') {
    if (!existing || existing.oid !== body.sha) return errResp(409, 'sha does not match the current file');
  }
  const isUpdate = existing !== undefined;
  const blobOid = forge.putObj(repo, 'blob', content);
  const baseTree = forge.treeAt(repo, branch);
  const newTree = forge.setPath(repo, baseTree, path, blobOid);
  const commitOid = forge.commitNew(repo, branch, newTree, message);
  return okResp(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

/** DELETE /contents/:path — remove a file (new commit). */
function removeContent(forge: Forge, repo: Repo, ctx: Req, path: string, refName: string): Resp {
  const body = objBody(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const tip = repo.refs.get(branch) ?? '';
  if (tip === '') return nfResp();
  const existing = forge.lookup(repo, forge.treeAt(repo, branch), path);
  if (!existing) return nfResp();
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
    return errResp(409, 'sha does not match the current file');
  }
  const baseTree = forge.treeAt(repo, branch);
  const newTree = forge.setPath(repo, baseTree, path, null);
  const commitOid = forge.commitNew(repo, branch, newTree, message);
  return okResp(200, { commit: { sha: commitOid, message } });
}

/** GET /contents/:path — a file (base64), a directory listing, or the root listing. */
function readContent(forge: Forge, repo: Repo, path: string, refName: string): Resp {
  const treeOid = forge.treeAt(repo, refName);
  if (treeOid === '') return nfResp();
  if (path === '') {
    const entries = forge.listDir(repo, treeOid, '');
    if (!entries) return nfResp();
    return okResp(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.name,
      sha: e.oid,
    })));
  }
  const entry = forge.lookup(repo, treeOid, path);
  if (!entry) return nfResp();
  if (entry.mode === '40000') {
    const entries = forge.listDir(repo, treeOid, path);
    if (!entries) return nfResp();
    return okResp(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
    })));
  }
  const obj = forge.getObj(repo, entry.oid);
  if (!obj || obj.kind !== 'blob') return nfResp();
  return okResp(200, {
    type: 'file',
    encoding: 'base64',
    content: obj.content.toString('base64'),
    sha: entry.oid,
    size: obj.content.length,
    name: path.split('/').pop() ?? path,
    path,
  });
}

// ---------------------------------------------------------------- issues

/** POST /issues — create an issue (labels must already exist). */
function newIssue(forge: Forge, repo: Repo, ctx: Req): Resp {
  const body = objBody(ctx);
  const title = strVal(body.title);
  if (title === '') return errResp(422, 'title is required');
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labelColors.has(label)) return errResp(422, `label ${label} does not exist`);
  }
  const number = repo.nextIssueNum;
  repo.nextIssueNum += 1;
  const id = number;
  const { seq } = forge.tickClock();
  const issue: Issue = {
    id,
    globalId: globalIdFor('I', repo.id * 100000 + number),
    number,
    title,
    body: strVal(body.body),
    state: 'open',
    labels,
    seq,
    comments: [],
    cachedBuf: null,
  };
  forge.addIssue(repo, issue);
  return okResp(201, issueJson(issue, repo));
}

/** GET /issues — list issues, filtered by state, sorted by creation seq. */
function listIssues(forge: Forge, repo: Repo, ctx: Req): Resp {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = repo.issues.slice();
  if (state !== 'all') list = list.filter((i) => i.state === state);
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  return okResp(200, list.slice(start, start + perPage).map((i) => issueJson(i, repo)));
}

// ---------------------------------------------------------------- pulls

/** POST /pulls — open a pull request between two existing branches. */
function newPull(forge: Forge, repo: Repo, ctx: Req): Resp {
  const body = objBody(ctx);
  const head = strVal(body.head);
  const base = strVal(body.base);
  if (head === '' || base === '') return errResp(422, 'head and base are required');
  const headSha = repo.refs.get(head);
  const baseSha = repo.refs.get(base);
  if (!headSha || !baseSha) return errResp(422, 'head or base branch does not exist');
  const number = repo.nextPullNum;
  repo.nextPullNum += 1;
  const id = number;
  const { seq } = forge.tickClock();
  const pull: PullReq = {
    id,
    globalId: globalIdFor('PR', repo.id * 100000 + number),
    number,
    title: strVal(body.title),
    body: strVal(body.body),
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq,
  };
  forge.addPull(repo, pull);
  return okResp(201, pullJson(pull, repo));
}

/** GET /pulls — list pull requests, open by default, by number ascending. */
function listPulls(forge: Forge, repo: Repo, ctx: Req): Resp {
  const state = ctx.query.get('state') ?? 'open';
  let list = repo.pullReqs.slice();
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => a.number - b.number);
  return okResp(200, list.map((p) => pullJson(p, repo)));
}

/** GET /pulls/:n/files — the changed files with line counts. */
function pullFiles(forge: Forge, repo: Repo, pull: PullReq): Record<string, unknown>[] {
  // Diff the trees at the PR's recorded base sha and its head tip.
  const baseTip = pull.baseSha;
  const headTip = forge.resolveRef(repo, `refs/heads/${pull.headRef}`);
  const baseTreeOid = treeOf(forge, repo, baseTip);
  const headTreeOid = headTip === '' ? '' : treeOf(forge, repo, headTip);
  const diff = forge.diffTrees(repo, baseTreeOid, headTreeOid);
  const out: Record<string, unknown>[] = [];
  const paths = [...diff.keys()].sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const status = diff.get(path) as 'added' | 'modified' | 'deleted';
    const oldEntry = status === 'added' ? undefined : forge.lookup(repo, baseTreeOid, path);
    const newEntry = status === 'deleted' ? undefined : forge.lookup(repo, headTreeOid, path);
    const stats = forge.lineStats(repo, oldEntry?.oid, newEntry?.oid);
    out.push({
      filename: path,
      status: status === 'modified' ? 'modified' : status,
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.additions + stats.deletions,
    });
  }
  return out;
}

/** The tree oid of a commit, or '' when the commit is unknown. */
export function treeOf(forge: Forge, repo: Repo, commitOid: string): string {
  return forge.commitData(repo, commitOid)?.tree ?? '';
}

/** Squash-merge a pull request. Returns the merge sha, or an error status/message. */
export function mergeSquash(
  forge: Forge,
  repo: Repo,
  pull: PullReq,
): { status: number; sha?: string; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'pull request is not open' };
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '') return { status: 422, message: 'head or base branch is missing' };
  const headTree = treeOf(forge, repo, headTip);
  const baseAtPrTree = treeOf(forge, repo, pull.baseSha);
  const baseNowTree = treeOf(forge, repo, currentBaseTip);
  const prChanged = forge.diffTrees(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTrees(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return { status: 405, message: 'merge conflict' };
  }
  const { epoch } = forge.tickClock();
  const iso = isoForEpoch(epoch);
  const person = `${VIEWER_LOGIN} <adaiversen@example.invalid> ${epoch} +0000`;
  const lines = [
    `tree ${headTree}`,
    `parent ${currentBaseTip}`,
    `author ${person}`,
    `committer ${person}`,
    '',
    pull.title === '' ? `Merge pull request #${pull.number}` : pull.title,
  ];
  const content = Buffer.from(lines.join('\n'), 'utf8');
  const mergeSha = forge.putObj(repo, 'commit', content);
  repo.refs.set(pull.baseRef, mergeSha);
  bumpRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  return { status: 200, sha: mergeSha, message: `Pull request #${pull.number} merged` };
}

/** True when a pull request would conflict with the current base branch. */
export function hasConflict(forge: Forge, repo: Repo, pull: PullReq): boolean {
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '' || pull.baseSha === currentBaseTip) return false;
  const headTree = treeOf(forge, repo, headTip);
  const baseAtPrTree = treeOf(forge, repo, pull.baseSha);
  const baseNowTree = treeOf(forge, repo, currentBaseTip);
  const prChanged = forge.diffTrees(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTrees(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return true;
  }
  return false;
}

/** PUT /pulls/:n/merge — squash-merge (merge/rebase methods map to the same squash). */
function doMerge(forge: Forge, repo: Repo, pull: PullReq, ctx: Req): Resp {
  const body = objBody(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return errResp(422, 'unknown merge_method');
  }
  if (!repo.pullReqs.includes(pull)) return nfResp();
  const result = mergeSquash(forge, repo, pull);
  if (result.status !== 200 || !result.sha) return errResp(result.status, result.message);
  return okResp(200, { sha: result.sha, merged: true, message: result.message });
}
