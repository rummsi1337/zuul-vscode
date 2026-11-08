/**
 * Makes tree item ids unique. The first use of a value stays as it is; repeats get `~2`, `~3`, and
 * so on, skipping any value that is already used.
 */
export function uniqueIds(ids: readonly string[]): string[] {
  const used = new Set(ids);
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
    let n = 2;
    while (used.has(`${id}~${n}`) || seen.has(`${id}~${n}`)) {
      n++;
    }
    const next = `${id}~${n}`;
    seen.add(next);
    return next;
  });
}
