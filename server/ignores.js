const crypto = require('crypto');
const { load, save, MAX_IGNORE_REASON_LENGTH, MAX_OPERATOR_LENGTH, MAX_CODE_LENGTH, MAX_PATH_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条忽略记录占住的位置：规则编码 + 文件路径 + 行号，三者合起来才是范围，
// 不会因为忽略这一条就放过同一规则或同一文件上的其他命中
function spotKey(code, filePath, lineNo) {
  return `${String(code).trim().toLowerCase()}|${String(filePath).trim().toLowerCase()}|${Number(lineNo)}`;
}

// 当前所有活动忽略记录按位置建索引，扫描时逐条命中来这里查
function activeMap(data) {
  const map = new Map();
  data.ignores.forEach((item) => {
    if (!item.revokedAt) map.set(spotKey(item.code, item.path, item.lineNo), item);
  });
  return map;
}

function isOverdue(reviewDate, nowIso) {
  if (!reviewDate) return false;
  const now = nowIso ? new Date(nowIso) : new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [year, month, day] = reviewDate.split('-').map(Number);
  const due = new Date(Date.UTC(year, month - 1, day));
  return due.getTime() < today.getTime();
}

function validateReason(value) {
  const reason = pickText(value);
  if (!reason) {
    throw new ApiError(400, 'IGNORE_REASON_REQUIRED', '请写明忽略这一条命中的理由', 'reason');
  }
  if (reason.length > MAX_IGNORE_REASON_LENGTH) {
    throw new ApiError(400, 'IGNORE_REASON_TOO_LONG', `忽略理由不能超过 ${MAX_IGNORE_REASON_LENGTH} 个字符`, 'reason');
  }
  return reason;
}

function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) {
    throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者，再标记忽略', 'operator');
  }
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名称不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

// 复核期限写成年-月-日，且不能早于今天；到期只是提醒复核，不会自动复活
function validateReviewDate(value) {
  const text = pickText(value);
  if (!text) {
    throw new ApiError(400, 'REVIEW_DATE_REQUIRED', '请写明复核期限', 'reviewDate');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ApiError(400, 'REVIEW_DATE_INVALID', '复核期限要写成年-月-日，例如 2026-12-31', 'reviewDate');
  }
  const [year, month, day] = text.split('-').map(Number);
  const due = new Date(Date.UTC(year, month - 1, day));
  if (due.getUTCFullYear() !== year || due.getUTCMonth() !== month - 1 || due.getUTCDate() !== day) {
    throw new ApiError(400, 'REVIEW_DATE_INVALID', '复核期限不是一个真实存在的日期', 'reviewDate');
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (due.getTime() < today.getTime()) {
    throw new ApiError(400, 'REVIEW_DATE_PAST', '复核期限不能早于今天', 'reviewDate');
  }
  return text;
}

function validateLineNo(value) {
  const lineNo = Number(value);
  if (!Number.isInteger(lineNo) || lineNo <= 0) {
    throw new ApiError(400, 'LINE_NO_INVALID', '行号需要是一个正整数', 'lineNo');
  }
  return lineNo;
}

function validateCode(value) {
  const code = pickText(value);
  if (!code) throw new ApiError(400, 'CODE_REQUIRED', '请填写规则编码', 'code');
  if (code.length > MAX_CODE_LENGTH) {
    throw new ApiError(400, 'CODE_TOO_LONG', `规则编码不能超过 ${MAX_CODE_LENGTH} 个字符`, 'code');
  }
  return code;
}

function validatePath(value) {
  const filePath = pickText(value);
  if (!filePath) throw new ApiError(400, 'PATH_REQUIRED', '请填写文件路径', 'filePath');
  if (filePath.length > MAX_PATH_LENGTH) {
    throw new ApiError(400, 'PATH_TOO_LONG', `文件路径不能超过 ${MAX_PATH_LENGTH} 个字符`, 'filePath');
  }
  return filePath;
}

function findRuleByCode(data, code) {
  const lower = code.toLowerCase();
  return data.rules.find((item) => item.code.toLowerCase() === lower) || null;
}

function findFileByPath(data, filePath) {
  const lower = filePath.toLowerCase();
  return data.files.find((item) => item.path.toLowerCase() === lower) || null;
}

function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

// 看一条活动忽略记录现在对应什么情况：命中还在不在、规则文件还在不在、期限到没到
function evaluateSpot(ignore, data, nowIso) {
  const rule = findRuleByCode(data, ignore.code);
  if (!rule) {
    return { status: 'rule-missing', ruleName: '', level: '', ruleStatus: '', currentLineText: '' };
  }
  const file = findFileByPath(data, ignore.path);
  if (!file) {
    return { status: 'file-missing', ruleName: rule.name, level: rule.level, ruleStatus: rule.status, currentLineText: '' };
  }
  const lines = file.content.split('\n');
  if (ignore.lineNo > lines.length) {
    return { status: 'line-gone', ruleName: rule.name, level: rule.level, ruleStatus: rule.status, currentLineText: '' };
  }
  if (rule.status !== '启用') {
    return { status: 'rule-disabled', ruleName: rule.name, level: rule.level, ruleStatus: rule.status, currentLineText: '' };
  }
  const lineText = (lines[ignore.lineNo - 1] || '').trim();
  const stillThere = ruleAppliesToFile(rule, file) && lineText.includes(rule.pattern);
  return {
    status: stillThere ? 'still-there' : 'not-hit',
    ruleName: rule.name,
    level: rule.level,
    ruleStatus: rule.status,
    currentLineText: lineText,
  };
}

// 标记忽略：只接受当前确实扫得到的命中，范围落死在编码、路径与行号上
function createIgnore(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const code = validateCode(input.code);
  const filePath = validatePath(input.path);
  const lineNo = validateLineNo(input.lineNo);
  const reason = validateReason(input.reason);
  const reviewDate = validateReviewDate(input.reviewDate);
  const operator = validateOperator(input.operator);

  const data = load();
  const rule = findRuleByCode(data, code);
  if (!rule) {
    throw new ApiError(404, 'IGNORE_RULE_NOT_FOUND', `规则 ${code} 不在清单里，没法按它标记忽略`, 'code');
  }
  const file = findFileByPath(data, filePath);
  if (!file) {
    throw new ApiError(404, 'IGNORE_FILE_NOT_FOUND', `文件 ${filePath} 不在清单里，没法按它标记忽略`, 'filePath');
  }
  if (lineNo > file.content.split('\n').length) {
    throw new ApiError(400, 'IGNORE_LINE_OUT_OF_RANGE', '这个行号已经超出文件当前的行数', 'lineNo');
  }

  // 能标记的必须是此刻真扫得到的一条命中，避免把范围标到不相干的位置上
  const lineText = file.content.split('\n')[lineNo - 1] || '';
  const reallyHits = rule.status === '启用'
    && ruleAppliesToFile(rule, file)
    && lineText.includes(rule.pattern);
  if (!reallyHits) {
    throw new ApiError(409, 'IGNORE_SPOT_NOT_HIT', '这个位置当前没有扫出命中，不能标记忽略', '');
  }

  const key = spotKey(code, filePath, lineNo);
  const duplicated = data.ignores.find((item) => !item.revokedAt && spotKey(item.code, item.path, item.lineNo) === key);
  if (duplicated) {
    throw new ApiError(409, 'IGNORE_DUPLICATED', '这一条命中已经标记过忽略了，可以在已忽略清单里撤销', '');
  }

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: rule.code,
    path: file.path,
    lineNo,
    reason,
    reviewDate,
    operator,
    createdAt: now,
    revokedAt: '',
    revokedBy: '',
    lastSeenAt: now,
    lastLineText: lineText.trim(),
  };
  data.ignores.push(created);
  save(data);
  return decorate(created, data, now);
}

