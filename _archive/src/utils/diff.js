/**
 * Line-by-line Longest Common Subsequence (LCS) diffing utility.
 * Compares oldText and newText, and returns newText with custom tags
 * wrapping the added/modified parts.
 */
export function diffLines(oldText, newText) {
  if (!oldText) return newText;
  if (!newText) return "";

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const n = oldLines.length;
  const m = newLines.length;

  // DP table for LCS
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const oldLineTrimmed = oldLines[i - 1].trim();
    for (let j = 1; j <= m; j++) {
      const newLineTrimmed = newLines[j - 1].trim();
      if (oldLineTrimmed === newLineTrimmed && oldLineTrimmed !== "") {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff representation
  let i = n;
  let j = m;
  const resultLines = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1].trim() === newLines[j - 1].trim() && oldLines[i - 1].trim() !== "") {
      // Matched line
      resultLines.unshift({ text: newLines[j - 1], type: 'normal' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Added line
      resultLines.unshift({ text: newLines[j - 1], type: 'added' });
      j--;
    } else {
      // Deleted line (we don't show deletions for a clean reading view)
      i--;
    }
  }

  // Process the result lines to group contiguous added lines in custom tags
  const processedLines = [];
  let inAddedBlock = false;

  for (const line of resultLines) {
    // Avoid highlighting empty lines to keep layout clean
    const isLineEmpty = line.text.trim() === "";

    if (line.type === 'added' && !isLineEmpty) {
      if (!inAddedBlock) {
        processedLines.push("<diff-added-block>");
        inAddedBlock = true;
      }
      processedLines.push(line.text);
    } else {
      if (inAddedBlock) {
        processedLines.push("</diff-added-block>");
        inAddedBlock = false;
      }
      processedLines.push(line.text);
    }
  }

  if (inAddedBlock) {
    processedLines.push("</diff-added-block>");
  }

  return processedLines.join('\n');
}
