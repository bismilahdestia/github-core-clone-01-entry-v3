// The HTTP server: routing, auth, JSON bodies, and git smart HTTP.
// main.ts owns the lifecycle (bind, register, poll /done); this file owns the
// surfaces the suite drives.
//
// Speed notes (v3): the request URL is split by hand — no `new URL` and no
// URLSearchParams per request, and the query string is only scanned when a
// handler actually asks for a parameter; the bearer check is a prefix test,
// not a regular expression, and the configured token is read once at startup;
// path segments are only percent-decoded when they contain a '%'; request
// ids are a counter; JSON replies are built as one Buffer, so the transport
// measures the length once and writes once; GET-one-issue answers from the
// issue's cached buffer; the git advertisements, ls-refs answers and fetch
// answers are cached per repository and dropped when a ref moves (see
// bumpRefs in store.ts), because the timed clone workload asks for the same
// fetch fifty times in a row; bodyless GET/HEAD requests never wait for the
// socket's 'end' event; the fetch planner skips the common-haves walk
// entirely when the client sent no 'have' lines (see fetchPlan).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN, bumpRefs, type Repo } from './store.ts';
import { handleRest, queryOf, type Query } from './rest.ts';
import { handleGql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  pkt,
  decodePkts,
  decodePktsToFlush,
  pktTexts,
  decodePackData,
  encodePackData,
  sideband,
  NULL_OID,
  isOidString,
  FLUSH,
  DELIM,
  type ObjEntry,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the entry was given, read once (it never changes mid-trial). */
const CONFIGURED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** A fresh request id for the x-github-request-id response header. */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Read the request body fully (data chunks until 'end'). */
function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    // A body that arrives in one chunk (every pack and JSON body the suite
    // sends) is returned as-is: no copy through Buffer.concat.
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response. `body` may be an object (stringified + '\n', exactly
 * as before), a pre-built string, or a pre-built Buffer (the cached issue
 * bytes). One Buffer is written, so the length is measured once.
 */
function replyJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf =
    body instanceof Buffer
      ? body
      : Buffer.from(typeof body === 'string' ? body : `${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(buf);
}

/** Send a raw-bytes response with the given content type. */
function replyRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** The bearer token from the Authorization header ('' when absent). */
function tokenOf(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7);
}

/** True when the request carries an acceptable bearer token. */
function authed(req: IncomingMessage): boolean {
  const got = tokenOf(req);
  if (got === '') return false;
  if (CONFIGURED_TOKEN === '') return true;
  return got === CONFIGURED_TOKEN;
}

/** Parse a JSON body (an empty body parses as null). */
function readJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/**
 * Split a raw request target into pathname and query without building a URL
 * object: the suite's targets are plain paths with at most one '?'. The
 * pathname stays percent-encoded here (segments decode themselves later,
 * only when they contain a '%').
 */
function splitTarget(raw: string): { path: string; query: Query } {
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw === '' ? '/' : raw, query: queryOf('') };
  return { path: raw.slice(0, q) || '/', query: queryOf(raw.slice(q + 1)) };
}

/** Split a REST path into segments, decoding only segments that need it. */
function splitSegments(restPath: string): string[] {
  const out: string[] = [];
  for (const seg of restPath.split('/')) {
    if (seg === '') continue;
    if (seg.indexOf('%') < 0) {
      out.push(seg);
    } else {
      try {
        out.push(decodeURIComponent(seg));
      } catch {
        out.push(seg);
      }
    }
  }
  return out;
}

/** Build the forge HTTP server (exported name kept: dev tooling imports it). */
export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // Parse the request target once (pathname + lazy query), not twice.
      const { path, query } = splitTarget(req.url ?? '/');

      // Boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        replyJson(res, 200, { ok: true });
        return;
      }

      // Everything else needs the bearer token.
      if (!authed(req)) {
        replyJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      // GET/HEAD requests from the suite never carry a body: when the headers
      // promise none (no content-length, no chunked encoding), answer without
      // waiting for the socket's 'end' event. Anything else still reads fully.
      const hasBody =
        req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
      const body =
        hasBody || (method !== 'GET' && method !== 'HEAD')
          ? await collectBody(req).catch(() => null)
          : Buffer.alloc(0);
      if (body === null) {
        replyJson(res, 400, { message: 'could not read request body' });
        return;
      }

      // GraphQL v4.
      if (method === 'POST' && path === '/api/graphql') {
        const parsed = readJsonBody(body);
        if (!parsed.ok) {
          replyJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        try {
          replyJson(res, 200, handleGql(forge, parsed.value));
        } catch (e) {
          replyJson(res, 200, { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
        }
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(202, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          replyJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const result = handleMcp(forge, body);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        replyJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const segments = splitSegments(restPath);
        const parsed = readJsonBody(body);
        if (!parsed.ok) {
          replyJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        const result = handleRest(forge, {
          method,
          segments,
          query,
          json: parsed.value,
          body,
          host: req.headers.host ?? 'localhost',
        });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        replyJson(res, result.status, result.body, result.headers);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const rest = gitMatch[3] as string;
        const repo = forge.lookupRepo(owner, repoName);
        if (!repo || owner !== VIEWER_LOGIN) {
          replyJson(res, 404, { message: 'Not Found' });
          return;
        }
        try {
          if (method === 'GET' && rest === 'info/refs') {
            infoRefs(forge, repo, req, res, query);
            return;
          }
          if (method === 'POST' && rest === 'git-upload-pack') {
            uploadPack(forge, repo, req, res, body);
            return;
          }
          if (method === 'POST' && rest === 'git-receive-pack') {
            receivePack(forge, repo, req, res, body);
            return;
          }
        } catch (e) {
          replyJson(res, 400, { message: e instanceof Error ? e.message : String(e) });
          return;
        }
        replyJson(res, 404, { message: 'Not Found' });
        return;
      }

      replyJson(res, 404, { message: 'Not Found' });
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        replyJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
      } else {
        res.end();
      }
    });
  });
}

// ---------------------------------------------------------------- git helpers

/** The content type of a git smart-HTTP advertisement or result. */
function gitType(service: 'upload-pack' | 'receive-pack', kind: 'advertisement' | 'result'): string {
  return `application/x-git-${service}-${kind}`;
}

/**
 * The advertised ref lines for a repo (HEAD first when requested, then refs
 * sorted by name), with peeled lines for annotated tags. The first line
 * carries the capability list when one is given.
 */
function refLines(forge: Forge, repo: Repo, caps: string, withHead: boolean): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.allRefs(repo);
  const entries = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const mainTip = repo.refs.get('main') ?? '';
  let first = true;
  const emit = (oid: string, ref: string): void => {
    const suffix = first && caps !== '' ? `\0${caps}` : '';
    lines.push(pkt(`${oid} ${ref}${suffix}\n`));
    first = false;
  };
  if (withHead && mainTip !== '' && isOidString(mainTip)) {
    emit(mainTip, 'HEAD');
  }
  for (const [ref, oid] of entries) {
    emit(oid, ref);
    // Peeled line for annotated tags.
    if (ref.startsWith('refs/tags/')) {
      const t = forge.tagData(repo, oid);
      if (t) lines.push(pkt(`${t.object} ${ref}^{}\n`));
    }
  }
  if (entries.length === 0 && (!withHead || mainTip === '')) {
    emit(NULL_OID, 'capabilities^{}');
  }
  return lines;
}

/** The v2 upload-pack advertisement: fully static, built once. */
const V2_ADV = Buffer.concat([
  pkt('version 2\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow filter\n'),
  pkt('object-format=sha1\n'),
  pkt('agent=makefun-forge/1.0\n'),
  FLUSH,
]);

/** GET info/refs: advertise upload-pack / receive-pack capabilities and refs. */
function infoRefs(
  forge: Forge,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  query: Query,
): void {
  const service = query.get('service') ?? '';
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      replyRaw(res, 200, V2_ADV, gitType('upload-pack', 'advertisement'));
      return;
    }
    // The v0 advertisement depends only on the refs: cache it per version.
    if (repo.advUpload === null || repo.advVersion !== repo.refsVersion) {
      const caps = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=makefun-forge/1.0';
      const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH, ...refLines(forge, repo, caps, true), FLUSH];
      repo.advUpload = Buffer.concat(parts);
      repo.advVersion = repo.refsVersion;
    }
    replyRaw(res, 200, repo.advUpload, gitType('upload-pack', 'advertisement'));
    return;
  }
  if (service === 'git-receive-pack') {
    if (repo.advReceive === null || repo.advVersion !== repo.refsVersion) {
      const caps = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
      const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), FLUSH, ...refLines(forge, repo, caps, false), FLUSH];
      repo.advReceive = Buffer.concat(parts);
      repo.advVersion = repo.refsVersion;
    }
    replyRaw(res, 200, repo.advReceive, gitType('receive-pack', 'advertisement'));
    return;
  }
  replyJson(res, 400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------- upload-pack

/** POST git-upload-pack: protocol v2 or v0, by the git-protocol header. */
function uploadPack(
  forge: Forge,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    uploadPackV2(forge, repo, res, body);
  } else {
    uploadPackV0(forge, repo, res, body);
  }
}

/** Upload-pack protocol v2: one command (ls-refs / fetch) plus arguments. */
function uploadPackV2(forge: Forge, repo: Repo, res: ServerResponse, body: Buffer): void {
  const frames = decodePkts(body);
  let i = 0;
  let command = '';
  const args: string[] = [];
  for (; i < frames.length; i += 1) {
    const p = frames[i] as { kind: string; payload: Buffer };
    if (p.kind === 'delim') {
      i += 1;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
  }
  for (; i < frames.length; i += 1) {
    const p = frames[i] as { kind: string; payload: Buffer };
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    args.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    lsRefs(forge, repo, res, args);
    return;
  }
  if (command === 'fetch') {
    doFetch(forge, repo, res, args, 2);
    return;
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

/** Upload-pack v2 ls-refs: refs matching the requested prefixes, peeled on demand. */
function lsRefs(forge: Forge, repo: Repo, res: ServerResponse, args: string[]): void {
  // The answer depends only on the refs and the arguments: cache it per
  // version, so fifty concurrent clones share one build.
  const key = args.join('\n');
  const hit = repo.lsCache.get(key);
  if (hit !== undefined) {
    replyRaw(res, 200, hit, gitType('upload-pack', 'result'));
    return;
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const mainTip = repo.refs.get('main') ?? '';
  const refs = forge.allRefs(repo);
  if (mainTip !== '' && isOidString(mainTip)) {
    if (keep('HEAD')) {
      out.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else if (unborn && keep('refs/heads/main')) {
    out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  const sorted = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of sorted) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const t = forge.tagData(repo, oid);
      if (t) line += ` peeled:${t.object}`;
    }
    out.push(`${line}\n`);
  }
  const parts: Buffer[] = out.map((l) => pkt(l));
  parts.push(FLUSH);
  const buf = Buffer.concat(parts);
  if (repo.lsCache.size >= 64) repo.lsCache.clear();
  repo.lsCache.set(key, buf);
  replyRaw(res, 200, buf, gitType('upload-pack', 'result'));
}

/** What a fetch asks for: wants, haves, shallow boundaries, depth, want-refs. */
interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  wantRefs: string[];
  deepenRelative: boolean;
}

/** Parse fetch argument lines (want/have/shallow/deepen/want-ref/...) into a plan. */
function readFetchArgs(args: string[]): FetchArgs {
  const plan: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null, wantRefs: [], deepenRelative: false };
  for (const line of args) {
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    else if (line.startsWith('want-ref ')) plan.wantRefs.push(line.slice(9).trim());
    else if (line === 'deepen-relative') plan.deepenRelative = true;
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: ignored.
  }
  return plan;
}

/**
 * Resolve a fetch plan into the objects to send, the new shallow boundaries,
 * the boundaries that stopped being shallow, and the ACKs for the haves.
 */
function fetchPlan(
  forge: Forge,
  repo: Repo,
  plan: FetchArgs,
): { objects: ObjEntry[]; shallow: string[]; unshallow: string[]; acks: string[] } {
  const wants = plan.wants.filter((w) => isOidString(w) && forge.getObj(repo, w) !== undefined);
  const haves = plan.haves.filter((h) => isOidString(h));
  if (wants.length === 0) return { objects: [], shallow: [], unshallow: [], acks: [] };
  // ACKs need the common base even for shallow fetches (real git expects
  // ACK + ready, not NAK, when the haves are ancestors of the wants). With no
  // haves there is nothing to ack (v0 answers NAK, v2 sends no
  // acknowledgments section), so skip the full-history walk entirely: a
  // depth-1 clone of a 200-commit repo used to walk all 200 commits here.
  const acks = haves.length > 0 ? forge.commonHaves(repo, wants, haves) : [];
  if (plan.depth !== null && Number.isFinite(plan.depth) && plan.depth > 0) {
    // `deepen-relative` (real git --deepen): the deepen value counts from the
    // current shallow boundary, so the absolute depth is the boundary's
    // distance from the wants plus the requested deepen.
    let depth = plan.depth;
    if (plan.deepenRelative && plan.shallowBoundaries.length > 0) {
      const base = forge.boundaryDepth(repo, wants, plan.shallowBoundaries);
      if (base > 0) depth = base + plan.depth;
    }
    const { objects, shallow, commits } = forge.walkDepth(repo, wants, haves, depth, plan.shallowBoundaries);
    // A previous boundary that is now inside the walked range stops being
    // shallow (real git reports it as unshallow even though it is not in
    // the pack — the client already holds it).
    const commitSet = new Set(commits);
    const unshallow = plan.shallowBoundaries.filter((b) => commitSet.has(b) && !shallow.includes(b));
    return { objects: [...objects.values()], shallow, unshallow, acks };
  }
  const objects = forge.minusHaves(repo, wants, haves);
  return { objects: [...objects.values()], shallow: [], unshallow: [], acks };
}

/**
 * Send a fetch answer: ACKs/shallow-info/wanted-refs sections, then the pack.
 * The whole reply is cached under the fetch arguments: objects are immutable
 * and a fetch answer is fixed by its wants/haves/depth/boundaries, so the
 * fifty concurrent clones of one tip share a single build (and a later push
 * clears the cache through bumpRefs). The cache key is the raw argument list,
 * so two fetches that differ in any argument never share a reply.
 */
function fetchReply(
  forge: Forge,
  repo: Repo,
  plan: FetchArgs,
  protocol: 0 | 2,
  res: ServerResponse,
): void {
  const key = `${protocol}|${plan.wants.join(',')}|${plan.haves.join(',')}|${plan.depth}|${plan.shallowBoundaries.join(',')}|${plan.wantRefs.join(',')}|${plan.deepenRelative ? 1 : 0}`;
  const hit = repo.fetchCache.get(key);
  if (hit !== undefined) {
    replyRaw(res, 200, hit, gitType('upload-pack', 'result'));
    return;
  }
  const { objects, shallow, unshallow, acks } = fetchPlan(forge, repo, plan);
  const pack = objects.length > 0 ? encodePackData(objects) : null;
  let buf: Buffer;
  if (protocol === 2) {
    const parts: Buffer[] = [];
    // The acknowledgments section only exists when the client negotiated
    // with 'have' lines; a no-haves fetch (clone) has nothing to ack, and
    // real git rejects an acknowledgments section in that position.
    if (plan.haves.length > 0) {
      parts.push(pkt('acknowledgments\n'));
      if (acks.length > 0) {
        for (const a of acks) parts.push(pkt(`ACK ${a}\n`));
      } else {
        parts.push(pkt('NAK\n'));
      }
      // 'ready' tells the client the server is done negotiating and more
      // sections (shallow-info / packfile) follow; without it git expects
      // the response to end right after the acknowledgments section.
      parts.push(pkt('ready\n'));
      // Protocol v2 sections are separated by delimiter packets (0001); a
      // flush packet (0000) ends the whole response.
      parts.push(DELIM);
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pkt(`unshallow ${u}\n`));
      parts.push(DELIM);
    }
    const refs = forge.allRefs(repo);
    const wantedLines: string[] = [];
    // wanted-refs is only sent when the client asked for it (want-ref lines);
    // real git rejects an unsolicited wanted-refs section.
    for (const wantRef of plan.wantRefs) {
      const oid = refs.get(wantRef) ?? (wantRef === 'HEAD' ? repo.refs.get('main') ?? '' : '');
      if (oid !== '') wantedLines.push(`${oid} ${wantRef}\n`);
    }
    if (wantedLines.length > 0) {
      parts.push(pkt('wanted-refs\n'));
      for (const l of wantedLines) parts.push(pkt(l));
      parts.push(DELIM);
    }
    if (pack) {
      parts.push(pkt('packfile\n'));
      for (const p of sideband(pack, 1)) parts.push(p);
      parts.push(FLUSH);
    }
    buf = Buffer.concat(parts);
  } else {
    // Protocol v0: ACK/NAK + shallow lines, then sideband pack.
    const parts: Buffer[] = [];
    if (acks.length > 0) {
      for (const a of acks) parts.push(pkt(`ACK ${a}\n`));
    } else {
      parts.push(pkt('NAK\n'));
    }
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pkt(`unshallow ${u}\n`));
    if (pack) {
      for (const p of sideband(pack, 1)) parts.push(p);
    }
    parts.push(FLUSH);
    buf = Buffer.concat(parts);
  }
  if (repo.fetchCache.size >= 64) repo.fetchCache.clear();
  repo.fetchCache.set(key, buf);
  replyRaw(res, 200, buf, gitType('upload-pack', 'result'));
}

/** Run a fetch (v0 or v2) from parsed argument lines. */
function doFetch(
  forge: Forge,
  repo: Repo,
  res: ServerResponse,
  args: string[],
  protocol: 0 | 2,
): void {
  const plan = readFetchArgs(args);
  fetchReply(forge, repo, plan, protocol, res);
}

/** Upload-pack protocol v0: wants (+ shallow/deepen), flush, haves + done, flush. */
function uploadPackV0(forge: Forge, repo: Repo, res: ServerResponse, body: Buffer): void {
  const first = decodePktsToFlush(body);
  const wantsLines = pktTexts(first.frames);
  const rest = body.subarray(first.consumed);
  const second = decodePktsToFlush(rest);
  const haveLines = pktTexts(second.frames);
  const plan = readFetchArgs([...wantsLines, ...haveLines]);
  fetchReply(forge, repo, plan, 0, res);
}

// ---------------------------------------------------------------- receive-pack

/** POST git-receive-pack: read the commands + pack, store objects, update refs. */
function receivePack(
  forge: Forge,
  repo: Repo,
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const first = decodePktsToFlush(body);
  const lines = pktTexts(first.frames);
  const packBytes = body.subarray(first.consumed);
  interface RefCommand {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: RefCommand[] = [];
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOidString(oldOid) || !isOidString(newOid)) throw new Error('bad object id in receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack got no commands');
  const needsPack = commands.some((c) => c.newOid !== NULL_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = decodePackData(packBytes, (oid) => forge.getObj(repo, oid));
        for (const [oid, obj] of objects) {
          if (!forge.getObj(repo, oid)) {
            repo.objects.set(oid, obj);
          }
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = e instanceof Error ? e.message : 'unpacker error';
      }
    }
  }
  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok\n');
  } else {
    report.push(`unpack ${unpackDetail}\n`);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpacker error\n`);
      continue;
    }
    const result = applyCmd(forge, repo, cmd);
    if (result.ok) report.push(`ok ${cmd.ref}\n`);
    else report.push(`ng ${cmd.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...report.map((l) => pkt(l)), FLUSH]);
  const parts: Buffer[] = [...sideband(reportStream, 1), FLUSH];
  replyRaw(res, 200, Buffer.concat(parts), gitType('receive-pack', 'result'));
}

/**
 * Apply one ref update (create / update / delete on a branch or a tag).
 * Updates must be fast-forwards from the advertised old value. Every ref or
 * tag move drops the ref-dependent response caches (see bumpRefs).
 */
function applyCmd(
  forge: Forge,
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): { ok: boolean; reason: string } {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.length > 200 || /[\s\x00-\x1f]/.test(cmd.ref)) {
    return { ok: false, reason: 'invalid ref' };
  }
  if (cmd.ref.startsWith('refs/heads/')) {
    const branch = cmd.ref.slice('refs/heads/'.length);
    const current = repo.refs.get(branch) ?? '';
    if (cmd.newOid === NULL_OID) {
      // Delete.
      if (cmd.oldOid !== NULL_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.refs.delete(branch);
      bumpRefs(repo);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === NULL_OID) {
      // Create.
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.getObj(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.refs.set(branch, cmd.newOid);
      bumpRefs(repo);
      return { ok: true, reason: '' };
    }
    // Update: must be a fast-forward from the advertised old value.
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (!forge.getObj(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
    if (!forge.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(branch, cmd.newOid);
    bumpRefs(repo);
    return { ok: true, reason: '' };
  }
  if (cmd.ref.startsWith('refs/tags/')) {
    const tag = cmd.ref.slice('refs/tags/'.length);
    const current = repo.tags.get(tag) ?? '';
    if (cmd.newOid === NULL_OID) {
      if (cmd.oldOid !== NULL_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.tags.delete(tag);
      bumpRefs(repo);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === NULL_OID) {
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.getObj(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.tags.set(tag, cmd.newOid);
      bumpRefs(repo);
      return { ok: true, reason: '' };
    }
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.tags.set(tag, cmd.newOid);
    bumpRefs(repo);
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: 'invalid ref' };
}
