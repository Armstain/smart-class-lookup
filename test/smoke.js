// Quick functional smoke test for the extractor + matcher logic.
// Doesn't touch vscode at all, so it can run with plain node + ts-node-less
// compiled JS in isolation.
const { extractClassesFromSource } = require("../out/astExtractor");
const { parsePastedClassList, extractClassesFromPaste } = require("../out/classParser");
const { scoreFile } = require("../out/matcher");

function buildEntryFromSource(source, file) {
  const { classes, parseError } = extractClassesFromSource(source, file);
  if (parseError) throw new Error("parse error: " + parseError);
  const classSet = new Set();
  const locations = new Map();
  for (const { className, location } of classes) {
    classSet.add(className);
    const list = locations.get(className) ?? [];
    list.push(location);
    locations.set(className, list);
  }
  return { file, classes: classSet, locations, mtimeMs: Date.now() };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("OK:", msg);
  }
}

// --- Test 1: cn() with conditionals/ternaries (from the spec) ---
const src1 = `
function Modal({ isOpen, mobile }) {
  return (
    <div
      className={cn(
        "relative",
        isOpen && "z-[1050]",
        "bg-base-200",
        mobile ? "px-5" : "px-4",
        "pb-5 pt-4",
        "rounded-2xl shadow-md",
      )}
    >
      hi
    </div>
  );
}
`;
const entry1 = buildEntryFromSource(src1, "/proj/Modal.tsx");
for (const cls of ["relative", "z-[1050]", "bg-base-200", "px-5", "px-4", "pb-5", "pt-4", "rounded-2xl", "shadow-md"]) {
  assert(entry1.classes.has(cls), `Modal.tsx extracted "${cls}" from cn() w/ conditionals/ternary`);
}

// --- Test 2: plain className string + className with template literal ---
const src2 = `
const Card = ({ isOpen }) => (
  <div className="p-4 flex">
    <span className={\`bg-white \${isOpen ? "shadow-md" : ""}\`}>x</span>
  </div>
);
`;
const entry2 = buildEntryFromSource(src2, "/proj/Card.tsx");
for (const cls of ["p-4", "flex", "bg-white", "shadow-md"]) {
  assert(entry2.classes.has(cls), `Card.tsx extracted "${cls}" from plain string + template literal w/ ternary`);
}

// --- Test 3: array form + nested cn(clsx(...)) ---
const src3 = `
const classes = ["p-4", isOpen && "rounded-lg"];
const combined = cn(clsx("relative", "z-10"), "mb-12");
`;
const entry3 = buildEntryFromSource(src3, "/proj/Drawer.tsx");
for (const cls of ["p-4", "rounded-lg", "relative", "z-10", "mb-12"]) {
  assert(entry3.classes.has(cls), `Drawer.tsx extracted "${cls}" from array + nested cn(clsx())`);
}

// --- Test 4: clsx object form + variants + important ---
const src4 = `
<div className={clsx({ "hover:bg-red-500": isError, "md:px-6": true }, "!mt-4", "dark:bg-black")} />
`;
const entry4 = buildEntryFromSource(src4, "/proj/Alert.tsx");
for (const cls of ["hover:bg-red-500", "md:px-6", "!mt-4", "dark:bg-black"]) {
  assert(entry4.classes.has(cls), `Alert.tsx extracted "${cls}" from clsx object form + variants/important`);
}

// --- Test 5: order independence + scoring math (8/9 example from spec) ---
const pasted = parsePastedClassList(
  "relative z-[1050] bg-base-200 px-5 pb-5 pt-4 rounded-2xl shadow-md mb-12"
);
assert(pasted.length === 9, `parsePastedClassList tokenizes to 9 unique classes (got ${pasted.length})`);

// File has 8 of the 9 (missing mb-12), in a totally different order.
const partialSrc = `
<div className={cn("shadow-md", "rounded-2xl", "pt-4", "pb-5", "px-5", "bg-base-200", "z-[1050]", "relative")} />
`;
const partialEntry = buildEntryFromSource(partialSrc, "/proj/Partial.tsx");
const result = scoreFile(pasted, partialEntry);
assert(result !== null, "scoreFile returns a result for a partial match");
assert(result.matchedCount === 8, `matchedCount is 8 (got ${result.matchedCount})`);
assert(Math.abs(result.score - 8 / 9) < 1e-9, `score is 8/9 ≈ 0.888 (got ${result.score})`);

// Reordered identical pasted list should score the SAME against the same file.
const reordered = parsePastedClassList(
  "mb-12 shadow-md rounded-2xl pt-4 pb-5 px-5 bg-base-200 z-[1050] relative"
);
const result2 = scoreFile(reordered, partialEntry);
assert(result2.score === result.score, "order of the pasted class list does not affect the score");

// --- Test 6: extractClassesFromPaste — smart HTML/JSX strip ---
assert(
  extractClassesFromPaste("p-4 flex rounded-lg") === "p-4 flex rounded-lg",
  "plain class list passes through unchanged"
);
assert(
  extractClassesFromPaste('<div class="p-4 flex rounded-lg">') === "p-4 flex rounded-lg",
  "full HTML element: extracts class value"
);
assert(
  extractClassesFromPaste('class="p-4 flex rounded-lg"') === "p-4 flex rounded-lg",
  "bare class= attribute: extracts value"
);
assert(
  extractClassesFromPaste("className=\"p-4 flex rounded-lg\"") === "p-4 flex rounded-lg",
  "className= attribute: extracts value"
);
assert(
  extractClassesFromPaste("className={`p-4 flex rounded-lg`}") === "p-4 flex rounded-lg",
  "className={`...`} template literal form: extracts value"
);
// parsePastedClassList should work end-to-end with HTML input
const fromHtml = parsePastedClassList('<div class="relative z-[1050] bg-base-200">');
assert(
  fromHtml.length === 3 && fromHtml[0] === "relative" && fromHtml[2] === "bg-base-200",
  `parsePastedClassList strips HTML and tokenizes (got [${fromHtml.join(", ")}])`
);

console.log("\nDone.");
