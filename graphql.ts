// GraphQL v4 (/api/graphql): a small parser for the documents the suite sends,
// plus resolvers over the Forge store. No schema generation, no validation
// beyond unknown-field errors (HTTP 200 with an errors array naming the field).
import { Forge, VIEWER_LOGIN, globalIdFor, type Repo, type Issue, type PullReq } from './store.ts';
import { mergeSquash, hasConflict, treeOf } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

/** One lexical token of a GraphQL document. */
type Tok =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

/** Split a GraphQL document into tokens (comments and commas are skipped). */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      out.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      out.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === '"') text += '"';
          else if (esc === '\\') text += '\\';
          else if (esc === '/') text += '/';
          else text += esc;
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) {
        out.push({ kind: 'float', value: Number(raw) });
      } else {
        out.push({ kind: 'int', value: Number(raw) });
      }
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return out;
}

// ---------------------------------------------------------------- AST

/** A literal value in a document (variable, scalar, list, or object). */
type Val =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Val[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Val }> };

/** One field in a selection set, with optional alias, arguments, and sub-selections. */
interface Fld {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Val }>;
  selections?: Sel[];
}

/** A fragment spread (inline or named) in a selection set. */
interface Frag {
  kind: 'fragment';
  typeCondition?: string;
  selections: Sel[];
}

type Sel = Fld | Frag;

/** One top-level operation (query or mutation) of a document. */
interface Op {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: Array<{ name: string; type: string; defaultValue?: Val }>;
  selections: Sel[];
}

