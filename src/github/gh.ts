import { run } from '../exec';
import { logWarningOnce } from '../log';
import { GhReviewThread, GhStackView, PrSummary, StackExternal } from './model';

const QUICK_TIMEOUT_MS = 15000;

function gh(cwd: string, args: string[], timeout = 0): Promise<string> {
  return run('gh', args, { cwd, timeout });
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
  const repoJson = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'], QUICK_TIMEOUT_MS);
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

export function parseGhStackView(json: string): GhStackView {
  const raw = JSON.parse(json) as GhStackView;
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
  const raw = JSON.parse(json) as (PrSummary & { isCrossRepository?: boolean })[];
  return raw
    .filter((pr) => PR_STATES.has(pr.state) && !pr.isCrossRepository)
    .map((pr) => ({
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    }));
}

const PR_FIELDS = 'number,url,state,headRefName,baseRefName,isCrossRepository';

const NOT_IN_A_STACK = 2;
const STACK_AMBIGUOUS = 6;

async function fetchGhStack(cwd: string): Promise<Pick<StackExternal, 'ghStack' | 'ghStackFailed'>> {
  try {
    return { ghStack: parseGhStackView(await gh(cwd, ['stack', 'view', '--json'], QUICK_TIMEOUT_MS)) };
  } catch (err) {
    const { code, message, stderr } = err as { code?: number | string; message?: string; stderr?: string };
    const notApplicable =
      code === NOT_IN_A_STACK ||
      code === STACK_AMBIGUOUS ||
      code === 'ENOENT' ||
      /unknown command/i.test(stderr ?? '');
    if (notApplicable) {
      return {};
    }
    logWarningOnce(`gh stack view failed: ${stderr?.trim() || message || String(err)}`);
    return { ghStackFailed: true };
  }
}

export async function fetchStackExternal(cwd: string): Promise<StackExternal> {
  const stack = fetchGhStack(cwd);
  let prsFailed = false;
  const [list, current] = await Promise.all([
    gh(cwd, ['pr', 'list', '--state', 'all', '--limit', '200', '--json', PR_FIELDS], QUICK_TIMEOUT_MS)
      .then(parsePrList)
      .catch((err: Error & { stderr?: string }) => {
        prsFailed = true;
        logWarningOnce(`gh pr list failed: ${err.stderr?.trim() || err.message}`);
        return [] as PrSummary[];
      }),
    gh(cwd, ['pr', 'view', '--json', PR_FIELDS], QUICK_TIMEOUT_MS)
      .then((out) => parsePrList(`[${out}]`))
      .catch(() => [] as PrSummary[]),
  ]);
  const prs = [...current, ...list.filter((pr) => !current.some((c) => c.number === pr.number))];
  return { prs, prsFailed, ...(await stack) };
}
