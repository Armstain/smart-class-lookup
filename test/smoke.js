// Quick functional smoke test for the extractor + matcher logic.
// Doesn't touch vscode at all, so it can run with plain node + ts-node-less
// compiled JS in isolation.
const { extractClassesFromSource } = require("../out/astExtractor");
const { parsePastedClassList, extractClassesFromPaste, isStyleInput, parsePastedStyleList, buildArbitraryIndex } = require("../out/classParser");
const { scoreFile, searchTextInFile, rankFiles } = require("../out/matcher");
const { findDuplicateClassGroups } = require("../out/duplicates");

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
  return { file, classes: classSet, locations, mtimeMs: Date.now(), source, arbitraryIndex: buildArbitraryIndex(classSet) };
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

// A raw pasted cn() fragment must not leak bare JS identifiers/operators as class names.
const fromPastedFragment = parsePastedClassList(
  '"p-6 border rounded-lg",\n  isActive ? "bg-red-500 text-white" : "bg-white text-gray-800",'
);
for (const cls of ["p-6", "border", "rounded-lg", "bg-red-500", "text-white", "bg-white", "text-gray-800"]) {
  assert(
    fromPastedFragment.includes(cls),
    `pasted cn() fragment includes real class "${cls}" (got [${fromPastedFragment.join(", ")}])`
  );
}
for (const garbage of ["isActive", "?", ":"]) {
  assert(
    !fromPastedFragment.includes(garbage),
    `pasted cn() fragment does not leak JS syntax "${garbage}" as a class (got [${fromPastedFragment.join(", ")}])`
  );
}


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


// --- Test 9: Proper Inline Style Matching (with px stripping and quotes normalization) ---
const cssPaste = "min-height: 100vh; font-size: 13px; padding-top: 25px;";
assert(isStyleInput(cssPaste), "detects inline CSS as style input");

const styleTokens = parsePastedStyleList(cssPaste);
assert(styleTokens.length === 3, `should parse into 3 style tokens (got ${styleTokens.length})`);
assert(styleTokens.includes("style:minheight:100vh"), "parses min-height: 100vh");
assert(styleTokens.includes("style:fontsize:13"), "normalizes font-size: 13px to style:fontsize:13");
assert(styleTokens.includes("style:paddingtop:25"), "normalizes padding-top: 25px to style:paddingtop:25");

const styleSrc = `
const StyledDiv = () => (
  <div style={{
    minHeight: "100vh",
    fontSize: 13,
    paddingTop: "25",
  }} />
);
`;
const styleEntry = buildEntryFromSource(styleSrc, "/proj/StyledDiv.tsx");
assert(styleEntry.classes.has("style:minheight:100vh"), "extracts minHeight: '100vh'");
assert(styleEntry.classes.has("style:fontsize:13"), "extracts fontSize: 13 (numeric)");
assert(styleEntry.classes.has("style:paddingtop:25"), "extracts paddingTop: '25' (bare string number)");

const styleIndexMap = new Map([["/proj/StyledDiv.tsx", styleEntry]]);
const styleRanked = rankFiles(styleTokens, styleIndexMap);
assert(styleRanked.length === 1, "finds file by proper style tokens");
assert(styleRanked[0].score === 1.0, `perfect match score is 1.0 (got ${styleRanked[0].score})`);


// --- Test 10: Local variable indirection (const styles = cn(...); className={styles}) ---
const varSrc = `
function Widget({ isOpen }) {
  const styles = cn("p-4", isOpen && "block", "rounded-lg");
  const styleObj = { fontSize: "13px" };
  return (
    <div className={styles} style={styleObj}>
      hi
    </div>
  );
}
`;
const varEntry = buildEntryFromSource(varSrc, "/proj/Widget.tsx");
for (const cls of ["p-4", "block", "rounded-lg"]) {
  assert(varEntry.classes.has(cls), `Widget.tsx resolves "${cls}" through const styles = cn(...); className={styles}`);
}
assert(varEntry.classes.has("style:fontsize:13"), "Widget.tsx resolves style={styleObj} back to its object literal");

