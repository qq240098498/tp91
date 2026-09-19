// 页面交互：规则、文件与扫描三块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  rules: [],
  files: [],
  levels: [],
  statuses: [],
  fileTypes: [],
  ruleLevels: [],
  ruleStatuses: [],
  ruleFileTypes: [],
  editingRuleId: '',
  editingFileId: '',
  lastScan: null,
  ignores: [],
  ignoreScopes: [],
  ignoreCounts: null,
  ignoreTarget: null,
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：规则区与文件区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'
    ? target
    : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function levelClass(level) {
  if (level === '错误') return 'lv-error';
  if (level === '警告') return 'lv-warn';
  return 'lv-hint';
}

const OPERATOR_KEY = 'check-hits-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadRules() {
  const params = new URLSearchParams();
  const level = el('rule-filter-level').value;
  const status = el('rule-filter-status').value;
  const fileType = el('rule-filter-type').value;
  const keyword = el('rule-filter-keyword').value.trim();
  if (level) params.set('level', level);
  if (status) params.set('status', status);
  if (fileType) params.set('fileType', fileType);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/rules${query ? `?${query}` : ''}`);
  state.rules = payload.rules || [];
  state.levels = payload.levels || [];
  state.statuses = payload.statuses || [];
  state.fileTypes = payload.fileTypes || [];
  renderRuleFilters();
  renderRules();
  renderScanRuleOptions();
}

async function loadFiles() {
  const params = new URLSearchParams();
  const type = el('file-filter-type').value;
  const keyword = el('file-filter-keyword').value.trim();
  if (type) params.set('type', type);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/files${query ? `?${query}` : ''}`);
  state.files = payload.files || [];
  state.ruleFileTypes = payload.fileTypes || [];
  renderFileFilters();
  renderFiles();
  renderScanFileOptions();
}

function renderRuleFilters() {
  const levelSelect = el('rule-filter-level');
  const levelCurrent = levelSelect.value;
  levelSelect.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(levelCurrent)) levelSelect.value = levelCurrent;

  const statusSelect = el('rule-filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const typeSelect = el('rule-filter-type');
  const typeCurrent = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部适用文件类型</option>'
    + state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(typeCurrent)) typeSelect.value = typeCurrent;

  const formLevel = el('rule-level');
  const formLevelCurrent = formLevel.value;
  formLevel.innerHTML = state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(formLevelCurrent)) formLevel.value = formLevelCurrent;

  const formStatus = el('rule-status');
  const formStatusCurrent = formStatus.value;
  formStatus.innerHTML = state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(formStatusCurrent)) formStatus.value = formStatusCurrent;

  const formType = el('rule-file-type');
  const formTypeCurrent = formType.value;
  formType.innerHTML = state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(formTypeCurrent)) formType.value = formTypeCurrent;

  const scanLevel = el('scan-level');
  const scanLevelCurrent = scanLevel.value;
  scanLevel.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(scanLevelCurrent)) scanLevel.value = scanLevelCurrent;
}

function renderFileFilters() {
  const typeSelect = el('file-filter-type');
  const current = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部类型</option>'
    + state.ruleFileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.ruleFileTypes.includes(current)) typeSelect.value = current;
}

function renderScanRuleOptions() {
  const select = el('scan-rule');
  const current = select.value;
  select.innerHTML = '<option value="">全部规则</option>'
    + state.rules.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)}</option>`).join('');
  if (state.rules.some((item) => item.id === current)) select.value = current;
}

function renderScanFileOptions() {
  const select = el('scan-file');
  const current = select.value;
  select.innerHTML = '<option value="">全部文件</option>'
    + state.files.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)}</option>`).join('');
  if (state.files.some((item) => item.id === current)) select.value = current;
}

function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.fileType)}</td>
      <td class="mono">${escapeHtml(item.pattern)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-rule-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-rule-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('rule-empty').classList.toggle('hidden', state.rules.length > 0);
}

function renderFiles() {
  const body = el('file-body');
  body.innerHTML = state.files.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${item.lineCount} 行</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-file-view="${escapeHtml(item.id)}">看内容</button>
        <button type="button" class="link" data-file-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-file-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('file-empty').classList.toggle('hidden', state.files.length > 0);
}

