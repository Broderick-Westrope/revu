import * as fs from 'fs';
import * as path from 'path';
import {
  Worktrees,
  checkedOutBranch,
  defaultBranch,
  git,
  isAncestor,
  listWorktrees,
  mergeBase,
  resolveRef,
} from './git';
import { PrSummary, StackExternal } from './github/model';

export { StackExternal };

export type ParentSource = 'override' | 'gh-stack' | 'pr' | 'inferred' | 'trunk';

export interface BranchResolution {
  branch: string;
  parent: string;
  parentRef: string;
  source: ParentSource;
  ambiguous?: boolean;
  warning?: string;
  pr?: PrSummary;
  stackBase?: string;
  inGhStack?: boolean;
  needsRebase?: boolean;
}

export interface CurrentResolution extends BranchResolution {
  diffBase: string;
  onTrunk: boolean;
}

export interface Trunk {
  name: string;
  ref: string;
}

export interface StackResult {
  trunk: Trunk;
  branches: Map<string, BranchResolution>;
  worktrees: Worktrees;
  current?: CurrentResolution;
}

interface Creation {
  sha: string;
  from?: string;
}

interface BranchGraph {
  trunk: Trunk;
  tips: Map<string, string>;
  remoteRefs: Set<string>;
  parents: Map<string, string[]>;
  creations: Map<string, Creation>;
  creationsOffTrunk: Set<string>;
  overrides: Map<string, string>;
  worktrees: Worktrees;
}

const OVERRIDE_SUFFIX = 'revuParent';
const OVERRIDE_KEY = /^branch\.(.+)\.revuparent$/;
const CREATED_FROM = /^branch: Created from (.+)$/;

async function loadGraph(repoRoot: string, external: StackExternal): Promise<BranchGraph> {
  const refsOutput = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const tips = new Map<string, string>();
  const remoteRefs = new Set<string>();
  for (const line of refsOutput.split('\n')) {
    if (!line) {
      continue;
    }
    const [ref, sha] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      tips.set(ref.slice('refs/heads/'.length), sha);
    } else {
      remoteRefs.add(ref.slice('refs/remotes/'.length));
    }
  }

  const trunkName = external.ghStack?.trunk ?? (await defaultBranch(repoRoot));
  const trunk: Trunk = {
    name: trunkName,
    ref: remoteRefs.has(`origin/${trunkName}`) ? `origin/${trunkName}` : trunkName,
  };

  const parents = new Map<string, string[]>();
  const logOutput = await git(repoRoot, ['log', '--format=%H %P', '--branches', '--not', trunk.ref]);
  for (const line of logOutput.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [sha, ...rest] = line.trim().split(' ');
    parents.set(sha, rest);
  }

  const commonDir = (
    await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  const creations = new Map<string, Creation>();
  for (const branch of tips.keys()) {
    const creation = readCreation(path.join(commonDir, 'logs', 'refs', 'heads', branch));
    if (creation) {
      creations.set(branch, creation);
    }
  }

  const creationsOffTrunk = new Set<string>();
  const creationShas = [...new Set([...creations.values()].map((c) => c.sha))];
  if (creationShas.length > 0) {
    const reachable = await git(repoRoot, [
      'log',
      '--format=%H',
      '--ignore-missing',
      ...creationShas,
      '--not',
      trunk.ref,
    ]);
    const offTrunk = new Set(reachable.split('\n').filter(Boolean));
    for (const sha of creationShas) {
      if (offTrunk.has(sha)) {
        creationsOffTrunk.add(sha);
      }
    }
  }

  const overrides = new Map<string, string>();
  const configOutput = await git(
    repoRoot,
    ['config', '--get-regexp', '^branch\\..*\\.revuparent$'],
    [1]
  );
  for (const line of configOutput.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) {
      continue;
    }
    const match = OVERRIDE_KEY.exec(line.slice(0, space));
    if (match) {
      overrides.set(match[1], line.slice(space + 1).trim());
    }
  }

  const worktrees = await listWorktrees(repoRoot);

  return { trunk, tips, remoteRefs, parents, creations, creationsOffTrunk, overrides, worktrees };
}

