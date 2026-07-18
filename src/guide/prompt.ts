import { ChangedFile } from '../git';

const MAX_LINES_PER_FILE = 400;
const MAX_PROMPT_CHARS = 150000;

const INSTRUCTIONS = `You are generating a code review guide for a set of changed files.

Group related changed files by theme: keep generated code together, keep related tests together, and keep one functional unit per group. Order the groups so the core functional changes come first and low-signal changes (generated files, lockfiles) come last. For each group provide a short title, a one-line theme describing what the group is about, and "pay attention to" bullets highlighting risky or noteworthy aspects. Every changed file must appear in exactly one group.

Respond with only a JSON object matching this schema, and nothing else:

{
  "summary": "1-3 sentence overview of the whole change",
  "groups": [
    {
      "title": "short group title",
      "theme": "one-line commentary on what this group is about",
      "attention": ["pay attention to bullet", "..."],
      "files": [
        { "path": "relative/file/path", "note": "optional per-file note" }
      ]
    }
  ]
}`;

interface DiffSection {
  header: string;
  body: string;
}

function splitDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    const newlineIndex = part.indexOf('\n');
    if (newlineIndex === -1) {
      sections.push({ header: part, body: '' });
    } else {
      sections.push({ header: part.slice(0, newlineIndex), body: part.slice(newlineIndex + 1) });
    }
  }
  return sections;
}

function truncateBody(body: string): string {
  const lines = body.split('\n');
  if (lines.length <= MAX_LINES_PER_FILE) {
    return body;
  }
  const kept = lines.slice(0, MAX_LINES_PER_FILE);
  const dropped = lines.length - MAX_LINES_PER_FILE;
  return kept.join('\n') + `\n[... truncated ${dropped} lines]`;
}

function fileListSection(files: ChangedFile[]): string {
  const lines = files.map((f) =>
    f.status === 'R' ? `${f.status}\t${f.oldPath ?? ''} -> ${f.path}` : `${f.status}\t${f.path}`
  );
  return `## Changed files (name-status)\n\n${lines.join('\n')}`;
}

function assemble(instructions: string, prSection: string, fileList: string, diffSection: string): string {
  const parts = [instructions];
  if (prSection) {
    parts.push(prSection);
  }
  parts.push(fileList, diffSection);
  return parts.join('\n\n');
}

export function buildPrompt(files: ChangedFile[], diff: string, prContext?: string): string {
  const prSection = prContext ? `## Pull request context\n\n${prContext}` : '';
  const fileList = fileListSection(files);
  const sections = splitDiff(diff).map((s) => ({
    header: s.header,
    body: truncateBody(s.body),
  }));

  const render = (): string =>
    assemble(
      INSTRUCTIONS,
      prSection,
      fileList,
      `## Unified diff\n\n${sections.map((s) => (s.body ? `${s.header}\n${s.body}` : s.header)).join('\n')}`
    );

  let prompt = render();
  if (prompt.length <= MAX_PROMPT_CHARS) {
    return prompt;
  }

  const order = sections
    .map((s, i) => ({ index: i, size: s.body.length }))
    .sort((a, b) => b.size - a.size);
  for (const { index } of order) {
    if (prompt.length <= MAX_PROMPT_CHARS) {
      break;
    }
    if (!sections[index].body) {
      continue;
    }
    sections[index].body = '[diff omitted for size]';
    prompt = render();
  }
  return prompt;
}
