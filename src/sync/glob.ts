/**
 * Minimal gitignore-like matcher for the mirror exclude list.
 *
 * - a pattern without "/" (e.g. `node_modules`, `*.log`) matches a path
 *   segment at any depth;
 * - a pattern with "/" (e.g. `/cache`, `wp-content/uploads`) is anchored to
 *   the mirror root;
 * - `*` and `?` do not cross "/", `**` does.
 *
 * A path is excluded when it or any of its parent folders matches.
 */

function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return re;
}

export function compileExcludes(patterns: readonly string[]): (rel: string) => boolean {
  const rules: Array<{ re: RegExp; anchored: boolean }> = [];
  for (const raw of patterns) {
    let p = String(raw).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p) {
      continue;
    }
    while (p.startsWith('**/') && !p.slice(3).includes('/')) {
      p = p.slice(3);
    }
    const anchored = p.includes('/');
    p = p.replace(/^\/+/, '');
    rules.push({ re: new RegExp(`^${globToRegex(p)}$`), anchored });
  }
  if (!rules.length) {
    return () => false;
  }
  return (rel: string) => {
    let prefix = '';
    for (const part of rel.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      for (const { re, anchored } of rules) {
        if (re.test(anchored ? prefix : part)) {
          return true;
        }
      }
    }
    return false;
  };
}
