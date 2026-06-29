// Quick functional smoke test for the extractor + matcher logic.
// Doesn't touch vscode at all, so it can run with plain node + ts-node-less
// compiled JS in isolation.
const { extractClassesFromSource } = require("../out/astExtractor");
const { parsePastedClassList, extractClassesFromPaste } = require("../out/classParser");
const { scoreFile, searchTextInFile, rankFiles } = require("../out/matcher");

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
  return { file, classes: classSet, locations, mtimeMs: Date.now(), source };
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
assert(result.maxLineMatches === 8, `maxLineMatches is 8 (got ${result.maxLineMatches})`);
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
assert(
  extractClassesFromPaste('className={"p-4 flex rounded-lg"}') === "p-4 flex rounded-lg",
  "className={\"...\"} expression container form: extracts value"
);
assert(
  extractClassesFromPaste('  className={  "p-4 flex rounded-lg"  }') === "p-4 flex rounded-lg",
  "className={  \"...\"  } expression container form with extra spaces: extracts value"
);
assert(
  extractClassesFromPaste('  className={  `p-4 flex rounded-lg`  }') === "p-4 flex rounded-lg",
  "className={  `...`  } template literal form with extra spaces: extracts value"
);
// --- Test 7: parsePastedClassList token cleaning ---
const fromCnCall = parsePastedClassList('const classes = cn("p-4", isOpen && "bg-red-500", "text-white");');
assert(
  fromCnCall.includes("p-4") && fromCnCall.includes("bg-red-500") && fromCnCall.includes("text-white"),
  `parsePastedClassList extracts classes from cn helper call (got [${fromCnCall.join(", ")}])`
);

const fromTernary = parsePastedClassList('className={isActive ? "bg-red-500" : "bg-blue-500"}');
assert(
  fromTernary.includes("bg-red-500") && fromTernary.includes("bg-blue-500"),
  `parsePastedClassList extracts classes from JSX ternary (got [${fromTernary.join(", ")}])`
);

const fromArray = parsePastedClassList('["p-4", "flex", "items-center"]');
assert(
  fromArray.length === 3 && fromArray[0] === "p-4" && fromArray[1] === "flex" && fromArray[2] === "items-center",
  `parsePastedClassList extracts classes from JS array syntax (got [${fromArray.join(", ")}])`
);

const fromDot = parsePastedClassList('.bg-red-500');
assert(
  fromDot.length === 1 && fromDot[0] === "bg-red-500",
  `parsePastedClassList extracts classes from CSS selectors (got [${fromDot.join(", ")}])`
);


// --- Test 8: Substring text search verification ---
const srcText = `
function MyCustomButton() {
  const handleClick = () => console.log("clicked flatpickr-btn");
  return <button className="p-4" onClick={handleClick}>Click Me</button>;
}
`;
const textEntry = buildEntryFromSource(srcText, "/proj/Button.tsx");

// 1. Verify text search locates substring
const textResult = searchTextInFile("flatpickr-btn", textEntry);
assert(textResult !== null, "searchTextInFile finds substring match");
assert(textResult.matchedCount === 1, `matchedCount for text search is 1 (got ${textResult.matchedCount})`);
assert(textResult.locations[0].line === 2, `located line is 2 (got ${textResult.locations[0].line})`);

// 2. Verify rankFiles merges class results and text results
const indexMap = new Map([
  ["/proj/Button.tsx", textEntry]
]);
const ranked = rankFiles(["p-4"], indexMap, { rawInput: "flatpickr-btn" });
assert(ranked.length === 1, "rankFiles returns the file");
assert(ranked[0].score === 1.0, `score boosted to 1.0 (got ${ranked[0].score})`);
assert(ranked[0].locations.length === 2, `locations merged (got ${ranked[0].locations.length})`);


console.log("\nDone.");
