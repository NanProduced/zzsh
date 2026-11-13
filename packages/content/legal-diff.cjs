const MAX_DIFF_BLOCKS = 400;

function diffBlocks(value) {
  return value.split(/\n+/).map(block => block.trim()).filter(block => block.length > 0);
}

/**
 * 按块比对纯文字（LCS）：相邻的删除 + 新增合并为「修改」，其余标新增 / 删除。
 * 只读比较，不改写任何存储正文；超长文档退化为整篇一块，避免平方级开销失控。
 */
function diffDocumentBlocks(before, after) {
  const left = diffBlocks(before), right = diffBlocks(after);
  if (left.length > MAX_DIFF_BLOCKS || right.length > MAX_DIFF_BLOCKS) {
    return before === after ? [{ status: "UNCHANGED", before, after }] : [{ status: "CHANGED", before, after }];
  }
  const width = right.length + 1;
  const table = new Int32Array((left.length + 1) * width);
  const at = (i, j) => table[i * width + j] ?? 0;
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { ops.push({ type: "EQUAL", text: left[i] }); i += 1; j += 1; }
    else if (at(i + 1, j) >= at(i, j + 1)) { ops.push({ type: "DELETE", text: left[i] }); i += 1; }
    else { ops.push({ type: "INSERT", text: right[j] }); j += 1; }
  }
  while (i < left.length) { ops.push({ type: "DELETE", text: left[i] }); i += 1; }
  while (j < right.length) { ops.push({ type: "INSERT", text: right[j] }); j += 1; }

  const changes = [];
  for (let index = 0; index < ops.length;) {
    const op = ops[index];
    if (op.type === "EQUAL") { changes.push({ status: "UNCHANGED", before: op.text, after: op.text }); index += 1; continue; }
    const removed = [], added = [];
    while (index < ops.length && ops[index].type !== "EQUAL") {
      const run = ops[index];
      if (run.type === "DELETE") removed.push(run.text); else added.push(run.text);
      index += 1;
    }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      const oldText = removed[pair], newText = added[pair];
      if (oldText !== undefined && newText !== undefined) changes.push({ status: "CHANGED", before: oldText, after: newText });
      else if (oldText !== undefined) changes.push({ status: "REMOVED", before: oldText, after: null });
      else changes.push({ status: "ADDED", before: null, after: newText });
    }
  }
  return changes;
}

exports.diffDocumentBlocks = diffDocumentBlocks;
