import { execFile } from 'child_process';
import { GhReviewThread, PrMetadata } from './model';

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
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

export async function fetchPrMetadata(cwd: string): Promise<PrMetadata | undefined> {
  try {
    const output = await gh(cwd, ['pr', 'view', '--json', 'number,title,body,baseRefName,url']);
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

export function parseThreadsResponse(json: string): GhReviewThread[] {
  const parsed = JSON.parse(json) as RawResponse;
  const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
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
