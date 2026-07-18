export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  url: string;
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
