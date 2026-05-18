// Calling-template matching: build a lookup index from a list of
// `wardCallingTemplates` rows, then resolve a calling name against
// it. Exact match wins; among wildcards, lower `sheet_order` wins.
// Consumed by `syncApplyFix` to classify a Kindoo segment as
// give_app_access / auto_kindoo_access against the per-ward template.

/** Build a per-template lookup index from a list of templates. */
export type TemplateRow = {
  calling_name: string;
  give_app_access: boolean;
  auto_kindoo_access: boolean;
  sheet_order: number;
};

export type TemplateIndex = {
  exact: Map<string, TemplateRow>;
  /** Wildcards in sheet_order ascending; first match wins. */
  wildcards: Array<TemplateRow & { regex: RegExp }>;
};

export function buildTemplateIndex(rows: TemplateRow[]): TemplateIndex {
  const exact = new Map<string, TemplateRow>();
  const wildcards: Array<TemplateRow & { regex: RegExp }> = [];
  for (const row of rows) {
    const name = row.calling_name;
    if (!name) continue;
    if (name.indexOf('*') === -1) {
      exact.set(name, row);
    } else {
      wildcards.push({ ...row, regex: wildcardToRegex(name) });
    }
  }
  wildcards.sort((a, b) => a.sheet_order - b.sheet_order);
  return { exact, wildcards };
}

/** Match a calling-name against the index. Exact wins; among wildcards, sheet_order. */
export function matchTemplate(index: TemplateIndex, callingName: string): TemplateRow | null {
  const e = index.exact.get(callingName);
  if (e) return e;
  for (const w of index.wildcards) {
    if (w.regex.test(callingName)) return w;
  }
  return null;
}

/** Turn a wildcard pattern (with `*`) into an anchored regex. */
export function wildcardToRegex(pattern: string): RegExp {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const rx = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + rx + '$');
}