function openRuleForm(rule) {
  state.editingRuleId = rule ? rule.id : '';
  el('rule-form-title').textContent = rule ? `编辑规则：${rule.code}` : '新建规则';
  el('rule-code').value = rule ? rule.code : '';
  el('rule-name').value = rule ? rule.name : '';
  el('rule-level').value = rule ? rule.level : (state.levels[0] || '提示');
  el('rule-status').value = rule ? rule.status : (state.statuses[0] || '启用');
  el('rule-file-type').value = rule ? rule.fileType : (state.fileTypes[0] || '全部');
  el('rule-pattern').value = rule ? rule.pattern : '';
  el('rule-note').value = rule ? rule.note : '';
  el('rule-form').classList.remove('hidden');
  el('rule-code').focus();
}

function closeRuleForm() {
  state.editingRuleId = '';
  el('rule-form').classList.add('hidden');
  clearFieldMarks();
}

function openFileForm(file) {
  state.editingFileId = file ? file.id : '';
  el('file-form-title').textContent = file ? `编辑文件：${file.path}` : '收录新文件';
  el('file-path').value = file ? file.path : '';
  el('file-content').value = file ? file.content : '';
  el('file-note').value = file ? file.note : '';
  el('file-form').classList.remove('hidden');
  el('file-path').focus();
}

function closeFileForm() {
  state.editingFileId = '';
  el('file-form').classList.add('hidden');
  clearFieldMarks();
}