function readCreation(reflogPath: string): Creation | undefined {
  let content: string;
  try {
    content = fs.readFileSync(reflogPath, 'utf8');
  } catch {
    return undefined;
  }
  const firstLine = content.split('\n')[0];
  const [header, message = ''] = firstLine.split('\t');
  const sha = header.split(' ')[1];
  if (!sha) {
    return undefined;
  }
  const match = CREATED_FROM.exec(message);
  return { sha, from: match?.[1] };
}

class Resolver {
  private readonly ancestorCache = new Map<string, Set<string>>();
  private readonly mergedHeads: Set<string>;
  private readonly openPrs = new Map<string, PrSummary>();
  private readonly anyPrs = new Map<string, PrSummary>();

  constructor(
    private readonly graph: BranchGraph,
    private readonly external: StackExternal
  ) {
    for (const pr of external.prs) {
      if (pr.state === 'OPEN') {
        this.openPrs.set(pr.headRefName, pr);
      }
      if (!this.anyPrs.has(pr.headRefName) || pr.state === 'OPEN') {
        this.anyPrs.set(pr.headRefName, pr);
      }
    }
    this.mergedHeads = new Set(
      external.prs
        .filter((pr) => pr.state === 'MERGED' && !this.openPrs.has(pr.headRefName))
        .map((pr) => pr.headRefName)
    );
  }

  resolveAll(): Map<string, BranchResolution> {
    const direct = new Map<string, BranchResolution>();
    for (const branch of this.graph.tips.keys()) {
      if (branch !== this.graph.trunk.name) {
        direct.set(branch, this.resolveDirect(branch));
      }
    }
    const cyclic = [...direct.keys()].filter((branch) => this.inCycle(branch, direct));
    const overridden = cyclic.filter((branch) => direct.get(branch)?.source === 'override');
    for (const branch of overridden.length > 0 ? overridden : cyclic) {
      const source = direct.get(branch)?.source === 'override' ? 'override' : 'trunk';
      direct.set(branch, { ...this.trunkResolution(branch), source, warning: 'parent cycle' });
    }
    for (const layer of this.external.ghStack?.branches ?? []) {
      const resolution = direct.get(layer.name);
      if (resolution) {
        direct.set(layer.name, { ...resolution, inGhStack: true, needsRebase: layer.needsRebase });
      }
    }
    return direct;
  }

  private inCycle(branch: string, direct: Map<string, BranchResolution>): boolean {
    const visited = new Set<string>();
    let cursor = direct.get(branch)?.parent;
    while (cursor !== undefined && direct.has(cursor) && !visited.has(cursor)) {
      if (cursor === branch) {
        return true;
      }
      visited.add(cursor);
      cursor = direct.get(cursor)?.parent;
    }
    return false;
  }

  private trunkResolution(branch: string): BranchResolution {
    return {
      branch,
      parent: this.graph.trunk.name,
      parentRef: this.graph.trunk.ref,
      source: 'trunk',
      pr: this.anyPrs.get(branch),
    };
  }

  private toBranch(branch: string, parent: string, source: ParentSource): BranchResolution {
    if (parent === this.graph.trunk.name) {
      return { ...this.trunkResolution(branch), source };
    }
    return { branch, parent, parentRef: parent, source, pr: this.anyPrs.get(branch) };
  }

  private resolveDirect(branch: string): BranchResolution {
    let warning: string | undefined;
    const override = this.graph.overrides.get(branch);
    if (override !== undefined) {
      if (override === this.graph.trunk.name || this.graph.tips.has(override)) {
        return this.toBranch(branch, override, 'override');
      }
      warning = 'override target missing';
    }
    const resolved = this.fromGhStack(branch) ?? this.fromPr(branch) ?? this.infer(branch);
    return warning ? { ...resolved, warning } : resolved;
  }

