// Keyword rule matching. Keywords match whole words/phrases, case-insensitive.
// A keyword written as /pattern/flags is treated as a regular expression.

export function parseList(str) {
  return String(str || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function compileKeyword(k) {
  const m = k.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i'); } catch { return null; }
  }
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}(?:$|[^\\p{L}\\p{N}])`, 'iu');
}

export function compileRule(rule) {
  return {
    ...rule,
    _include: parseList(rule.include).map(compileKeyword).filter(Boolean),
    _exclude: parseList(rule.exclude).map(compileKeyword).filter(Boolean),
  };
}

function haystack(rule, msg) {
  const f = rule.fields || {};
  const parts = [];
  if (f.subject) parts.push(msg.subject || '');
  if (f.body) parts.push((msg.body || '').slice(0, 8000));
  if (f.sender) parts.push(`${msg.fromName || ''} ${msg.fromEmail || ''}`);
  return parts.join('\n');
}

/** Returns which include keywords matched, or null if the rule does not match. */
export function ruleMatches(compiled, msg) {
  if (!compiled.enabled || !compiled._include.length) return null;
  const text = haystack(compiled, msg);
  if (!text) return null;
  const hits = compiled._include.filter((re) => re.test(text));
  const ok = compiled.matchMode === 'all' ? hits.length === compiled._include.length : hits.length > 0;
  if (!ok) return null;
  if (compiled._exclude.some((re) => re.test(text))) return null;
  return hits.map((re) => re.source);
}

/** First enabled rule (in order) that matches, or null. */
export function evaluate(compiledRules, msg) {
  for (const r of compiledRules) {
    if (ruleMatches(r, msg)) return r;
  }
  return null;
}