// --- Test 11: Near-match scoring for arbitrary values (w-[120px] vs w-[124px]) ---
const arbitrarySrc = `<div className={cn("flex", "w-[120px]", "text-[#fff]")} />`;
const arbitraryEntry = buildEntryFromSource(arbitrarySrc, "/proj/Arbitrary.tsx");
const arbitraryInput = parsePastedClassList("flex w-[124px] text-[#fff]");
const nearResult = scoreFile(arbitraryInput, arbitraryEntry);
assert(nearResult !== null, "scoreFile returns a result when an arbitrary value only near-matches");
assert(nearResult.matchedClasses.length === 2, `2 exact matches (flex, text-[#fff]) (got ${nearResult.matchedClasses.length})`);
assert(nearResult.nearMatches.length === 1, `1 near-match for w-[124px]~w-[120px] (got ${nearResult.nearMatches.length})`);
assert(nearResult.nearMatches[0].actual === "w-[120px]", `near-match resolves to the file's actual class (got ${nearResult.nearMatches[0].actual})`);
assert(nearResult.unmatchedClasses.length === 0, "the near-matched class is not also reported as unmatched");
assert(
  Math.abs(nearResult.score - (2 + 0.7) / 3) < 1e-9,
  `score gives partial credit for near matches (got ${nearResult.score})`
);

// A completely unrelated arbitrary value should not near-match.
const unrelatedInput = parsePastedClassList("flex h-[50px]");
const noNearResult = scoreFile(unrelatedInput, arbitraryEntry);
assert(noNearResult.unmatchedClasses.includes("h-[50px]"), "unrelated arbitrary-value utility (h- vs w-) is not falsely near-matched");

// --- Test 12: Duplicate-component detection across files ---
const dupSrcA = `<div className="flex items-center gap-2 rounded-lg p-4 shadow-md" />`;
const dupSrcB = `<span className="flex items-center gap-2 rounded-lg p-4 shadow-md" />`;
const dupSrcC = `<div className="flex" />`;
const dupIndex = new Map([
  ["/proj/A.tsx", buildEntryFromSource(dupSrcA, "/proj/A.tsx")],
  ["/proj/B.tsx", buildEntryFromSource(dupSrcB, "/proj/B.tsx")],
  ["/proj/C.tsx", buildEntryFromSource(dupSrcC, "/proj/C.tsx")],
]);
const dupGroups = findDuplicateClassGroups(dupIndex, 3);
assert(dupGroups.length === 1, `finds exactly 1 duplicated class combination (got ${dupGroups.length})`);
assert(dupGroups[0].occurrences.length === 2, `duplicate group has 2 occurrences (got ${dupGroups[0].occurrences.length})`);
assert(
  new Set(dupGroups[0].occurrences.map((o) => o.file)).size === 2,
  "duplicate group spans 2 distinct files"
);
// --- Test 13: AST Class Replacement ---
const { computeReplacements } = require("../out/classReplacer");