/** Recursive-descent parser over the lexer's tokens. */
class DocParser {
  private cursor = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.cursor];
  }

  private take(): Tok {
    const t = this.toks[this.cursor];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.cursor += 1;
    return t;
  }

  private needPunct(value: string): void {
    const t = this.take();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private needName(value?: string): string {
    const t = this.take();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return t.value;
  }

  /** Parse the whole document into its operations. */
  readOps(): Op[] {
    const ops: Op[] = [];
    while (this.cursor < this.toks.length) {
      const t = this.peek() as Tok;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ kind: 'query', varDefs: [], selections: this.readSelSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.take().value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peek();
        if (next && next.kind === 'name') name = this.take().value as string;
        const varDefs = this.readVarDefs();
        const selections = this.readSelSet();
        ops.push({ kind, name, varDefs, selections });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)} in GraphQL document`);
    }
    return ops;
  }

  private readVarDefs(): Array<{ name: string; type: string; defaultValue?: Val }> {
    const defs: Array<{ name: string; type: string; defaultValue?: Val }> = [];
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return defs;
    this.take();
    while (true) {
      const next = this.peek() as Tok;
      if (next.kind === 'punct' && next.value === ')') {
        this.take();
        break;
      }
      this.needPunct('$');
      const name = this.needName();
      this.needPunct(':');
      const type = this.readType();
      let defaultValue: Val | undefined;
      const eq = this.peek();
      if (eq && eq.kind === 'punct' && eq.value === '=') {
        this.take();
        defaultValue = this.readVal();
      }
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private readType(): string {
    const t = this.take();
    if (t.kind === 'punct' && t.value === '[') {
      const inner = this.readType();
      this.needPunct(']');
      let out = `[${inner}]`;
      const bang = this.peek();
      if (bang && bang.kind === 'punct' && bang.value === '!') {
        this.take();
        out += '!';
      }
      return out;
    }
    if (t.kind !== 'name') throw new Error('expected a type name in GraphQL document');
    let out = t.value;
    const bang = this.peek();
    if (bang && bang.kind === 'punct' && bang.value === '!') {
      this.take();
      out += '!';
    }
    return out;
  }

  private readSelSet(): Sel[] {
    this.needPunct('{');
    const out: Sel[] = [];
    for (;;) {
      const t = this.peek() as Tok;
      if (t.kind === 'punct' && t.value === '}') {
        this.take();
        break;
      }
      out.push(this.readSel());
    }
    return out;
  }

  private readSel(): Sel {
    const t = this.peek() as Tok;
    if (t.kind === 'punct' && t.value === '...') {
      this.take();
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.take();
        const typeCondition = this.needName();
        return { kind: 'fragment', typeCondition, selections: this.readSelSet() };
      }
      if (next && next.kind === 'name') {
        // Named fragment spread (not used by the suite); skip its selections.
        this.take();
        return { kind: 'fragment', selections: [] };
      }
      throw new Error('bad fragment spread in GraphQL document');
    }
    const first = this.needName();
    let alias: string | undefined;
    let name = first;
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.take();
      alias = first;
      name = this.needName();
    }
    const args: Array<{ name: string; value: Val }> = [];
    const open = this.peek();
    if (open && open.kind === 'punct' && open.value === '(') {
      this.take();
      for (;;) {
        const next = this.peek() as Tok;
        if (next.kind === 'punct' && next.value === ')') {
          this.take();
          break;
        }
        const argName = this.needName();
        this.needPunct(':');
        args.push({ name: argName, value: this.readVal() });
      }
    }
    let selections: Sel[] | undefined;
    const brace = this.peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') {
      selections = this.readSelSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private readVal(): Val {
    const t = this.take();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.needName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Val[] = [];
      for (;;) {
        const next = this.peek() as Tok;
        if (next.kind === 'punct' && next.value === ']') {
          this.take();
          break;
        }
        items.push(this.readVal());
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: Val }> = [];
      for (;;) {
        const next = this.peek() as Tok;
        if (next.kind === 'punct' && next.value === '}') {
          this.take();
          break;
        }
        const name = this.needName();
        this.needPunct(':');
        fields.push({ name, value: this.readVal() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------- values

/** Resolve a literal AST value against the request's variables. */
function resolveVal(value: Val, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((v) => resolveVal(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveVal(f.value, variables);
      return out;
    }
  }
}

/** A field's arguments as a name -> resolved value map. */
function argsOf(field: Fld, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveVal(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection

/** Fields the suite may introspect on each type (for __type queries). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt'],
  SearchType: [],
};

/** Enum values the suite may introspect on each enum type. */
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE'],
};

// ---------------------------------------------------------------- execution

/** An error that becomes a GraphQL errors entry (HTTP 200, data null). */
class GqlFault extends Error {}

/** A resolved node value: its GraphQL type plus its fields. */
interface NodeVal {
  __type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** An issue's state as a GraphQL enum value. */
function stateOfIssue(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

/** A pull request's state as a GraphQL enum value (merged wins over closed). */
function stateOfPull(pull: PullReq): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Encode an issue number as an opaque page cursor. */
function encCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64url');
}

/** Decode a page cursor back to an issue number (null when malformed). */
function decCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function repoByNode(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    if (repo.globalId === id) return repo;
  }
  return undefined;
}

function issueByNode(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const issue = repo.issues.find((i) => i.globalId === id);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function pullByNode(forge: Forge, id: unknown): { repo: Repo; pull: PullReq } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const pull = repo.pullReqs.find((p) => p.globalId === id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function issueNode(issue: Issue): NodeVal {
  return {
    __type: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: stateOfIssue(issue.state),
    body: issue.body,
  };
}

function pullNode(forge: Forge, repo: Repo, pull: PullReq): NodeVal {
  return {
    __type: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: stateOfPull(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: hasConflict(forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    _repo: repo,
    _pull: pull,
  };
}

function repoNode(repo: Repo): NodeVal {
  return {
    __type: 'Repository',
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

/** Run a selection set against a value of the given type. */
function execSels(
  forge: Forge,
  type: string,
  value: NodeVal | Record<string, unknown>,
  selections: Sel[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== type) continue;
      const nested = execSels(forge, type, value, sel.selections, variables);
      Object.assign(out, nested);
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = fieldVal(forge, type, value, sel, variables);
  }
  return out;
}

function fieldVal(
  forge: Forge,
  type: string,
  value: NodeVal | Record<string, unknown>,
  field: Fld,
  variables: Record<string, unknown>,
): unknown {
  const args = argsOf(field, variables);
  const subs = field.selections ?? [];

  if (type === 'Query') {
    if (field.name === 'viewer') {
      const node: NodeVal = { __type: 'User', login: VIEWER_LOGIN };
      return subs.length > 0 ? execSels(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'repository') {
      const repo = forge.lookupRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      const node = repoNode(repo);
      return subs.length > 0 ? execSels(forge, 'Repository', node, subs, variables) : node;
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const repo = repoByNode(forge, id);
      if (repo) {
        const node = repoNode(repo);
        return subs.length > 0 ? execSels(forge, 'Repository', node, subs, variables) : node;
      }
      const issue = issueByNode(forge, id);
      if (issue) {
        const node = issueNode(issue.issue);
        return subs.length > 0 ? execSels(forge, 'Issue', node, subs, variables) : node;
      }
      const pull = pullByNode(forge, id);
      if (pull) {
        const node = pullNode(forge, pull.repo, pull.pull);
        return subs.length > 0 ? execSels(forge, 'PullRequest', node, subs, variables) : node;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      const node: NodeVal = {
        __type: '__Type',
        name,
        fields: fields.map((f) => ({ __type: '__Field', name: f })),
        enumValues: (TYPE_ENUMS[name] ?? []).map((n) => ({ __type: '__EnumValue', name: n })),
      };
      return subs.length > 0 ? execSels(forge, '__Type', node, subs, variables) : node;
    }
    throw new GqlFault(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNode(forge, input.repositoryId);
      if (!repo) throw new GqlFault('createIssue: unknown repositoryId');
      const number = repo.nextIssueNum;
      repo.nextIssueNum += 1;
      const { seq } = forge.tickClock();
      const issue: Issue = {
        id: number,
        globalId: globalIdFor('I', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq,
        comments: [],
        cachedBuf: null,
      };
      forge.addIssue(repo, issue);
      const payload: NodeVal = { __type: 'CreateIssuePayload', issue: issueNode(issue) };
      return subs.length > 0 ? execSels(forge, 'CreateIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByNode(forge, input.issueId);
      if (!found) throw new GqlFault('closeIssue: unknown issueId');
      found.issue.state = 'closed';
      forge.dropIssueJson(found.repo);
      const payload: NodeVal = { __type: 'CloseIssuePayload', issue: issueNode(found.issue) };
      return subs.length > 0 ? execSels(forge, 'CloseIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNode(forge, input.repositoryId);
      if (!repo) throw new GqlFault('createPullRequest: unknown repositoryId');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(head);
      const baseSha = repo.refs.get(base);
      if (!headSha || !baseSha) throw new GqlFault('createPullRequest: head or base branch does not exist');
      const number = repo.nextPullNum;
      repo.nextPullNum += 1;
      const { seq } = forge.tickClock();
      const pull: PullReq = {
        id: number,
        globalId: globalIdFor('PR', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: '',
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
      const payload: NodeVal = { __type: 'CreatePullRequestPayload', pullRequest: pullNode(forge, repo, pull) };
      return subs.length > 0 ? execSels(forge, 'CreatePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByNode(forge, input.pullRequestId);
      if (!found) throw new GqlFault('mergePullRequest: unknown pullRequestId');
      const result = mergeSquash(forge, found.repo, found.pull);
      if (result.status !== 200) throw new GqlFault(`mergePullRequest: ${result.message}`);
      const payload: NodeVal = { __type: 'MergePullRequestPayload', pullRequest: pullNode(forge, found.repo, found.pull) };
      return subs.length > 0 ? execSels(forge, 'MergePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByNode(forge, input.subjectId);
      if (!found) throw new GqlFault('addComment: unknown subjectId');
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      const { seq } = forge.tickClock();
      const note = { id, globalId: globalIdFor('C', id), body: String(input.body ?? ''), seq };
      found.issue.comments.push(note);
      forge.dropIssueJson(found.repo);
      const node: NodeVal = { __type: 'IssueComment', id: note.globalId, body: note.body };
      const edge: NodeVal = { __type: 'IssueCommentEdge', node };
      const payload: NodeVal = { __type: 'AddCommentPayload', commentEdge: edge };
      return subs.length > 0 ? execSels(forge, 'AddCommentPayload', payload, subs, variables) : payload;
    }
    throw new GqlFault(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (type === 'Repository') {
    const repo = (value as NodeVal)._repo as Repo;
    if (field.name === 'issue') {
      const issue = repo.issueByNum.get(Number(args.number));
      if (!issue) return null;
      const node = issueNode(issue);
      return subs.length > 0 ? execSels(forge, 'Issue', node, subs, variables) : node;
    }
    if (field.name === 'issues') {
      let list = repo.issues.slice();
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((i) => states.includes(stateOfIssue(i.state)));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const afterNum = decCursor(args.after);
      if (afterNum !== null) {
        // DESC order: keep issues with a smaller number than the cursor's.
        list = direction === 'ASC' ? list.filter((i) => i.number > afterNum) : list.filter((i) => i.number < afterNum);
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > page.length;
      const endCursor = page.length > 0 ? encCursor(page[page.length - 1]?.number ?? 0) : null;
      const conn: NodeVal = {
        __type: 'IssueConnection',
        nodes: page.map((i) => issueNode(i)),
        pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor },
      };
      if (subs.length === 0) return conn;
      // Expand nested selections (nodes / pageInfo) manually.
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: NodeVal) => execSels(forge, 'Issue', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = execSels(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else if (s.name === 'totalCount') {
          out[s.alias ?? 'totalCount'] = list.length;
        } else {
          throw new GqlFault(`Cannot query field "${s.name}" on type "IssueConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequests') {
      let list = repo.pullReqs.slice();
      list.sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const conn: NodeVal = {
        __type: 'PullRequestConnection',
        nodes: page.map((p) => pullNode(forge, repo, p)),
        pageInfo: { __type: 'PageInfo', hasNextPage: list.length > page.length, endCursor: null },
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: NodeVal) => execSels(forge, 'PullRequest', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = execSels(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else {
          throw new GqlFault(`Cannot query field "${s.name}" on type "PullRequestConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pullByNum.get(Number(args.number));
      if (!pull) return null;
      const node = pullNode(forge, repo, pull);
      return subs.length > 0 ? execSels(forge, 'PullRequest', node, subs, variables) : node;
    }
    if (field.name === 'owner') {
      const node: NodeVal = { __type: 'User', login: repo.owner };
      return subs.length > 0 ? execSels(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'defaultBranchRef') {
      const node: NodeVal = { __type: 'Ref', name: repo.defaultBranch };
      return subs.length > 0 ? execSels(forge, 'Ref', node, subs, variables) : node;
    }
    const scalar: Record<string, unknown> = {
      id: repo.globalId,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
    };
    if (field.name in scalar) {
      if (subs.length > 0) throw new GqlFault(`Field "${field.name}" on type "Repository" must not have a selection set.`);
      return scalar[field.name];
    }
    throw new GqlFault(`Cannot query field "${field.name}" on type "Repository".`);
  }

  if (type === 'PullRequest') {
    const node = value as NodeVal;
    if (field.name === 'files') {
      const repo = node._repo as Repo;
      const pull = node._pull as PullReq;
      const baseTree = treeOf(forge, repo, pull.baseSha);
      const headTip = forge.resolveRef(repo, `refs/heads/${pull.headRef}`);
      const headTree = headTip === '' ? '' : treeOf(forge, repo, headTip);
      const diff = forge.diffTrees(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : diff.size;
      const paths = [...diff.keys()].sort().slice(0, first);
      const conn: NodeVal = {
        __type: 'PullRequestChangedFileConnection',
        nodes: paths.map((p) => ({ __type: 'PullRequestChangedFile', path: p })),
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: NodeVal) => execSels(forge, 'PullRequestChangedFile', n, s.selections ?? [], variables));
        } else {
          throw new GqlFault(`Cannot query field "${s.name}" on type "PullRequestChangedFileConnection".`);
        }
      }
      return out;
    }
    const scalar: Record<string, unknown> = {
      id: node.id,
      number: node.number,
      title: node.title,
      body: node.body,
      state: node.state,
      merged: node.merged,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName,
      mergeable: node.mergeable,
    };
    if (field.name in scalar) return scalar[field.name];
    throw new GqlFault(`Cannot query field "${field.name}" on type "PullRequest".`);
  }

  // Leaf / passthrough types: scalar fields live on the value itself.
  const record = value as Record<string, unknown>;
  if (field.name in record) {
    const v = record[field.name];
    if (subs.length > 0) {
      if (Array.isArray(v)) {
        return v.map((el) => {
          if (el !== null && typeof el === 'object') {
            const childType = (el as NodeVal).__type ?? type;
            return execSels(forge, childType, el as NodeVal, subs, variables);
          }
          return el;
        });
      }
      if (v !== null && typeof v === 'object') {
        const childType = (v as NodeVal).__type ?? type;
        return execSels(forge, childType, v as NodeVal, subs, variables);
      }
      throw new GqlFault(`Field "${field.name}" on type "${type}" must not have a selection set.`);
    }
    return v;
  }
  throw new GqlFault(`Cannot query field "${field.name}" on type "${type}".`);
}

/** The result of one operation: data, plus errors when the operation failed. */
export interface GqlOutcome {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function runOp(forge: Forge, op: Op, variables: Record<string, unknown>): GqlOutcome {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeVal = { __type: rootType };
  try {
    const data = execSels(forge, rootType, root, op.selections, variables);
    return { data };
  } catch (e) {
    if (e instanceof GqlFault) {
      return { data: null, errors: [{ message: e.message }] };
    }
    throw e;
  }
}

/** Execute one GraphQL request body (object or array of operations). */
export function handleGql(forge: Forge, body: unknown): unknown {
  // Shared runner: parse the document, pick the operation, run it.
  const runOne = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return { data: null, errors: [{ message: 'request is not an object' }] };
    const rec = item as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables ?? {}) as Record<string, unknown>;
    try {
      const ops = new DocParser(tokenize(query)).readOps();
      const op = pickOp(ops, typeof rec.operationName === 'string' ? rec.operationName : undefined);
      if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
      return runOp(forge, op, variables);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(body)) return body.map(runOne);
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  return runOne(body);
}

/** Pick the named operation, or the first one when no name is given. */
function pickOp(ops: Op[], name: string | undefined): Op | undefined {
  if (ops.length === 0) return undefined;
  if (name !== undefined) return ops.find((o) => o.name === name);
  return ops[0];
}