  private fromGhStack(branch: string): BranchResolution | undefined {
    const layers = this.external.ghStack?.branches ?? [];
    const index = layers.findIndex((layer) => layer.name === branch);
    if (index === -1) {
      return undefined;
    }
    let parent = this.graph.trunk.name;
    for (let i = index - 1; i >= 0; i--) {
      if (!layers[i].isMerged && this.graph.tips.has(layers[i].name)) {
        parent = layers[i].name;
        break;
      }
    }
    return { ...this.toBranch(branch, parent, 'gh-stack'), stackBase: layers[index].base };
  }

  private fromPr(branch: string): BranchResolution | undefined {
    const pr = this.openPrs.get(branch);
    if (!pr) {
      return undefined;
    }
    const base = pr.baseRefName;
    if (base === this.graph.trunk.name || this.graph.tips.has(base)) {
      return this.toBranch(branch, base, 'pr');
    }
    if (this.graph.remoteRefs.has(`origin/${base}`)) {
      return { branch, parent: base, parentRef: `origin/${base}`, source: 'pr', pr };
    }
    return undefined;
  }

  private infer(branch: string): BranchResolution {
    const creation = this.graph.creations.get(branch);
    if (creation && !this.graph.creationsOffTrunk.has(creation.sha)) {
      return this.trunkResolution(branch);
    }
    if (creation && this.graph.parents.has(creation.sha)) {
      const candidates = this.otherBranches(branch).filter(
        (candidate) =>
          this.firstParentChain(this.tip(candidate)).has(creation.sha) &&
          this.createdBelow(candidate, creation.sha)
      );
      if (creation.from && candidates.includes(creation.from)) {
        return this.toBranch(branch, creation.from, 'inferred');
      }
      if (candidates.length > 0) {
        return this.nearest(branch, candidates, false);
      }
    }
    const tip = this.tip(branch);
    const own = this.ancestors(tip);
    const forks = this.otherBranches(branch).filter((candidate) => {
      const theirs = this.ancestors(this.tip(candidate));
      const createdFromOwnHistory = own.has(this.graph.creations.get(candidate)?.sha ?? '');
      return !createdFromOwnHistory && !theirs.has(tip) && [...own].some((sha) => theirs.has(sha));
    });
    if (forks.length > 0) {
      return this.nearest(branch, forks, true);
    }
    return this.trunkResolution(branch);
  }

  private otherBranches(branch: string): string[] {
    return [...this.graph.tips.keys()].filter(
      (candidate) =>
        candidate !== branch &&
        candidate !== this.graph.trunk.name &&
        !this.mergedHeads.has(candidate)
    );
  }

  private createdBelow(candidate: string, creationSha: string): boolean {
    const theirs = this.graph.creations.get(candidate);
    if (!theirs) {
      return false;
    }
    if (!this.graph.creationsOffTrunk.has(theirs.sha)) {
      return true;
    }
    return theirs.sha !== creationSha && this.ancestors(creationSha).has(theirs.sha);
  }

  private nearest(branch: string, candidates: string[], ambiguous: boolean): BranchResolution {
    const own = this.ancestors(this.tip(branch));
    const scored = candidates
      .map((candidate) => {
        const theirs = this.ancestors(this.tip(candidate));
        let distance = 0;
        for (const sha of own) {
          if (!theirs.has(sha)) {
            distance++;
          }
        }
        return { candidate, distance, preferred: this.preferred(candidate) ? 0 : 1 };
      })
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.preferred - b.preferred ||
          a.candidate.localeCompare(b.candidate)
      );
    const tie = scored.length > 1 && scored[0].distance === scored[1].distance;
    const resolution = this.toBranch(branch, scored[0].candidate, 'inferred');
    return ambiguous || tie ? { ...resolution, ambiguous: true } : resolution;
  }

  private preferred(branch: string): boolean {
    return (
      this.graph.worktrees.byBranch.has(branch) ||
      (this.external.ghStack?.branches.some((layer) => layer.name === branch) ?? false)
    );
  }

  private tip(branch: string): string {
    return this.graph.tips.get(branch) as string;
  }

  private firstParentChain(sha: string): Set<string> {
    const chain = new Set<string>();
    let cursor: string | undefined = sha;
    while (cursor !== undefined && this.graph.parents.has(cursor) && !chain.has(cursor)) {
      chain.add(cursor);
      cursor = this.graph.parents.get(cursor)?.[0];
    }
    return chain;
  }

  private ancestors(sha: string): Set<string> {
    const cached = this.ancestorCache.get(sha);
    if (cached) {
      return cached;
    }
    const seen = new Set<string>();
    const pending = [sha];
    while (pending.length > 0) {
      const next = pending.pop() as string;
      if (seen.has(next) || !this.graph.parents.has(next)) {
        continue;
      }
      seen.add(next);
      pending.push(...(this.graph.parents.get(next) as string[]));
    }
    this.ancestorCache.set(sha, seen);
    return seen;
  }
}