// 撤销忽略：记录本身保留备查，只是不再压住命中
function revokeIgnore(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = validateOperator(input.operator);
  const data = load();
  const found = data.ignores.find((item) => item.id === id && !item.revokedAt);
  if (!found) {
    throw new ApiError(404, 'IGNORE_NOT_FOUND', '这条忽略记录不存在或已经撤销', '');
  }
  found.revokedAt = new Date().toISOString();
  found.revokedBy = operator;
  save(data);
  return { id: found.id, revokedAt: found.revokedAt, revokedBy: found.revokedBy };
}

function decorate(ignore, data, nowIso) {
  const seen = evaluateSpot(ignore, data, nowIso);
  if (ignore.revokedAt) {
    return {
      ...ignore,
      status: 'revoked',
      overdue: false,
      ruleName: seen.ruleName,
      level: seen.level,
      currentLineText: '',
    };
  }
  return {
    ...ignore,
    status: seen.status,
    overdue: isOverdue(ignore.reviewDate, nowIso),
    ruleName: seen.ruleName,
    level: seen.level,
    currentLineText: seen.currentLineText,
  };
}

// 已忽略清单：默认只看活动的，也可以翻出已经撤销的记录
function listIgnores(options) {
  const input = options && typeof options === 'object' ? options : {};
  const scope = pickText(input.scope) || 'active';
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();
  const now = new Date().toISOString();

  let list = data.ignores;
  if (scope === 'active') list = list.filter((item) => !item.revokedAt);
  if (scope === 'revoked') list = list.filter((item) => item.revokedAt);

  const decorated = list.map((item) => decorate(item, data, now));
  const filtered = keyword
    ? decorated.filter((item) => [item.code, item.path, item.reason, item.operator, item.ruleName]
      .some((field) => field && field.toLowerCase().includes(keyword)))
    : decorated;

  // 最该回头看的排前面：还在且到期、还在、位置异常、已不触发；撤销记录统一靠后
  const activeWeight = { 'still-there': 1, 'line-gone': 2, 'file-missing': 3, 'rule-missing': 4, 'rule-disabled': 5, 'not-hit': 6 };
  filtered.sort((a, b) => {
    const weightOf = (item) => {
      if (item.status === 'revoked') return 20;
      return item.status === 'still-there' && item.overdue ? 0 : (activeWeight[item.status] || 10);
    };
    const diff = weightOf(a) - weightOf(b);
    if (diff !== 0) return diff;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const active = decorated.filter((item) => item.status !== 'revoked');
  return {
    ignores: filtered,
    scopes: [
      { value: 'active', label: '生效中' },
      { value: 'revoked', label: '已撤销' },
      { value: 'all', label: '全部记录' },
    ],
    counts: {
      active: active.length,
      overdue: active.filter((item) => item.overdue).length,
      stillThere: active.filter((item) => item.status === 'still-there').length,
      notHit: active.filter((item) => item.status === 'not-hit').length,
    },
  };
}

module.exports = {
  spotKey,
  activeMap,
  isOverdue,
  evaluateSpot,
  createIgnore,
  revokeIgnore,
  listIgnores,
};
