export interface QuotedThread {
  author: string;
  body: string;
  path: string;
  line?: number;
  diffHunk?: string;
  url?: string;
}

export interface LocalComment {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  codeSnippet: string;
  languageId: string;
  text: string;
  createdAt: string;
  quotedThread?: QuotedThread;
}
