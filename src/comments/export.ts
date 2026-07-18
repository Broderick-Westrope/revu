import { LocalComment, QuotedThread } from './model';

function quoteLines(text: string): string[] {
  return text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>'));
}

function renderQuotedThread(quoted: QuotedThread): string[] {
  const location = quoted.line !== undefined ? `${quoted.path} line ${quoted.line}` : quoted.path;
  const lines = [`> **Quoted PR comment** (@${quoted.author}, on ${location}):`];
  lines.push(...quoteLines(quoted.body));
  if (quoted.diffHunk !== undefined) {
    lines.push('>');
    lines.push('> ```');
    lines.push(...quoteLines(quoted.diffHunk));
    lines.push('> ```');
  }
  return lines;
}

export function renderComment(comment: LocalComment, index = 1): string {
  const lineLabel =
    comment.startLine === comment.endLine
      ? `(line ${comment.startLine})`
      : `(lines ${comment.startLine}-${comment.endLine})`;
  const lines: string[] = [`### Comment ${index} ${lineLabel}`, ''];
  lines.push('```' + comment.languageId);
  lines.push(comment.codeSnippet.replace(/\n$/, ''));
  lines.push('```');
  lines.push('');
  if (comment.quotedThread) {
    lines.push(...renderQuotedThread(comment.quotedThread));
    lines.push('');
  }
  lines.push(comment.text);
  return lines.join('\n');
}

export function renderAll(comments: LocalComment[]): string {
  const byFile = new Map<string, LocalComment[]>();
  for (const comment of comments) {
    const existing = byFile.get(comment.path);
    if (existing) {
      existing.push(comment);
    } else {
      byFile.set(comment.path, [comment]);
    }
  }
  const sections = [...byFile.keys()].sort().map((file) => {
    const fileComments = byFile
      .get(file)!
      .slice()
      .sort((a, b) => a.startLine - b.startLine);
    const rendered = fileComments.map((c, i) => renderComment(c, i + 1)).join('\n\n');
    return `## ${file}\n\n${rendered}`;
  });
  return `# Review comments\n\n${sections.join('\n\n')}\n`;
}
