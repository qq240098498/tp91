const { load, LEVELS, STATUSES, ignoreKeyOf } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 按给定范围算出原始命中，不掺忽略的因素；标记忽略时要先证明这条命中此刻真实存在
function collectRawHits(data, options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  return { enabled, rulesUsed, filesInScope, warning, hits };
}

// 用 规则编码+文件路径+行号 建索引，忽略只压住完全对齐的那一条，不会一带一整条规则或整个文件
function indexIgnores(ignores, today) {
  const map = new Map();
  ignores.forEach((ignore) => {
    map.set(ignoreKeyOf(ignore.code, ignore.path, ignore.lineNo), {
      ...ignore,
      overdue: Boolean(ignore.reviewAt && ignore.reviewAt < today),
    });
  });
  return map;
}

function todayText() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function summarize(hits) {
  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  return {
    total: hits.length,
    byLevel,
    byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
    byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上；
// 已经标成忽略的命中不消失，单独放在 suppressedHits 里，表示它还在、只是被压住了
function scan(options) {
  const data = load();
  const collected = collectRawHits(data, options);
  const today = todayText();
  const ignoreMap = indexIgnores(data.ignores || [], today);

  const hits = [];
  const suppressedHits = [];
  collected.hits.forEach((hit) => {
    const ignore = ignoreMap.get(ignoreKeyOf(hit.code, hit.path, hit.lineNo));
    if (ignore) {
      suppressedHits.push({ ...hit, ignore });
    } else {
      hits.push(hit);
    }
  });

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: collected.enabled.length,
    rulesUsed: collected.rulesUsed.length,
    filesInScope: collected.filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning: collected.warning,
    hits,
    suppressedHits,
    summary: {
      ...summarize(collected.hits),
      active: hits.length,
      suppressed: suppressedHits.length,
      overdueSuppressed: suppressedHits.filter((item) => item.ignore.overdue).length,
    },
  };
}

module.exports = { scan, collectRawHits, ruleAppliesToFile, levelOrder, todayText };
