import { ChangedFile } from '../git';

export const MAX_PROMPT_CHARS = 150000;

const PREAMBLE =
  'You are generating a code review guide. Review the changed files and diff below, then follow the instructions at the end.';

const INSTRUCTIONS = `<instructions>
Group the changed files into a review guide:
- Group files by functional theme. Put the core behavioral change first, then the consumers and consequences of that change. Group tests with the implementation they cover, not in a separate tests bucket, unless the change is test-only. Put mechanical changes (generated code, lockfiles, formatting-only changes, config churn) last.
- Use only paths from <file_list>. Every listed file must appear in exactly one group. Do not invent paths.
- Files with status R are renames; treat their content as moved, not new, unless the diff shows modifications beyond the move.
- Attention notes must reference something concrete and visible in the diff, with a specific scenario or risk. Never write generic advice like "ensure correctness", "verify behavior", or "check for bugs". Maximum 3 attention bullets per group. An empty attention array is better than filler.
- When a per-file note refers to specific lines, start it with "Lines X-Y: " or "Line N: " using new-file line numbers.
- Files marked truncated="true" had their diffs omitted for size; group them using the file list and their role, and do not fabricate details about their contents.
- First, inside <analysis> tags, briefly list the themes you see and assign each file to one (a few lines, not exhaustive). Then output the JSON object. The JSON must be the only content after the closing </analysis> tag.
</instructions>`;

const SCHEMA = `<schema>
The JSON object must match this schema:

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
}

Example output shape:

{
  "summary": "Extracts retry handling into a shared helper and updates its callers.",
  "groups": [
    {
      "title": "Retry helper extraction",
      "theme": "Core behavioral change: retry logic moved into a reusable helper",
      "attention": ["Lines 12-30: the backoff loop now caps at 5 attempts where the old inline version retried forever"],
      "files": [
        { "path": "src/retry.ts", "note": "Lines 12-30: new withRetry helper" },
        { "path": "src/retry.test.ts", "note": "Covers the new attempt cap" }
      ]
    },
    {
      "title": "Mechanical updates",
      "theme": "Lockfile churn from the dependency bump",
      "attention": [],
      "files": [
        { "path": "package-lock.json" }
      ]
    }
  ]
}
</schema>`;

interface DiffSection {
  header: string;
  body: string;
  path?: string;
  truncated: boolean;
}

function headerPath(header: string): string | undefined {
  const match = /^diff --git (?:"?a\/.*?"?) "?b\/(.*?)"?$/.exec(header);
  return match ? match[1] : undefined;
}

export function splitDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    const newlineIndex = part.indexOf('\n');
    const header = newlineIndex === -1 ? part : part.slice(0, newlineIndex);
    const body = newlineIndex === -1 ? '' : part.slice(newlineIndex + 1);
    sections.push({ header, body, path: headerPath(header), truncated: false });
  }
  return sections;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function renderFileElement(section: DiffSection, status: string | undefined): string {
  const attrs = [`path="${escapeAttr(section.path ?? '')}"`];
  if (status) {
    attrs.push(`status="${escapeAttr(status)}"`);
  }
  attrs.push(`truncated="${section.truncated}"`);
  if (section.truncated) {
    return `<file ${attrs.join(' ')} />`;
  }
  const content = section.body ? `${section.header}\n${section.body}` : section.header;
  return `<file ${attrs.join(' ')}>\n${content}\n</file>`;
}

function fileListSection(files: ChangedFile[]): string {
  const lines = files.map((f) =>
    f.status === 'R' ? `${f.status}\t${f.oldPath ?? ''} -> ${f.path}` : `${f.status}\t${f.path}`
  );
  return `<file_list>\n${lines.join('\n')}\n</file_list>`;
}

export function buildPrompt(files: ChangedFile[], diff: string, prContext?: string): string {
  const statusByPath = new Map(files.map((f) => [f.path, f.status]));
  const sections = splitDiff(diff);

  const render = (): string => {
    const parts = [PREAMBLE];
    if (prContext) {
      parts.push(`<pull_request>\n${prContext}\n</pull_request>`);
    }
    parts.push(fileListSection(files));
    const fileElements = sections.map((s) =>
      renderFileElement(s, s.path ? statusByPath.get(s.path) : undefined)
    );
    parts.push(`<diff>\n${fileElements.join('\n')}\n</diff>`);
    parts.push(INSTRUCTIONS, SCHEMA);
    return parts.join('\n\n');
  };

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
    if (sections[index].truncated) {
      continue;
    }
    sections[index].truncated = true;
    sections[index].body = '';
    prompt = render();
  }
  return prompt;
}