export async function resolveStack(repoRoot: string, external: StackExternal): Promise<StackResult> {
  const graph = await loadGraph(repoRoot, external);
  const branches = new Resolver(graph, external).resolveAll();
  const branch = await checkedOutBranch(repoRoot);
  if (!branch) {
    return { trunk: graph.trunk, branches, worktrees: graph.worktrees };
  }
  const resolution: BranchResolution = branches.get(branch) ?? {
    branch,
    parent: graph.trunk.name,
    parentRef: graph.trunk.ref,
    source: 'trunk',
  };
  const { diffBase, warning } = await diffBaseFor(repoRoot, resolution, graph.trunk);
  return {
    trunk: graph.trunk,
    branches,
    worktrees: graph.worktrees,
    current: {
      ...resolution,
      ...(warning ? { warning } : {}),
      diffBase,
      onTrunk: branch === graph.trunk.name,
    },
  };
}

async function diffBaseFor(
  repoRoot: string,
  resolution: BranchResolution,
  trunk: Trunk
): Promise<{ diffBase: string; warning?: string }> {
  const mergeHead = await resolveRef(repoRoot, 'MERGE_HEAD');
  if (mergeHead && mergeHead === (await resolveRef(repoRoot, resolution.parentRef))) {
    return { diffBase: mergeHead };
  }
  const parentBase = await mergeBase(repoRoot, resolution.parentRef);
  if (!parentBase) {
    const trunkBase = await mergeBase(repoRoot, trunk.ref);
    if (!trunkBase) {
      throw new Error(`HEAD shares no history with ${resolution.parent} or ${trunk.name}`);
    }
    return { diffBase: trunkBase, warning: `no common history with ${resolution.parent}` };
  }
  return { diffBase: await withStackBase(repoRoot, parentBase, resolution.stackBase) };
}

async function withStackBase(
  repoRoot: string,
  mergeBase: string,
  stackBase: string | undefined
): Promise<string> {
  if (
    stackBase &&
    stackBase !== mergeBase &&
    (await isAncestorOrFalse(repoRoot, stackBase, 'HEAD')) &&
    (await isAncestorOrFalse(repoRoot, mergeBase, stackBase))
  ) {
    return stackBase;
  }
  return mergeBase;
}

async function isAncestorOrFalse(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  return isAncestor(repoRoot, ancestor, descendant).catch(() => false);
}

export function descendantsOf(stack: StackResult, branch: string): Set<string> {
  const found = new Set<string>();
  for (const candidate of stack.branches.keys()) {
    const seen = new Set<string>();
    let cursor = stack.branches.get(candidate)?.parent;
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === branch) {
        found.add(candidate);
        break;
      }
      seen.add(cursor);
      cursor = stack.branches.get(cursor)?.parent;
    }
  }
  return found;
}

export async function setParentOverride(cwd: string, branch: string, parent: string): Promise<void> {
  await git(cwd, ['config', `branch.${branch}.${OVERRIDE_SUFFIX}`, parent]);
}

export async function resetParentOverride(cwd: string, branch: string): Promise<void> {
  try {
    await git(cwd, ['config', '--unset', `branch.${branch}.${OVERRIDE_SUFFIX}`]);
  } catch (err) {
    if ((err as { code?: number }).code !== 5) {
      throw err;
    }
  }
}
