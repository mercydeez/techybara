// Minimal, dependency-free glob matching for protected/ignore path patterns.
// Supports the subset we actually need on '/'-separated relative paths:
//   *   any run of characters except '/'
//   **  any run including '/' (zero or more path segments)
//   ?   a single character except '/'
// Everything else is matched literally. Keeping this in-repo means TechyBara
// ships with zero runtime dependencies — trivially auditable for a trust tool.

function escapeLiteral(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // '**/' -> zero or more leading path segments
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        // '**' (typically trailing) -> anything, including '/'
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp("^" + re + "$");
}

/** Compile a set of globs into a single predicate over '/'-separated paths. */
export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns.map(globToRegExp);
  return (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return regexes.some((r) => r.test(normalized));
  };
}
