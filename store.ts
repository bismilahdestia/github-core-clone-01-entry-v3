// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Deterministic: sequence numbers order
// everything; timestamps come from a logical clock, never the wall clock.
//
// Speed notes (v3): parsed git objects are memoized per repository (objects
// are immutable by oid, so a parsed view never goes stale and the cache dies
// with the repository on delete); issues and pull requests are also indexed
// by number, so a GET-one never scans the list; label colours live in a map
// instead of a find per serialization; issue serializations are cached as
// exact response *buffers* and dropped by every mutation site (see
// dropIssueJson); the git advertisements, ls-refs answers and fetch answers
// are cached per repository and dropped whenever a ref moves (see bumpRefs),
// because the timed clone workload asks for the same fetch fifty times in a
// row; the logical clock never builds a Date — timestamps are formatted from
// epoch seconds by hand (see isoForEpoch in rest.ts).
import {
  oidFor,
  decodeCommitData,
  decodeTreeData,
  encodeTreeData,
  orderTreeEnts,
  decodeTagData,
  NULL_OID,
  isOidString,
  type ObjEntry,
  type ObjKind,
  type TreeEnt,
  type CommitData,
  type TagData,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** A fixed author/committer line for commits this forge creates. */
function personLine(epochSec: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

/** One repository: its metadata, its git objects and refs, and its issues. */
export interface Repo {
  id: number;
  globalId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  issues: Issue[];
  pullReqs: PullReq[];
  labels: Label[];
  /** Issue number -> issue (kept in step with `issues`). */
  issueByNum: Map<number, Issue>;
  /** Pull request number -> pull request (kept in step with `pullReqs`). */
  pullByNum: Map<number, PullReq>;
  /** Label name -> colour (kept in step with `labels`). */
  labelColors: Map<string, string>;
  nextIssueNum: number;
  nextPullNum: number;
  nextCommentId: number;
  /** refs/heads/<branch> -> commit oid (or '' when unborn). */
  refs: Map<string, string>;
  /** refs/tags/<tag> -> object oid. */
  tags: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, ObjEntry>;
  /** Memoized commit parses (objects are immutable by oid: never stale). */
  commitCache: Map<string, CommitData>;
  /** Memoized tree parses. */
  treeCache: Map<string, TreeEnt[]>;
  /** Memoized tag parses. */
  tagCache: Map<string, TagData>;
  /**
   * Bumped on every ref/tag change; response caches below are only valid
   * for the version they were built at.
   */
  refsVersion: number;
  /** Cached fetch replies: plan key -> whole response bytes. */
  fetchCache: Map<string, Buffer>;
  /** Cached ls-refs replies: args key -> whole response bytes. */
  lsCache: Map<string, Buffer>;
  /** Cached v0 upload-pack advertisement (null when not built). */
  advUpload: Buffer | null;
  /** Cached receive-pack advertisement (null when not built). */
  advReceive: Buffer | null;
  /** The refsVersion the two cached advertisements were built at. */
  advVersion: number;
}

export interface Label {
  name: string;
  color: string;
}

/** An issue: its fields, its labels, and its comments. */
export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
  /** Cached GET-one response bytes; null when stale/unbuilt. */
  cachedBuf: Buffer | null;
}

/** One comment on an issue. */
export interface IssueComment {
  id: number;
  globalId: string;
  body: string;
  seq: number;
}

/** A pull request: head/base branches and merge state. */
export interface PullReq {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

/** A stable node id: "<kind>_" + base64url("<kind>:<n>"). */
export function globalIdFor(kind: string, n: number): string {
  return `${kind}_${Buffer.from(`${kind}:${n}`).toString('base64url')}`;
}

/**
 * Drop every response cache that depends on the repo's refs. Called by the
 * few places that move a ref or a tag (ref updates, branch creation, merges,
 * contents commits); a missed call would serve a stale advertisement, so
 * every `refs.set/delete` and `tags.set/delete` in the codebase goes through
 * here. Objects are append-only and immutable, so nothing else can stale
 * these caches: a fetch answer is fixed by its wants/haves/depth, and a
 * want naming a new tip is a different cache key anyway.
 */
export function bumpRefs(repo: Repo): void {
  repo.refsVersion += 1;
  repo.fetchCache.clear();
  repo.lsCache.clear();
  repo.advUpload = null;
  repo.advReceive = null;
}

/** The forge itself: every repository plus the logical clock. */
export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectSeq = 1;
  seq = 0;
  /** Logical clock: seconds since the scenario epoch, +1 per event. */
  clockSeconds = 1735689600;

  /**
   * Advance the clock by one second and one sequence number. Deliberately
   * returns no ISO string: most callers only need the sequence, and building
   * a Date here used to cost a Date allocation plus a toISOString on every
   * single create. Callers that need a timestamp format it themselves.
   */
  tickClock(): { epoch: number; seq: number } {
    this.clockSeconds += 1;
    this.seq += 1;
    return { epoch: this.clockSeconds, seq: this.seq };
  }

  keyOfRepo(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  lookupRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.keyOfRepo(owner, name));
  }

  addRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      globalId: globalIdFor('R', id),
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.seq,
      issues: [],
      pullReqs: [],
      labels: [],
      issueByNum: new Map(),
      pullByNum: new Map(),
      labelColors: new Map(),
      nextIssueNum: 1,
      nextPullNum: 1,
      nextCommentId: 1,
      refs: new Map(),
      tags: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      tagCache: new Map(),
      refsVersion: 0,
      fetchCache: new Map(),
      lsCache: new Map(),
      advUpload: null,
      advReceive: null,
      advVersion: -1,
    };
    this.repos.set(this.keyOfRepo(owner, name), repo);
    return repo;
  }

  removeRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.keyOfRepo(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  ownedRepos(): Repo[] {
    const owned: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) owned.push(repo);
    }
    owned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return owned;
  }

  /** Add an issue to a repo, keeping the by-number index in step. */
  addIssue(repo: Repo, issue: Issue): void {
    repo.issues.push(issue);
    repo.issueByNum.set(issue.number, issue);
  }

  /** Add a pull request to a repo, keeping the by-number index in step. */
  addPull(repo: Repo, pull: PullReq): void {
    repo.pullReqs.push(pull);
    repo.pullByNum.set(pull.number, pull);
  }

  /** Add a label to a repo, keeping the colour map in step. */
  addLabel(repo: Repo, name: string, color: string): void {
    repo.labels.push({ name, color });
    repo.labelColors.set(name, color);
  }

  // ---------------------------------------------------------- git objects

  /** Store an object (deduplicated by oid) and return its oid. */
  putObj(repo: Repo, kind: ObjKind, content: Buffer): string {
    const oid = oidFor(kind, content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, content });
    return oid;
  }

  getObj(repo: Repo, oid: string): ObjEntry | undefined {
    return repo.objects.get(oid);
  }

  /**
   * Parsed views of a repo's objects, memoized per repo. Git objects are
   * immutable by oid (putObj never overwrites, receive-pack only adds new
   * oids), so a parsed result stays valid for the repo's lifetime; the
   * caches die with the repo on delete. Callers must not mutate the
   * returned tree array (setPath copies it before editing).
   */
  commitData(repo: Repo, oid: string): CommitData | undefined {
    const hit = repo.commitCache.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'commit') return undefined;
    const parsed = decodeCommitData(obj.content);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  treeData(repo: Repo, oid: string): TreeEnt[] | undefined {
    const hit = repo.treeCache.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'tree') return undefined;
    const parsed = decodeTreeData(obj.content);
    repo.treeCache.set(oid, parsed);
    return parsed;
  }

  tagData(repo: Repo, oid: string): TagData | undefined {
    const hit = repo.tagCache.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'tag') return undefined;
    const parsed = decodeTagData(obj.content);
    repo.tagCache.set(oid, parsed);
    return parsed;
  }

  /** Drop every cached issue serialization in a repo (issue/comment/label change). */
  dropIssueJson(repo: Repo): void {
    for (const issue of repo.issues) issue.cachedBuf = null;
  }

  /** All refs of a repo as <refname> -> oid (heads, tags, HEAD resolved separately). */
  allRefs(repo: Repo): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, oid] of repo.refs) out.set(`refs/heads/${name}`, oid);
    for (const [name, oid] of repo.tags) out.set(`refs/tags/${name}`, oid);
    return out;
  }

  /** The oid a ref name resolves to, or '' when it does not exist. */
  resolveRef(repo: Repo, ref: string): string {
    if (ref === 'HEAD') return repo.refs.get(DEFAULT_BRANCH) ?? '';
    if (ref.startsWith('refs/heads/')) return repo.refs.get(ref.slice('refs/heads/'.length)) ?? '';
    if (ref.startsWith('refs/tags/')) {
      const oid = repo.tags.get(ref.slice('refs/tags/'.length)) ?? '';
      if (oid === '') return '';
      const tag = this.tagData(repo, oid);
      if (tag) return tag.object;
      return oid;
    }
    // Bare branch name.
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    return '';
  }

  /**
   * True when `ancestor` is reachable from `descendant` (or equal). The
   * common case in a push is a direct parent, so that is checked first
   * without allocating the seen-set and the stack the full walk needs.
   */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (!isOidString(ancestor) || !isOidString(descendant)) return false;
    const head = this.commitData(repo, descendant);
    if (head && head.parents.includes(ancestor)) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitData(repo, oid);
      if (!c) continue;
      for (const p of c.parents) stack.push(p);
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first (parents after children). */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    // Index cursor instead of shift(): shift() is O(n) per step on a queue.
    const pending: string[] = [tip];
    let at = 0;
    while (at < pending.length) {
      const oid = pending[at] as string;
      at += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitData(repo, oid);
      if (!c) continue;
      out.push(oid);
      for (const p of c.parents) pending.push(p);
    }
    return out;
  }

  /** Every object reachable from a set of tips (commits, trees, blobs, tags). */
  reachable(repo: Repo, tips: string[]): Map<string, ObjEntry> {
    const found = new Map<string, ObjEntry>();
    const stack: string[] = [...tips];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      found.set(oid, obj);
      if (obj.kind === 'commit') {
        const c = this.commitData(repo, oid);
        if (c) {
          stack.push(c.tree);
          for (const p of c.parents) stack.push(p);
        }
      } else if (obj.kind === 'tree') {
        for (const e of this.treeData(repo, oid) ?? []) stack.push(e.oid);
      } else if (obj.kind === 'tag') {
        const t = this.tagData(repo, oid);
        if (t) stack.push(t.object);
      }
    }
    return found;
  }

  /** Objects reachable from `wants` minus those reachable from `haves`. */
  minusHaves(repo: Repo, wants: string[], haves: string[]): Map<string, ObjEntry> {
    const held = this.reachable(repo, haves);
    const wanted = this.reachable(repo, wants);
    for (const oid of held.keys()) wanted.delete(oid);
    return wanted;
  }

  /** Haves that are ancestors of (or equal to) the wants: the common base. */
  commonHaves(repo: Repo, wants: string[], haves: string[]): string[] {
    const ancestorsOfWants = new Set<string>();
    const stack: string[] = [];
    for (const w of wants) {
      // Tag wants peel to their target commit before ancestry is computed.
      const peeled = this.peelToCommit(repo, w);
      stack.push(peeled !== '' ? peeled : w);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestorsOfWants.has(oid)) continue;
      ancestorsOfWants.add(oid);
      const c = this.commitData(repo, oid);
      if (c) {
        for (const p of c.parents) stack.push(p);
      }
    }
    return haves.filter((h) => ancestorsOfWants.has(h));
  }

  /**
   * Distance (1-based, want = 1) from the wants to the deepest reachable
   * shallow boundary, peeling tag wants to their target commits. 0 when no
   * boundary is reachable.
   */
  boundaryDepth(repo: Repo, wants: string[], boundaries: string[]): number {
    const boundarySet = new Set(boundaries);
    const seen = new Set<string>();
    const pending: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const peeled = this.peelToCommit(repo, w);
      if (peeled !== '') pending.push({ oid: peeled, d: 1 });
    }
    let best = 0;
    let at = 0;
    while (at < pending.length) {
      const { oid, d } = pending[at] as { oid: string; d: number };
      at += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (boundarySet.has(oid)) best = Math.max(best, d);
      const c = this.commitData(repo, oid);
      if (c) {
        for (const p of c.parents) pending.push({ oid: p, d: d + 1 });
      }
    }
    return best;
  }

  /** Peel a tag (possibly nested) to its target commit oid, or '' if none. */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let i = 0; i < 8; i++) {
      const obj = repo.objects.get(current);
      if (!obj) return '';
      if (obj.kind === 'commit') return current;
      if (obj.kind === 'tag') {
        const t = this.tagData(repo, current);
        if (!t) return '';
        current = t.object;
        continue;
      }
      return '';
    }
    return '';
  }

  /**
   * Depth-limited walk: commits within `depth` steps of `wants` (depth 1 = the
   * want commits only), minus anything reachable from `haves`. Returns the
   * commits to send, the objects to send, and the new shallow boundary oids.
   */
  walkDepth(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number,
    shallowBoundaries: string[] = [],
  ): { commits: string[]; objects: Map<string, ObjEntry>; shallow: string[] } {
    // A "have" that is also a shallow boundary is held by the client as a
    // commit plus its tree, but NOT its parents: exclude only the commit and
    // its tree from the pack, never its ancestors (a deepen must deliver them).
    const boundarySet = new Set(shallowBoundaries);
    const heldSet = new Set<string>();
    for (const h of haves) {
      const obj = repo.objects.get(h);
      if (boundarySet.has(h) && obj?.kind === 'commit') {
        heldSet.add(h);
        const c = this.commitData(repo, h);
        if (c) {
          for (const [o] of this.reachable(repo, [c.tree])) heldSet.add(o);
        }
      } else {
        for (const [o] of this.reachable(repo, [h])) heldSet.add(o);
      }
    }
    const commits: string[] = [];
    const shallow: string[] = [];
    const seen = new Set<string>();
    // Tag wants peel to their target commit for the walk; the tag objects
    // themselves are still sent (unless the client already has them).
    const tagWants: string[] = [];
    const roots: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj?.kind === 'tag') {
        tagWants.push(w);
        const peeled = this.peelToCommit(repo, w);
        if (peeled !== '') roots.push({ oid: peeled, d: 1 });
      } else {
        roots.push({ oid: w, d: 1 });
      }
    }
    const pending: Array<{ oid: string; d: number }> = roots;
    let at = 0;
    while (at < pending.length) {
      const { oid, d } = pending[at] as { oid: string; d: number };
      at += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitData(repo, oid);
      if (!c) continue;
      commits.push(oid);
      if (d >= depth) {
        shallow.push(oid);
        continue;
      }
      for (const p of c.parents) pending.push({ oid: p, d: d + 1 });
    }
    // Only the walked commits and their trees/blobs go in the pack: never
    // leak ancestors' trees through a full reachability walk.
    const objects = new Map<string, ObjEntry>();
    for (const tagOid of tagWants) {
      const tagObj = repo.objects.get(tagOid);
      if (tagObj && !heldSet.has(tagOid)) objects.set(tagOid, tagObj);
    }
    for (const oid of commits) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (!heldSet.has(oid)) objects.set(oid, obj);
      if (obj.kind === 'commit') {
        const c = this.commitData(repo, oid);
        if (c) {
          for (const [o, tobj] of this.reachable(repo, [c.tree])) {
            if (!heldSet.has(o)) objects.set(o, tobj);
          }
        }
      }
    }
    return { commits, objects, shallow };
  }

  /** The tree oid at a ref, or '' when the ref has no commit. */
  treeAt(repo: Repo, ref: string): string {
    const tip = this.resolveRef(repo, ref);
    if (tip === '') return '';
    return this.commitData(repo, tip)?.tree ?? '';
  }

  /** Read one path out of a tree (recursive). Returns the blob entry or undefined. */
  lookup(repo: Repo, treeOid: string, path: string): TreeEnt | undefined {
    if (treeOid === '') return undefined;
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeData(repo, current);
      if (!entries) return undefined;
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List a directory tree's entries ('' = root). */
  listDir(repo: Repo, treeOid: string, path: string): TreeEnt[] | undefined {
    if (treeOid === '') return undefined;
    if (path === '' || path === '/') {
      return this.treeData(repo, treeOid);
    }
    const entry = this.lookup(repo, treeOid, path);
    if (!entry || entry.mode !== '40000') return undefined;
    return this.treeData(repo, entry.oid);
  }

  /**
   * Build a new tree with `path` set to `blobOid` (or removed when null),
   * starting from `baseTreeOid` ('' for an empty tree). Returns the new tree oid.
   */
  setPath(repo: Repo, baseTreeOid: string, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rebuild = (treeOid: string, depth: number): string => {
      // Copy the cached entries: this function edits the list in place.
      const entries: TreeEnt[] = treeOid === '' ? [] : [...(this.treeData(repo, treeOid) ?? [])];
      const name = parts[depth] as string;
      const last = depth === parts.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (last) {
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const child = idx >= 0 ? entries[idx] : undefined;
        const childTree = child && child.mode === '40000' ? child.oid : '';
        const newChild = rebuild(childTree, depth + 1);
        const newChildObj = repo.objects.get(newChild);
        const empty = !newChildObj || (newChildObj.kind === 'tree' && newChildObj.content.length === 0);
        if (empty) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      const sorted = orderTreeEnts(entries);
      return this.putObj(repo, 'tree', encodeTreeData(sorted));
    };
    return rebuild(baseTreeOid, 0);
  }

  /**
   * Create a commit object on `branch` ('' tip = unborn). Returns the new
   * commit oid. Moving the branch drops the ref-dependent response caches.
   */
  commitNew(repo: Repo, branch: string, treeOid: string, message: string): string {
    const { epoch } = this.tickClock();
    const parent = repo.refs.get(branch) ?? '';
    const lines: string[] = [`tree ${treeOid}`];
    if (parent !== '' && isOidString(parent)) lines.push(`parent ${parent}`);
    const person = personLine(epoch);
    lines.push(`author ${person}`, `committer ${person}`, '', message);
    const content = Buffer.from(lines.join('\n'), 'utf8');
    const oid = this.putObj(repo, 'commit', content);
    repo.refs.set(branch, oid);
    bumpRefs(repo);
    return oid;
  }

  /** Paths changed between two trees (recursive), as filename -> 'added' | 'modified' | 'deleted'. */
  diffTrees(repo: Repo, oldTree: string, newTree: string): Map<string, 'added' | 'modified' | 'deleted'> {
    const out = new Map<string, 'added' | 'modified' | 'deleted'>();
    const flatten = (treeOid: string, prefix: string, into: Map<string, string>): void => {
      if (treeOid === '') return;
      for (const e of this.treeData(repo, treeOid) ?? []) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') flatten(e.oid, path, into);
        else into.set(path, e.oid);
      }
    };
    const oldFiles = new Map<string, string>();
    const newFiles = new Map<string, string>();
    flatten(oldTree, '', oldFiles);
    flatten(newTree, '', newFiles);
    for (const [path, oid] of newFiles) {
      if (!oldFiles.has(path)) out.set(path, 'added');
      else if (oldFiles.get(path) !== oid) out.set(path, 'modified');
    }
    for (const path of oldFiles.keys()) {
      if (!newFiles.has(path)) out.set(path, 'deleted');
    }
    return out;
  }

  /** Line counts for a pull-request file entry (multiset diff of lines). */
  lineStats(repo: Repo, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    // Split a blob into lines; missing/non-blob/empty content has no lines.
    const splitLines = (oid: string | undefined): string[] => {
      if (!oid) return [];
      const obj = repo.objects.get(oid);
      if (!obj || obj.kind !== 'blob') return [];
      const text = obj.content.toString('utf8');
      if (text === '') return [];
      return text.split('\n');
    };
    // Count how many copies of each line the new side has beyond the old side.
    const countBeyond = (from: string[], against: string[]): number => {
      const have = new Map<string, number>();
      for (const line of against) have.set(line, (have.get(line) ?? 0) + 1);
      let extra = 0;
      const used = new Map<string, number>();
      for (const line of from) {
        used.set(line, (used.get(line) ?? 0) + 1);
        if ((have.get(line) ?? 0) < (used.get(line) as number)) extra += 1;
      }
      return extra;
    };
    const oldLines = splitLines(oldOid);
    const newLines = splitLines(newOid);
    let additions = countBeyond(newLines, oldLines);
    let deletions = countBeyond(oldLines, newLines);
    if (additions === 0 && deletions === 0 && (oldOid !== newOid)) {
      // Same lines, different bytes (e.g. no trailing newline): count as one change.
      additions = newOid !== undefined && oldOid === undefined ? Math.max(1, newLines.length) : 1;
    }
    return { additions, deletions };
  }
}

export { NULL_OID };
