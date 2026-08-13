export interface GuideFile {
  path: string;
  note?: string;
}

export interface GuideGroup {
  title: string;
  theme: string;
  attention: string[];
  files: GuideFile[];
}

export interface Guide {
  summary: string;
  groups: GuideGroup[];
}

export interface CachedGuide {
  guide: Guide;
  scopeKey: string;
  hash: string;
  generatedAt: string;
  baseSha?: string;
}

function extractFencedJson(raw: string): string | undefined {
  const match = /```json\s*\n([\s\S]*?)\n\s*```/.exec(raw);
  return match ? match[1] : undefined;
}

function extractBalancedJson(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
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
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateGuide(value: unknown): Guide {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Guide is not an object');
  }
  const obj = value as Record<string, unknown>;
  if (!isNonEmptyString(obj.summary)) {
    throw new Error('Guide summary is missing or empty');
  }
  if (!Array.isArray(obj.groups) || obj.groups.length === 0) {
    throw new Error('Guide groups is missing or empty');
  }
  const groups: GuideGroup[] = obj.groups.map((raw: unknown, i: number) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Group ${i + 1} is not an object`);
    }
    const g = raw as Record<string, unknown>;
    if (!isNonEmptyString(g.title)) {
      throw new Error(`Group ${i + 1} title is missing or empty`);
    }
    if (!isNonEmptyString(g.theme)) {
      throw new Error(`Group ${i + 1} theme is missing or empty`);
    }
    if (!Array.isArray(g.attention) || !g.attention.every(isNonEmptyString)) {
      throw new Error(`Group ${i + 1} attention must be an array of non-empty strings`);
    }
    if (!Array.isArray(g.files) || g.files.length === 0) {
      throw new Error(`Group ${i + 1} must contain at least one file`);
    }
    const files: GuideFile[] = g.files.map((rawFile: unknown, j: number) => {
      if (typeof rawFile !== 'object' || rawFile === null) {
        throw new Error(`Group ${i + 1} file ${j + 1} is not an object`);
      }
      const f = rawFile as Record<string, unknown>;
      if (!isNonEmptyString(f.path)) {
        throw new Error(`Group ${i + 1} file ${j + 1} path is missing or empty`);
      }
      return isNonEmptyString(f.note) ? { path: f.path, note: f.note } : { path: f.path };
    });
    return { title: g.title, theme: g.theme, attention: g.attention, files };
  });
  return { summary: obj.summary, groups };
}

export function reconcileGuide(guide: Guide, changedPaths: string[]): Guide {
  const allowed = new Set(changedPaths);
  const seen = new Set<string>();
  const groups: GuideGroup[] = [];
  for (const group of guide.groups) {
    const files = group.files.filter((f) => {
      if (!allowed.has(f.path) || seen.has(f.path)) {
        return false;
      }
      seen.add(f.path);
      return true;
    });
    if (files.length > 0) {
      groups.push({ ...group, files });
    }
  }
  const missing = changedPaths.filter((p) => !seen.has(p));
  if (missing.length > 0) {
    groups.push({
      title: 'Other changes',
      theme: 'Files not classified by the guide generator',
      attention: [],
      files: missing.map((path) => ({ path })),
    });
  }
  return { summary: guide.summary, groups };
}

export function parseGuide(raw: string): Guide {
  const candidate = extractFencedJson(raw) ?? extractBalancedJson(raw);
  if (!candidate) {
    throw new Error('No JSON object found in agent output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Agent output is not valid JSON: ${(err as Error).message}`);
  }
  return validateGuide(parsed);
}
