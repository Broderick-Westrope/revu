import { execFile } from 'child_process';
import { logWarning } from '../log';
import { GhReviewThread, PrMetadata } from './model';
import { GhStackView, PrSummary, StackExternal } from '../stack';

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

let ghAvailable: boolean | undefined;

export async function isGhAvailable(cwd: string): Promise<boolean> {
  if (ghAvailable !== undefined) {
    return ghAvailable;
  }
  try {
    await gh(cwd, ['auth', 'status']);
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  return ghAvailable;
}

export function resetGhAvailability(): void {
  ghAvailable = undefined;
}

export async function fetchPrMetadata(cwd: string, branch?: string): Promise<PrMetadata | undefined> {
  try {
    const target = branch ? [branch] : [];
    const output = await gh(cwd, ['pr', 'view', ...target, '--json', 'number,title,body,baseRefName,url']);
    return JSON.parse(output) as PrMetadata;
  } catch {
    return undefined;
  }
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path line startLine isResolved
          comments(first: 50) {
            nodes { body diffHunk createdAt url author { login } }
          }
        }
      }
    }
  }
}`;

interface RawAuthor {
  login: string;
}

interface RawComment {
  body: string;
  diffHunk: string;
  createdAt: string;
  url: string;
  author: RawAuthor | null;
}

interface RawThread {
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  comments: { nodes: RawComment[] };
}

interface RawResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: RawThread[] };
      };
    };
  };
}

function splitJsonDocuments(output: string): string[] {
  const documents: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        documents.push(output.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return documents;
}

export function parseThreadsResponse(json: string): GhReviewThread[] {
  let responses: RawResponse[];
  try {
    responses = [JSON.parse(json) as RawResponse];
  } catch {
    // Older gh versions emit multiple concatenated JSON documents from
    // `--paginate` instead of one merged document. Split and parse each.
    responses = splitJsonDocuments(json).map((doc) => JSON.parse(doc) as RawResponse);
  }
  const nodes = responses.flatMap(
    (response) => response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
  );
  return nodes.map((node) => ({
    path: node.path,
    line: node.line,
    startLine: node.startLine,
    isResolved: node.isResolved,
    diffHunk: node.comments.nodes[0]?.diffHunk ?? '',
    comments: node.comments.nodes.map((c) => ({
      author: c.author?.login ?? 'ghost',
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
    })),
  }));
}

export async function fetchReviewThreads(cwd: string, prNumber: number): Promise<GhReviewThread[]> {
  const repoJson = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']);
  const nameWithOwner = (JSON.parse(repoJson) as { nameWithOwner: string }).nameWithOwner;
  const [owner, repo] = nameWithOwner.split('/');
  const output = await gh(cwd, [
    'api',
    'graphql',
    '--paginate',
    '-f',
    `query=${REVIEW_THREADS_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `pr=${prNumber}`,
  ]);
  return parseThreadsResponse(output);
}

interface RawStackBranch {
  name: string;
  base: string;
  isMerged: boolean;
  needsRebase: boolean;
}

export function parseGhStackView(json: string): GhStackView {
  const raw = JSON.parse(json) as { trunk: string; branches: RawStackBranch[] };
  return {
    trunk: raw.trunk,
    branches: raw.branches.map((b) => ({
      name: b.name,
      base: b.base,
      isMerged: b.isMerged,
      needsRebase: b.needsRebase,
    })),
  };
}

const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED']);

export function parsePrList(json: string): PrSummary[] {
  const raw = JSON.parse(json) as PrSummary[];
  return raw
    .filter((pr) => PR_STATES.has(pr.state))
    .map((pr) => ({
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    }));
}

const PR_FIELDS = 'number,url,state,headRefName,baseRefName';

let loggedAuthFailure = false;

function fetchGhStack(cwd: string): Promise<GhStackView | undefined> {
  return gh(cwd, ['stack', 'view', '--json'])
    .then(parseGhStackView)
    .catch((err: { code?: number; message?: string }) => {
      if (err.code !== 2 && err.code !== 6) {
        logWarning(`gh stack view failed: ${err.message ?? String(err)}`);
      }
      return undefined;
    });
}

export async function fetchStackExternal(cwd: string): Promise<StackExternal> {
  const ghStack = fetchGhStack(cwd);
  if (!(await isGhAvailable(cwd))) {
    if (!loggedAuthFailure) {
      loggedAuthFailure = true;
      logWarning('gh auth status failed, so PR data is unavailable. Run `gh auth status` to see why.');
    }
    return { prs: [], prsFailed: true, ghStack: await ghStack };
  }
  let prsFailed = false;
  const [list, current] = await Promise.all([
    gh(cwd, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', PR_FIELDS])
      .then(parsePrList)
      .catch((err: Error) => {
        prsFailed = true;
        logWarning(`gh pr list failed: ${err.message}`);
        return [] as PrSummary[];
      }),
    gh(cwd, ['pr', 'view', '--json', PR_FIELDS])
      .then((out) => parsePrList(`[${out}]`))
      .catch(() => [] as PrSummary[]),
  ]);
  const prs = [...current, ...list.filter((pr) => !current.some((c) => c.number === pr.number))];
  return { prs, prsFailed, ghStack: await ghStack };
}
