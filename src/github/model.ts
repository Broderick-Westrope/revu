export interface PrSummary {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefName: string;
  baseRefName: string;
}

export interface GhStackBranch {
  name: string;
  base: string;
  isMerged: boolean;
  needsRebase: boolean;
}

export interface GhStackView {
  trunk: string;
  branches: GhStackBranch[];
}

export interface GhThreadComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface GhReviewThread {
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  diffHunk: string;
  comments: GhThreadComment[];
}
