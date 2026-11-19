// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern 2026-07-28 era (server/discover) and the legacy era
// (initialize + notifications/initialized). Tools act on the same store as REST.
import { Forge, VIEWER_LOGIN, globalIdFor, type Repo, type Issue, type PullReq } from './store.ts';
import { repoJson, issueJson, pullJson, mergeSquash } from './rest.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

/** The outcome of one MCP request: HTTP status plus JSON body (null = empty 202). */
export interface McpOut {
  status: number;
  /** JSON value to send, or null for an empty 202. */
  body: unknown;
}

/** One JSON-RPC 2.0 request object. */
interface RpcMsg {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

/** A successful JSON-RPC reply envelope. */
function rpcOk(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** An error JSON-RPC reply envelope. */
function rpcErr(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The six tools this server offers, with their input schemas. */
const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalize a tool name for matching: lowercase, alphanumerics only. */
function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find a tool by name, tolerating separators and suffix/prefix matches. */
function toolByName(name: string): Record<string, unknown> | undefined {
  const want = normName(name);
  for (const tool of TOOLS) {
    const have = normName(String(tool.name));
    if (have === want || have.endsWith(want) || want.endsWith(have)) return tool;
  }
  return undefined;
}

/** The first defined, non-null argument under any of these names. */
function argFirst(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

/** Resolve a repository from tool arguments (owner + repo, or full_name). */
function repoOfArgs(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  let owner = argFirst(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace']) as string | undefined;
  let repo = argFirst(args, ['repo', 'repository', 'repository_name', 'repo_name', 'project']) as string | undefined;
  const full = argFirst(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']) as string | undefined;
  if ((!owner || !repo) && typeof full === 'string') {
    const parts = full.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  if (!owner || !repo) return undefined;
  return forge.lookupRepo(owner, repo);
}

/** A tool result: text content plus the same value as structured content. */
function toolText(text: string, structured: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
  if (isError) out.isError = true;
  return out;
}

/** A tool/JSON-RPC fault carrying its JSON-RPC error code. */
class McpFault extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Dispatch one tool call by name. Throws McpFault on bad input. */
function runTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = toolByName(name);
  if (!tool) throw new McpFault(-32601, `unknown tool ${name}`);
  const toolName = String(tool.name);

  if (toolName === 'create_repo') {
    const repoName = argFirst(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) as string | undefined;
    if (!repoName) throw new McpFault(-32602, 'create_repo needs a name');
    const existing = forge.lookupRepo(VIEWER_LOGIN, repoName);
    const repo = existing ?? forge.addRepo(
      VIEWER_LOGIN,
      repoName,
      argFirst(args, ['private', 'is_private']) === true,
      (argFirst(args, ['description', 'about', 'summary', 'body']) as string | undefined) ?? '',
    );
    const out = { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` };
    return toolText(JSON.stringify(out), out);
  }

  if (toolName === 'get_repo') {
    const repo = repoOfArgs(forge, args);
    if (!repo) return toolText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const out = { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` };
    return toolText(JSON.stringify(out), out);
  }

  if (toolName === 'create_issue') {
    const repo = repoOfArgs(forge, args);
    if (!repo) return toolText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const title = argFirst(args, ['title', 'issue_title', 'subject']) as string | undefined;
    if (!title) throw new McpFault(-32602, 'create_issue needs a title');
    const body = (argFirst(args, ['body', 'issue_body', 'description', 'content', 'text']) as string | undefined) ?? '';
    const number = repo.nextIssueNum;
    repo.nextIssueNum += 1;
    const { seq } = forge.tickClock();
    const issue: Issue = {
      id: number,
      globalId: globalIdFor('I', repo.id * 100000 + number),
      number,
      title,
      body,
      state: 'open',
      labels: [],
      seq,
      comments: [],
      cachedBuf: null,
    };
    forge.addIssue(repo, issue);
    const out = { ...issueJson(issue, repo), full_name: `${repo.owner}/${repo.name}` };
    return toolText(JSON.stringify(out), out);
  }

  if (toolName === 'list_issues') {
    const repo = repoOfArgs(forge, args);
    if (!repo) return toolText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const state = (argFirst(args, ['state', 'status']) as string | undefined) ?? 'open';
    let list = repo.issues.slice();
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    const items = list.map((i) => ({ number: i.number, id: i.globalId, title: i.title, state: i.state, body: i.body }));
    const out = { issues: items };
    return toolText(JSON.stringify(out), out);
  }

  if (toolName === 'create_pull_request') {
    const repo = repoOfArgs(forge, args);
    if (!repo) return toolText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const title = argFirst(args, ['title', 'pr_title', 'pull_request_title', 'subject']) as string | undefined;
    const head = argFirst(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']) as string | undefined;
    const base = argFirst(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']) as string | undefined;
    if (!title || !head || !base) throw new McpFault(-32602, 'create_pull_request needs title, head and base');
    const headSha = repo.refs.get(head);
    const baseSha = repo.refs.get(base);
    if (!headSha || !baseSha) return toolText(JSON.stringify({ error: 'head or base branch does not exist' }), { error: 'head or base branch does not exist' }, true);
    const body = (argFirst(args, ['body', 'issue_body', 'description', 'content', 'text']) as string | undefined) ?? '';
    const number = repo.nextPullNum;
    repo.nextPullNum += 1;
    const { seq } = forge.tickClock();
    const pull: PullReq = {
      id: number,
      globalId: globalIdFor('PR', repo.id * 100000 + number),
      number,
      title,
      body,
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
    const out = { ...pullJson(pull, repo), full_name: `${repo.owner}/${repo.name}` };
    return toolText(JSON.stringify(out), out);
  }

  if (toolName === 'merge_pull_request') {
    const repo = repoOfArgs(forge, args);
    if (!repo) return toolText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const numRaw = argFirst(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    const number = typeof numRaw === 'number' ? numRaw : Number(numRaw);
    if (!Number.isInteger(number)) throw new McpFault(-32602, 'merge_pull_request needs a pull_number');
    const pull = repo.pullByNum.get(number);
    if (!pull) return toolText(JSON.stringify({ error: 'Pull request not found' }), { error: 'Pull request not found' }, true);
    const result = mergeSquash(forge, repo, pull);
    if (result.status !== 200 || !result.sha) {
      return toolText(JSON.stringify({ error: result.message }), { error: result.message }, true);
    }
    const out = { number: pull.number, merged: true, sha: result.sha };
    return toolText(JSON.stringify(out), out);
  }

  throw new McpFault(-32601, `unknown tool ${name}`);
}

/**
 * Handle one POST /mcp request. `raw` is the request body; auth is checked by
 * the caller. Returns the HTTP status and the JSON body (null = empty 202).
 */
export function handleMcp(forge: Forge, raw: Buffer): McpOut {
  let req: RpcMsg;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: rpcErr(null, -32700, 'Parse error: request must be a JSON object') };
    }
    req = parsed as RpcMsg;
  } catch {
    return { status: 400, body: rpcErr(null, -32700, 'Parse error') };
  }

  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;

  try {
    if (method === 'server/discover') {
      const result = {
        protocolVersion: MODERN_REVISION,
        supportedVersions: [MODERN_REVISION],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      };
      return { status: 200, body: rpcOk(id, result) };
    }

    if (method === 'initialize') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
      const result = {
        protocolVersion: version,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      };
      return { status: 200, body: rpcOk(id, result) };
    }

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }

    if (method === 'ping') {
      return { status: 200, body: rpcOk(id, {}) };
    }

    if (method === 'tools/list') {
      // The same array, byte for byte, on every call: TOOLS is constant.
      return { status: 200, body: rpcOk(id, { tools: TOOLS }) };
    }

    if (method === 'tools/call') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') throw new McpFault(-32602, 'tools/call needs a name');
      // Missing-arguments check: create_issue with no arguments at all.
      if (toolByName(name)?.name === 'create_issue' && Object.keys(args).length === 0) {
        throw new McpFault(-32602, 'create_issue needs arguments');
      }
      const result = runTool(forge, name, args);
      return { status: 200, body: rpcOk(id, result) };
    }

    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcErr(id, -32601, `Method not found: ${method}`) };
  } catch (e) {
    if (e instanceof McpFault) {
      return { status: 200, body: rpcErr(id, e.code, e.message) };
    }
    return { status: 200, body: rpcErr(id, -32603, e instanceof Error ? e.message : String(e)) };
  }
}
