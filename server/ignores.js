const crypto = require('crypto');
const {
  load,
  save,
  ignoreKeyOf,
  MAX_IGNORE_REASON_LENGTH,
  MAX_OPERATOR_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const { collectRawHits, todayText } = require('./scan');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 复核期限只收 YYYY-MM-DD，可以不填；填了就得是真实日期，且不能是已经过去的日子
function validateReviewAt(value) {
  const reviewAt = pickText(value);
  if (!reviewAt) return '';
  if (!DATE_PATTERN.test(reviewAt)) {
    throw new ApiError(400, 'REVIEW_AT_INVALID', '复核期限要写成 年-月-日，例如 2026-12-31', 'reviewAt');
  }
  const [year, month, day] = reviewAt.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  if (!valid) throw new ApiError(400, 'REVIEW_AT_INVALID', '复核期限不是一个真实存在的日期', 'reviewAt');
  if (reviewAt < todayText()) {
    throw new ApiError(400, 'REVIEW_AT_PAST', '复核期限不能早于今天', 'reviewAt');
  }
  return reviewAt;
}

function validateReason(value) {
  const reason = pickText(value);
  if (!reason) throw new ApiError(400, 'REASON_REQUIRED', '请写明为什么要忽略这一条', 'reason');
  if (reason.length > MAX_IGNORE_REASON_LENGTH) {
    throw new ApiError(400, 'REASON_TOO_LONG', `忽略理由不能超过 ${MAX_IGNORE_REASON_LENGTH} 个字符`, 'reason');
  }
  return reason;
}

function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再标记忽略', 'operator');
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

function validateLocation(payload, data) {
  const code = pickText(payload.code);
  const filePath = pickText(payload.path);
  const lineNo = Number(payload.lineNo);
  if (!code) throw new ApiError(400, 'CODE_REQUIRED', '缺少规则编码，无法定位要忽略的命中', 'code');
  if (!filePath) throw new ApiError(400, 'PATH_REQUIRED', '缺少文件路径，无法定位要忽略的命中', 'path');
  if (!Number.isInteger(lineNo) || lineNo <= 0) {
    throw new ApiError(400, 'LINE_NO_INVALID', '行号必须是正整数', 'lineNo');
  }

  const rule = data.rules.find((item) => item.code === code);
  if (!rule) throw new ApiError(404, 'RULE_NOT_FOUND', `规则 ${code} 不在清单里，不能忽略它的命中`, 'code');
  const file = data.files.find((item) => item.path === filePath);
  if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', `文件 ${filePath} 不在清单里，不能忽略它的命中`, 'path');

  // 以全量扫描证明这一条命中此刻真实存在，防止凭编码、路径、行号造一条没扫到的记录
  const collected = collectRawHits(data, {});
  const exists = collected.hits.some(
    (hit) => hit.code === code && hit.path === filePath && hit.lineNo === lineNo,
  );
  if (!exists) {
    throw new ApiError(409, 'HIT_NOT_FOUND', `${code} 在 ${filePath} 第 ${lineNo} 行这一轮没有命中，不能标记忽略`, 'lineNo');
  }
  return { code, path: filePath, lineNo, ruleName: rule.name, level: rule.level };
}

// 已忽略清单：逐条回看它现在是否还扫得到。还扫得到表示问题仍在、只是被压住；
// 扫不到说明这一处已经改过（或规则、文件已不存在），不属于"当成修好了"，单独标出来
function decorateIgnore(ignore, rawHits, today) {
  const live = rawHits.find(
    (hit) => hit.code === ignore.code && hit.path === ignore.path && hit.lineNo === ignore.lineNo,
  );
  return {
    ...ignore,
    stillHit: Boolean(live),
    level: live ? live.level : '',
    ruleName: live ? live.ruleName : '',
    fileType: live ? live.fileType : '',
    lineText: live ? live.lineText : '',
    overdue: Boolean(ignore.reviewAt && ignore.reviewAt < today),
  };
}

function listIgnores() {
  const data = load();
  const today = todayText();
  const rawHits = collectRawHits(data, {}).hits;
  const ignores = (data.ignores || [])
    .slice()
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1
      : a.path < b.path ? -1 : a.path > b.path ? 1
        : a.lineNo - b.lineNo))
    .map((item) => decorateIgnore(item, rawHits, today));
  return {
    today,
    ignores,
    total: ignores.length,
    stillHit: ignores.filter((item) => item.stillHit).length,
    overdue: ignores.filter((item) => item.stillHit && item.overdue).length,
  };
}

function createIgnore(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const location = validateLocation(input, data);
  const reason = validateReason(input.reason);
  const reviewAt = validateReviewAt(input.reviewAt);
  const operator = validateOperator(input.operator);

  const key = ignoreKeyOf(location.code, location.path, location.lineNo);
  if ((data.ignores || []).some((item) => ignoreKeyOf(item.code, item.path, item.lineNo) === key)) {
    throw new ApiError(409, 'IGNORE_DUPLICATED', '这一条命中已经标成忽略了，可以在已忽略清单里改或取消', 'lineNo');
  }

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: location.code,
    path: location.path,
    lineNo: location.lineNo,
    reason,
    reviewAt,
    operator,
    createdAt: now,
  };
  data.ignores = data.ignores || [];
  data.ignores.push(created);
  save(data);
  return { ...created, stillHit: true, overdue: false };
}

function deleteIgnore(id) {
  const data = load();
  const list = data.ignores || [];
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'IGNORE_NOT_FOUND', '这条忽略不存在或已经被取消', '');
  const [removed] = list.splice(index, 1);
  save(data);
  return { id: removed.id, code: removed.code, path: removed.path, lineNo: removed.lineNo };
}

module.exports = {
  listIgnores,
  createIgnore,
  deleteIgnore,
};