function applyEdits(source, edits) {
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

// Case A: Simple replacement in className
const srcReplaceA = `<div className="flex bg-red-500 p-4" />`;
const editsA = computeReplacements(srcReplaceA, ["bg-red-500"], ["bg-blue-500"]);
const resultA = applyEdits(srcReplaceA, editsA);
assert(resultA === `<div className="flex bg-blue-500 p-4" />`, "simple replacement inside className works");

// Case B: Replacement inside ternary/conditional
const srcReplaceB = `<div className={mobile ? "px-5" : "px-4"} />`;
const editsB = computeReplacements(srcReplaceB, ["px-5"], ["px-6"]);
const resultB = applyEdits(srcReplaceB, editsB);
assert(resultB === `<div className={mobile ? "px-6" : "px-4"} />`, "replacement inside JSX ternary works");

// Case C: Replacement inside template literal
const srcReplaceC = "<span className={`bg-white ${isOpen ? 'shadow-md' : ''}`}>x</span>";
const editsC = computeReplacements(srcReplaceC, ["bg-white"], ["bg-black"]);
const resultC = applyEdits(srcReplaceC, editsC);
assert(resultC === "<span className={`bg-black ${isOpen ? 'shadow-md' : ''}`}>x</span>", "replacement inside template literal works");

// Case D: Deleting a class (replacement is empty)
const srcReplaceD = `<div className="flex bg-red-500 p-4" />`;
const editsD = computeReplacements(srcReplaceD, ["bg-red-500"], []);
const resultD = applyEdits(srcReplaceD, editsD);
assert(resultD === `<div className="flex p-4" />`, "deleting a class works");

// Case E: Replacing variables
const srcReplaceE = `
const styles = cn("p-4", "bg-red-500");
const element = <div className={styles} />;
`;
const editsE = computeReplacements(srcReplaceE, ["bg-red-500"], ["bg-blue-500"]);
const resultE = applyEdits(srcReplaceE, editsE);
assert(resultE.includes('cn("p-4", "bg-blue-500")'), "replacing local variable class declarations works");

// --- Test 13b: Replace preview (collectReplacements / applySelectedEdits) ---
const { collectReplacements, applySelectedEdits, filterCandidateFiles } = require("../out/replacePreview");

const srcPreviewA = `<div className="flex bg-red-500" />`;
const srcPreviewB = `<span className="bg-red-500 p-2" />`;
const previewSources = new Map([
  ["/proj/PreviewA.tsx", srcPreviewA],
  ["/proj/PreviewB.tsx", srcPreviewB],
]);

const occurrences = collectReplacements(previewSources, ["bg-red-500"], ["bg-blue-500"]);
assert(occurrences.length === 2, `collectReplacements finds one occurrence per file (got ${occurrences.length})`);
assert(
  new Set(occurrences.map((o) => o.key)).size === occurrences.length,
  "each occurrence gets a unique key"
);
const occA = occurrences.find((o) => o.file === "/proj/PreviewA.tsx");
assert(occA && occA.before.includes("bg-red-500"), "occurrence 'before' shows the original text");
assert(occA && occA.after.includes("bg-blue-500"), "occurrence 'after' shows the replacement text");
assert(occA && occA.line === 0, `occurrence line is 0-based (got ${occA && occA.line})`);

// Selecting one occurrence's key applies only that one.
const onlyOccB = occurrences.find((o) => o.file === "/proj/PreviewB.tsx");
const partialApply = applySelectedEdits(
  previewSources,
  ["bg-red-500"],
  ["bg-blue-500"],
  new Set([onlyOccB.key])
);
assert(partialApply.applied.length === 1, `only the selected occurrence is applied (got ${partialApply.applied.length})`);
assert(partialApply.applied[0].file === "/proj/PreviewB.tsx", "the applied edit targets the selected file");
assert(partialApply.skippedCount === 0, "nothing is reported skipped when the selected key still exists");

// A key that no longer matches current source (file changed) is skipped, not applied stale.
const changedSources = new Map([
  ["/proj/PreviewA.tsx", `<div className="flex bg-green-500" />`], // no longer contains bg-red-500
  ["/proj/PreviewB.tsx", srcPreviewB],
]);
const staleApply = applySelectedEdits(
  changedSources,
  ["bg-red-500"],
  ["bg-blue-500"],
  new Set(occurrences.map((o) => o.key)) // both original keys selected
);
assert(staleApply.applied.length === 1, `only the still-valid occurrence applies (got ${staleApply.applied.length})`);
assert(staleApply.applied[0].file === "/proj/PreviewB.tsx", "the stale (changed) file's occurrence is not applied");
assert(staleApply.skippedCount === 1, `the changed file's occurrence is reported skipped (got ${staleApply.skippedCount})`);

// filterCandidateFiles: only files whose indexed classes include a target.
const candidateIndex = new Map([
  ["/proj/PreviewA.tsx", buildEntryFromSource(srcPreviewA, "/proj/PreviewA.tsx")],
  ["/proj/PreviewB.tsx", buildEntryFromSource(srcPreviewB, "/proj/PreviewB.tsx")],
]);
const candidates = filterCandidateFiles(candidateIndex, ["bg-red-500"]);
assert(candidates.length === 2, `both files are candidates for bg-red-500 (got ${candidates.length})`);
const noCandidates = filterCandidateFiles(candidateIndex, ["nonexistent-class"]);
assert(noCandidates.length === 0, "no candidates when the target class isn't indexed anywhere");

// --- Test 14: Text term-coverage fallback (phrase not contiguous) ---
const commentSrc = `
function Widget() {
  // TODO: fix the color later
  return <div className="p-4 flex" />;
}
`;
const commentEntry = buildEntryFromSource(commentSrc, "/proj/Widget14.tsx");

// Not a contiguous substring (":" and "the" break it), but all terms co-occur on one line.
const termResult = searchTextInFile("TODO fix color", commentEntry);
assert(termResult !== null, "searchTextInFile matches via scattered term coverage");
assert(termResult.matchType === "text", `term match is typed 'text' (got ${termResult && termResult.matchType})`);
assert(termResult.textPhrase === false, "scattered-term match is not flagged as a phrase");
assert(termResult.locations[0].line === 2, `term match locates the comment line (got ${termResult.locations[0].line})`);

// A single-token contiguous match is still a phrase.
const phraseResult = searchTextInFile("flex", commentEntry);
assert(phraseResult !== null && phraseResult.textPhrase === true, "contiguous single-token match is a phrase");

// --- Test 15: Adaptive ranking — prose query floats text matches above class matches ---
const cardSrc = `<div className="block p-4" />`;
const docSrc = `
// sticky note reminder for the sidebar
export const Doc = () => null;
`;
const adaptiveIndex = new Map([
  ["/proj/Card15.tsx", buildEntryFromSource(cardSrc, "/proj/Card15.tsx")],
  ["/proj/Doc15.tsx", buildEntryFromSource(docSrc, "/proj/Doc15.tsx")],
]);

// "block" is a real utility but "sticky"/"note" are prose, so this is a prose query.
const proseRanked = rankFiles(["block", "sticky", "note"], adaptiveIndex, {
  rawInput: "block sticky note",
});
assert(proseRanked.length === 2, `prose query returns both files (got ${proseRanked.length})`);
assert(
  proseRanked[0].file === "/proj/Doc15.tsx",
  `comment/text match ranks first in a prose query (got ${proseRanked[0].file})`
);
assert(proseRanked[0].matchType === "text", `top prose result is a text match (got ${proseRanked[0].matchType})`);

// A class-heavy query keeps the class match on top.
const classRanked = rankFiles(["block", "p-4"], adaptiveIndex, { rawInput: "block p-4" });
assert(
  classRanked[0].file === "/proj/Card15.tsx",
  `class-heavy query keeps the class match first (got ${classRanked[0].file})`
);

// --- Test 16: class-heavy queries suppress term-coverage noise ---
// A file with zero class overlap but one query word as a property name should not surface here.
const classFileSrc = `<div className="rounded-lg bg-red-500 flex" />`;
const noiseFileSrc = `
const decoration = {
  border: "1px solid",
  borderColor: "red",
};
`;
const noiseIndex = new Map([
  ["/proj/ClassFile16.tsx", buildEntryFromSource(classFileSrc, "/proj/ClassFile16.tsx")],
  ["/proj/NoiseFile16.tsx", buildEntryFromSource(noiseFileSrc, "/proj/NoiseFile16.tsx")],
]);

// 2 of 3 tokens are real classes somewhere -> class-heavy.
const noiseSuppressed = rankFiles(["border", "rounded-lg", "bg-red-500"], noiseIndex, {
  rawInput: "border rounded-lg bg-red-500",
});
assert(noiseSuppressed.length === 1, `noise-only file is excluded for a class-heavy query (got ${noiseSuppressed.length})`);
assert(
  noiseSuppressed[0].file === "/proj/ClassFile16.tsx",
  `only the real class match survives (got ${noiseSuppressed[0].file})`
);

// The same file still surfaces once the query is genuinely prose-shaped.
const noiseSurfaced = rankFiles(["border", "config", "reminder"], noiseIndex, {
  rawInput: "border config reminder",
});
assert(
  noiseSurfaced.some((r) => r.file === "/proj/NoiseFile16.tsx"),
  "the same file surfaces once the overall query is prose-shaped, not class-shaped"
);

console.log("\nDone.");
