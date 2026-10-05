// ponytail: covers the glob syntax VS Code settings use (**, *, ?, {a,b}, [abc], [!abc]); swap in
// minimatch if someone's exclude pattern needs more than that.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braceDepth++;
      re += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
    } else if (c === "," && braceDepth > 0) {
      re += "|";
    } else if (c === "[" && glob.indexOf("]", i + 1) > i) {
      const end = glob.indexOf("]", i + 1);
      const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
      re += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|\\[\]{}]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}