async function showFileContent(id) {
  clearNotice();
  try {
    const file = await request(`/api/files/${encodeURIComponent(id)}`);
    const preview = el('file-preview');
    preview.textContent = `${file.path}（${file.lineCount} 行）\n${'─'.repeat(40)}\n${file.content}`;
    preview.classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function submitRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('rule-code').value,
    name: el('rule-name').value,
    level: el('rule-level').value,
    status: el('rule-status').value,
    fileType: el('rule-file-type').value,
    pattern: el('rule-pattern').value,
    note: el('rule-note').value,
  };
  const editing = state.editingRuleId;
  try {
    if (editing) {
      await request(`/api/rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('规则已保存', 'ok');
    } else {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('规则已新增', 'ok');
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitFile(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    path: el('file-path').value,
    content: el('file-content').value,
    note: el('file-note').value,
  };
  const editing = state.editingFileId;
  try {
    if (editing) {
      await request(`/api/files/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文件已保存', 'ok');
    } else {
      await request('/api/files', { method: 'POST', body: JSON.stringify(payload) });
      notify('文件已收录', 'ok');
    }
    closeFileForm();
    await loadFiles();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 扫一遍，把概要与命中清单都画出来
async function runScan() {
  clearNotice();
  const body = {
    ruleId: el('scan-rule').value,
    fileId: el('scan-file').value,
    level: el('scan-level').value,
  };
  try {
    const result = await request('/api/scan', { method: 'POST', body: JSON.stringify(body) });
    state.lastScan = result;
    renderScan(result);
    // 扫描会刷新被压住命中的"最近扫到"时间，顺手把已忽略清单也对齐
    loadIgnores().catch(() => {});
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 命中行上"标为忽略"按钮里带的是 规则编码|文件路径|行号，路径里不会出现竖线
function parseHitKey(value) {
  const firstBar = value.indexOf('|');
  const lastBar = value.lastIndexOf('|');
  if (firstBar === -1 || lastBar === firstBar) return null;
  return {
    code: value.slice(0, firstBar),
    path: decodeURIComponent(value.slice(firstBar + 1, lastBar)),
    lineNo: Number(value.slice(lastBar + 1)),
  };
}

function openIgnoreForm(hit) {
  state.ignoreTarget = hit;
  el('ignore-form-title').textContent = `标记忽略：${hit.code} 第 ${hit.lineNo} 行`;
  el('ignore-target').textContent = `${hit.code}（${hit.ruleName}）　${hit.path}:${hit.lineNo}　${hit.lineText}`;
  el('ignore-reason').value = '';
  el('ignore-review-date').value = '';
  // 复核期限默认给两周后，仍可以自己改；最早只能选今天
  const due = new Date();
  due.setDate(due.getDate() + 14);
  const pad = (num) => String(num).padStart(2, '0');
  const today = new Date();
  el('ignore-review-date').min = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  el('ignore-review-date').value = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
  el('ignore-form').classList.remove('hidden');
  el('ignore-reason').focus();
}

function closeIgnoreForm() {
  state.ignoreTarget = null;
  el('ignore-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitIgnore(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const hit = state.ignoreTarget;
  if (!hit) return;
  const payload = {
    code: hit.code,
    path: hit.path,
    lineNo: hit.lineNo,
    reason: el('ignore-reason').value,
    reviewDate: el('ignore-review-date').value,
    operator: currentOperator(),
  };
  try {
    await request('/api/ignores', { method: 'POST', body: JSON.stringify(payload) });
    notify('已标记忽略：只压住这一条命中，重扫时仍能看到它还在', 'ok');
    closeIgnoreForm();
    // 立刻按当前范围重扫一遍，让这条命中从默认清单挪到被压住的一块（重扫会顺带刷新已忽略清单）
    await runScan();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function revokeIgnoreById(id) {
  try {
    await request(`/api/ignores/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ operator: currentOperator() }),
    });
    notify('已撤销忽略，下一次扫描时这条命中会回到默认清单', 'ok');
    await loadIgnores();
    if (state.lastScan) await runScan();
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderScan(result) {
  el('scan-meta').textContent = `扫描时刻 ${formatTime(result.scannedAt)}　参与比对的规则 ${result.rulesUsed} 条（启用共 ${result.enabledRules} 条）　范围里的文件 ${result.filesInScope} 个（清单共 ${result.filesTotal} 个）`;

  const warningBox = el('scan-warning');
  if (result.warning) {
    warningBox.textContent = result.warning;
    warningBox.classList.remove('hidden');
  } else {
    warningBox.classList.add('hidden');
    warningBox.textContent = '';
  }

  const summary = result.summary || {};
  const ignoredNote = summary.ignoredTotal
    ? `　另被忽略压住 ${summary.ignoredTotal} 条（其中已到期 ${summary.ignoredOverdue || 0} 条），问题还在，见下方与已忽略清单`
    : '';
  const summaryBox = el('scan-summary');
  const levelText = Object.keys(summary.byLevel || {})
    .map((key) => `${key} ${summary.byLevel[key]} 条`)
    .join('　');
  const ruleText = (summary.byRule || [])
    .map((item) => `${item.code} ${item.count} 条`)
    .join('　') || '没有规则命中';
  const fileText = (summary.byFile || [])
    .map((item) => `${item.path} ${item.count} 条`)
    .join('　') || '没有文件命中';
  summaryBox.innerHTML = `
    <div class="summary-line"><strong>实际扫到 ${summary.rawTotal} 条</strong>，需要处理的 <strong>${summary.total} 条</strong>${escapeHtml(ignoredNote)}</div>
    <div class="summary-line">级别分布（未忽略）：${escapeHtml(levelText)}</div>
    <div class="summary-line">按规则：${escapeHtml(ruleText)}</div>
    <div class="summary-line">按文件：${escapeHtml(fileText)}</div>`;
  summaryBox.classList.remove('hidden');

  const body = el('hit-body');
  body.innerHTML = result.hits.map((hit) => `<tr>
      <td class="mono">${escapeHtml(hit.code)}</td>
      <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
      <td>${escapeHtml(hit.ruleName)}</td>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td class="mono">${hit.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
      <td class="actions">
        <button type="button" class="link" data-hit-ignore="${escapeHtml(hit.code)}|${encodeURIComponent(hit.path)}|${hit.lineNo}">标为忽略</button>
      </td>
    </tr>`).join('');
  el('hit-empty').classList.toggle('hidden', result.hits.length > 0);

  renderSuppressed(result.suppressed || [], result.scannedAt);
}

// 被压住的命中单独一块：让人一眼看出它还在，只是忽略生效中
function renderSuppressed(suppressed, scannedAt) {
  const block = el('suppressed-block');
  if (!suppressed.length) {
    block.classList.add('hidden');
    return;
  }
  const overdueCount = suppressed.filter((item) => item.overdue).length;
  el('suppressed-tip').textContent = `本轮扫到 ${suppressed.length} 条已标记忽略的命中（扫描时刻 ${formatTime(scannedAt)}）`
    + (overdueCount ? `，其中 ${overdueCount} 条复核期限已到，需要尽快回头看` : '，这些位置问题仍然存在，只是被压住了');
  el('suppressed-body').innerHTML = suppressed.map((hit) => `<tr class="row-suppressed${hit.overdue ? ' row-overdue' : ''}">
      <td class="mono">${escapeHtml(hit.code)}</td>
      <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td class="mono">${hit.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
      <td class="note-cell">${escapeHtml(hit.reason)}</td>
      <td class="mono">${escapeHtml(hit.reviewDate)}${hit.overdue ? ' <span class="badge badge-overdue">已到期</span>' : ''}</td>
      <td>${escapeHtml(hit.operator)}</td>
    </tr>`).join('');
  block.classList.remove('hidden');
}

async function loadIgnores() {
  const params = new URLSearchParams();
  const scope = el('ignore-scope').value;
  const keyword = el('ignore-filter-keyword').value.trim();
  if (scope) params.set('scope', scope);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/ignores${query ? `?${query}` : ''}`);
  state.ignores = payload.ignores || [];
  state.ignoreScopes = payload.scopes || [];
  state.ignoreCounts = payload.counts || null;
  renderIgnores();
}

const IGNORE_STATUS_TEXT = {
  'still-there': { label: '仍在，被压住', className: 'is-there' },
  'not-hit': { label: '这一轮没再扫到', className: 'is-gone' },
  'line-gone': { label: '行号已超出文件', className: 'is-gone' },
  'file-missing': { label: '文件已移出清单', className: 'is-gone' },
  'rule-missing': { label: '规则已删除', className: 'is-gone' },
  'rule-disabled': { label: '规则已停用', className: 'is-gone' },
  revoked: { label: '已撤销', className: 'is-revoked' },
};

function ignoreStatusBadge(item) {
  const meta = IGNORE_STATUS_TEXT[item.status] || { label: item.status, className: '' };
  const overdue = item.overdue ? ' <span class="badge badge-overdue">已到期</span>' : '';
  return `<span class="badge badge-status ${meta.className}">${escapeHtml(meta.label)}</span>${overdue}`;
}

function renderIgnores() {
  const body = el('ignore-body');
  body.innerHTML = state.ignores.map((item) => {
    const rowText = item.status === 'revoked'
      ? (item.lastLineText || '')
      : (item.currentLineText || '');
    const reviewCell = item.status === 'revoked'
      ? `<span class="muted">—</span>`
      : `${escapeHtml(item.reviewDate)}`;
    const metaLine = item.status === 'revoked'
      ? `${escapeHtml(item.operator)} 标记于 ${escapeHtml(formatTime(item.createdAt))}<br><span class="muted">${escapeHtml(item.revokedBy || '')} 于 ${escapeHtml(formatTime(item.revokedAt))} 撤销</span>`
      : `${escapeHtml(item.operator)}<br><span class="muted">${escapeHtml(formatTime(item.createdAt))}</span>`;
    const action = item.status === 'revoked'
      ? '<span class="muted">已撤销</span>'
      : '<button type="button" class="link danger" data-ignore-revoke="' + escapeHtml(item.id) + '">撤销忽略</button>';
    return `<tr class="row-ignore${item.status === 'revoked' ? ' row-revoked' : ''}${item.overdue ? ' row-overdue' : ''}">
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${item.level ? `<span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${escapeHtml(item.ruleName || '规则已不在清单')}</td>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td class="mono">${item.lineNo}</td>
      <td>${ignoreStatusBadge(item)}</td>
      <td class="mono line-cell">${escapeHtml(rowText)}</td>
      <td class="note-cell">${escapeHtml(item.reason)}</td>
      <td class="mono">${reviewCell}</td>
      <td>${metaLine}</td>
      <td class="mono">${item.lastSeenAt ? escapeHtml(formatTime(item.lastSeenAt)) : '<span class="muted">还没再扫到</span>'}</td>
      <td class="actions">${action}</td>
    </tr>`;
  }).join('');
  el('ignore-empty').classList.toggle('hidden', state.ignores.length > 0);

  const counts = state.ignoreCounts;
  el('ignore-counts').textContent = counts
    ? `生效中 ${counts.active} 条：仍在被压住 ${counts.stillThere} 条、没再扫到 ${counts.notHit} 条、已到期 ${counts.overdue} 条（到期只提醒，不自动恢复）`
    : '';
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.ruleEdit) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleEdit);
    if (found) openRuleForm(found);
    return;
  }

  if (node.dataset.ruleDelete) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleDelete);
    if (!window.confirm(`确定删除规则 ${found ? found.code : ''} 吗？`)) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, { method: 'DELETE' });
      if (state.editingRuleId === node.dataset.ruleDelete) closeRuleForm();
      notify('规则已删除', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileView) {
    await showFileContent(node.dataset.fileView);
    return;
  }

  if (node.dataset.fileEdit) {
    clearNotice();
    try {
      const file = await request(`/api/files/${encodeURIComponent(node.dataset.fileEdit)}`);
      openFileForm(file);
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileDelete) {
    clearNotice();
    const found = state.files.find((item) => item.id === node.dataset.fileDelete);
    if (!window.confirm(`确定把 ${found ? found.path : ''} 移出清单吗？`)) return;
    try {
      await request(`/api/files/${encodeURIComponent(node.dataset.fileDelete)}`, { method: 'DELETE' });
      if (state.editingFileId === node.dataset.fileDelete) closeFileForm();
      el('file-preview').classList.add('hidden');
      notify('文件已移出清单', 'ok');
      await loadFiles();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.hitIgnore) {
    clearNotice();
    const spot = parseHitKey(node.dataset.hitIgnore);
    if (!spot) return;
    const found = (state.lastScan && state.lastScan.hits || []).find((hit) => hit.code === spot.code
      && hit.path === spot.path && hit.lineNo === spot.lineNo);
    if (found) openIgnoreForm(found);
    return;
  }

  if (node.dataset.ignoreRevoke) {
    clearNotice();
    const found = state.ignores.find((item) => item.id === node.dataset.ignoreRevoke);
    if (!found || found.status === 'revoked') return;
    if (!currentOperator()) {
      notify('请先在页面右上角填上当前操作者，再撤销忽略', 'error');
      return;
    }
    if (!window.confirm(`确定撤销对 ${found.code} 在 ${found.path}:${found.lineNo} 的忽略吗？撤销后它会重新出现在命中清单里`)) return;
    await revokeIgnoreById(found.id);
  }
});

el('rule-form').addEventListener('submit', submitRule);
el('file-form').addEventListener('submit', submitFile);
el('rule-new').addEventListener('click', () => {
  clearNotice();
  openRuleForm(null);
});
el('rule-cancel').addEventListener('click', closeRuleForm);
el('file-new').addEventListener('click', () => {
  clearNotice();
  openFileForm(null);
});
el('file-cancel').addEventListener('click', closeFileForm);
el('rule-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-reset').addEventListener('click', () => {
  el('rule-filter-level').value = '';
  el('rule-filter-status').value = '';
  el('rule-filter-type').value = '';
  el('rule-filter-keyword').value = '';
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-refresh').addEventListener('click', () => {
  clearNotice();
  loadRules()
    .then(loadFiles)
    .catch((err) => notify(err.message, 'error'));
});
el('file-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('file-filter-reset').addEventListener('click', () => {
  el('file-filter-type').value = '';
  el('file-filter-keyword').value = '';
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('scan-run').addEventListener('click', runScan);
el('ignore-cancel').addEventListener('click', closeIgnoreForm);
el('ignore-form').addEventListener('submit', submitIgnore);
el('ignore-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadIgnores().catch((err) => notify(err.message, 'error'));
});
el('ignore-refresh').addEventListener('click', () => {
  clearNotice();
  loadIgnores().catch((err) => notify(err.message, 'error'));
});
el('ignore-scope').addEventListener('change', () => {
  loadIgnores().catch((err) => notify(err.message, 'error'));
});
el('ignore-filter-keyword').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadIgnores().catch((err) => notify(err.message, 'error'));
  }
});
el('rule-filter-level').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-status').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把规则、文件与已忽略清单都拉一遍，扫描的范围下拉依赖前两份清单
restoreOperator();
loadHealth();
loadRules()
  .then(loadFiles)
  .then(() => loadIgnores())
  .catch((err) => notify(err.message, 'error'));
