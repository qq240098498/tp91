const { load, save, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');
const ignores = require('./ignores');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

function tallyByLevel(list) {
  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  list.forEach((hit) => { byLevel[hit.level] += 1; });
  return byLevel;
}

function tallyByRule(list) {
  const byRuleMap = new Map();
  list.forEach((hit) => {
    if (!byRuleMap.has(hit.code)) {
      byRuleMap.set(hit.code, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(hit.code).count += 1;
  });
  return Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function tallyByFile(list) {
  const byFileMap = new Map();
  list.forEach((hit) => {
    if (!byFileMap.has(hit.path)) byFileMap.set(hit.path, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(hit.path).count += 1;
  });
  return Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1));
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上。
// 被标了忽略的命中仍然照扫，只是不进默认清单，单独放在 suppressed 里，
// 并回写最近扫到的时间与行内容——它还在，只是被压住了，不能当成已经修好
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

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

  const rawHits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          rawHits.push({
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

  rawHits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const scannedAt = new Date().toISOString();
  const ignoredMap = ignores.activeMap(data);
  const hits = [];
  const suppressed = [];
  let ignoreTouched = false;
  rawHits.forEach((hit) => {
    const ignore = ignoredMap.get(ignores.spotKey(hit.code, hit.path, hit.lineNo));
    if (!ignore) {
      hits.push(hit);
      return;
    }
    ignore.lastSeenAt = scannedAt;
    ignore.lastLineText = hit.lineText;
    ignoreTouched = true;
    suppressed.push({
      ...hit,
      ignoreId: ignore.id,
      reason: ignore.reason,
      reviewDate: ignore.reviewDate,
      operator: ignore.operator,
      ignoredAt: ignore.createdAt,
      lastSeenAt: ignore.lastSeenAt,
      overdue: ignores.isOverdue(ignore.reviewDate, scannedAt),
    });
  });

  // 有被压住的命中又一次扫到时落盘，留下"它还在"的凭据
  if (ignoreTouched) save(data);

  return {
    scannedAt,
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    suppressed,
    summary: {
      total: hits.length,
      rawTotal: rawHits.length,
      ignoredTotal: suppressed.length,
      ignoredOverdue: suppressed.filter((item) => item.overdue).length,
      byLevel: tallyByLevel(hits),
      ignoredByLevel: tallyByLevel(suppressed),
      byRule: tallyByRule(hits),
      byFile: tallyByFile(hits),
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder };
