'use strict';
const byId = id => document.getElementById(id);
let token = '';
let snapshot = null;
let polling = false;
let intakeData = { scopes: [], runs: [], drafts: [], latestSources: [] };
let projectSources = [];
const labels = { plan: '产品规划', implement: '开发执行', verify: '测试验证', review: '交付复核' };
const phaseLabels = { queued: '等待执行', running: '执行中', simulation_completed: '模拟完成', failed: '失败', cancelled: '已取消' };
function message(text, error = false) { byId('message').textContent = text; byId('message').className = error ? 'error' : ''; }
async function request(path, body, commandKey = crypto.randomUUID()) {
  // Safe transport retry: retain the key across retries of the same mutation.
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': commandKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    } catch (error) { if (attempt >= 1) throw error; continue; }
    const data = await response.json();
    if (!response.ok) throw new Error(`${data.error}（${response.status}）`);
    return data;
  }
}
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
async function projects(selected = '') {
  const data = await request('/v1/projects');
  byId('project').replaceChildren(option('', '请选择项目'), ...data.projects.map(p => option(p.id, p.name)));
  byId('project').value = selected;
  await deliveries();
}
async function deliveries(selected = '') {
  snapshot = null;
  byId('delivery').replaceChildren(option('', '暂无交付'));
  render();
  const projectId = byId('project').value;
  if (!projectId) { await refreshIntake(); return; }
  const data = await request(`/v1/projects/${projectId}/snapshot`);
  byId('delivery').replaceChildren(option('', '请选择交付'), ...data.deliveries.slice().reverse().map(d => option(d.id, `${d.id.slice(0, 8)} · ${phaseLabels[d.phase]}`)));
  byId('delivery').value = selected || data.deliveries.at(-1)?.id || '';
  await refresh();
  await refreshIntake();
}

async function refreshIntake(preferredDraft = '') {
  const projectId = byId('project').value;
  if (projectId) {
    const [project, intake] = await Promise.all([
      request(`/v1/projects/${projectId}/snapshot`), request(`/v1/projects/${projectId}/intake`),
    ]);
    projectSources = project.sources;
    intakeData = intake;
  } else {
    projectSources = [];
    intakeData = { scopes: [], runs: [], drafts: [], latestSources: [] };
  }
  const list = byId('scope-list');
  list.replaceChildren(...intakeData.scopes.map(scope => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const last = intakeData.runs.find(run => run.scope_id === scope.id);
    name.textContent = `${scope.label} · ${scope.connector} · ${scope.enabled ? '已启用' : '已停用'}${last ? ` · 最近扫描 ${last.status}` : ''}`;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.textContent = scope.enabled ? '停用' : '启用'; toggle.className = 'scope-toggle';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await request(`/v1/scopes/${scope.id}/state`, { enabled: !scope.enabled });
        await refreshIntake(); message('读取范围状态已更新');
      } catch (error) { message(error.message, true); toggle.disabled = false; }
    });
    item.append(name, toggle); return item;
  }));
  if (!list.childElementCount) list.append(Object.assign(document.createElement('li'), { textContent: '尚未添加读取范围。' }));
  const latest = new Set(intakeData.latestSources);
  const available = projectSources.filter(source => !['vanish', 'confluence'].includes(source.connector) || latest.has(source.id));
  const sourceSelect = byId('source-choice');
  const previousSource = sourceSelect.value;
  sourceSelect.replaceChildren(option('', '请选择来源'), ...available.map(source => option(source.id,
    `${source.connector} · ${source.external_id.slice(0, 55)}`)));
  sourceSelect.value = available.some(source => source.id === previousSource) ? previousSource : '';
  showSource();
  const draftSelect = byId('draft-choice');
  const previousDraft = preferredDraft || draftSelect.value;
  draftSelect.replaceChildren(option('', '请选择草案'), ...intakeData.drafts.map(draft => option(draft.id,
    `${draft.content.title.slice(0, 45)} · ${draft.status}`)));
  draftSelect.value = intakeData.drafts.some(draft => draft.id === previousDraft) ? previousDraft : intakeData.drafts[0]?.id || '';
  showDraft();
}

function showSource() {
  const selected = projectSources.find(source => source.id === byId('source-choice').value);
  byId('source-preview').textContent = selected ? selected.content.slice(0, 1500) : '选择一条来源以查看内容。';
  byId('create-draft').disabled = !selected;
}

function selectedDraft() { return intakeData.drafts.find(draft => draft.id === byId('draft-choice').value); }
function showDraft() {
  const draft = selectedDraft();
  const content = draft?.content;
  byId('draft-status').textContent = draft ? `${draft.status} · 修订 ${draft.revision}` : '暂无草案';
  byId('draft-title').value = content?.title || '';
  byId('draft-scope').value = content?.scope.in[0] || '';
  byId('draft-requirement').value = content?.requirements[0]?.statement || '';
  byId('draft-method').value = content?.acceptance[0]?.method || '';
  byId('draft-expected').value = content?.acceptance[0]?.expected || '';
  byId('draft-blockers').value = content?.blockingQuestions.join('\n') || '';
  const simple = content?.requirements.length === 1 && content?.acceptance.length === 1;
  byId('save-draft').disabled = !draft || draft.status !== 'review' || !simple;
  byId('approve-draft').disabled = !draft || draft.status !== 'review' || content.blockingQuestions.length > 0;
  if (draft && !simple) message('多条验收草案请通过 API 编辑；此页面只编辑单条需求草案。');
}
function render() {
  const delivery = snapshot?.delivery;
  byId('phase').textContent = delivery ? `${phaseLabels[delivery.phase]}${delivery.control_state === 'paused' ? ' · 已暂停' : ''}${delivery.input_stale ? ' · 来源已更新' : ''}` : '尚未开始';
  byId('steps').replaceChildren(...Object.entries(labels).map(([step, label], i) => {
    const job = snapshot?.jobs.find(j => j.step === step);
    const card = document.createElement('div'); card.className = `step ${job?.status || ''}`;
    const title = document.createElement('strong'); title.textContent = `${String(i + 1).padStart(2, '0')} ${label}`;
    const detail = document.createElement('span'); detail.textContent = job ? `${job.status} · ${job.attempt_count}/3` : '尚未调度';
    card.append(title, detail); return card;
  }));
  const active = delivery && ['queued', 'running'].includes(delivery.phase);
  byId('pause').disabled = !active || delivery.control_state !== 'active';
  byId('resume').disabled = !active || delivery.control_state !== 'paused';
  byId('cancel').disabled = !active;
  const events = snapshot?.events || [];
  byId('events').replaceChildren(...events.slice().reverse().map(event => {
    const item = document.createElement('li'); const time = document.createElement('time'); const text = document.createElement('span');
    time.textContent = new Date(event.created_at).toLocaleTimeString(); text.textContent = event.type;
    item.append(time, text); return item;
  }));
  byId('delivery-note').textContent = delivery?.input_stale
    ? '来源已有新版本。当前交付仍绑定旧需求；请核对差异并决定是否取消、继续观察或创建新交付。'
    : delivery?.phase === 'simulation_completed'
    ? '四阶段调度已完成。这里只证明模拟协议跑通，不代表真实需求、代码或测试已完成。'
    : '需要独立启动模拟 Worker。租约失效后最多重试 3 次，整体时限 1 小时。';
}
async function refresh() {
  const id = byId('delivery').value;
  if (!id) { snapshot = null; render(); return; }
  const next = await request(`/v1/deliveries/${id}`);
  if (id !== byId('delivery').value) return;
  snapshot = next; render();
}
function action(formId, fn) {
  byId(formId).addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await fn(); } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
}
action('connect-form', async () => {
  token = byId('token').value; byId('token').value = '';
  await projects(); message('已连接 · 可以创建项目和模拟需求');
});
action('project-form', async () => {
  const p = await request('/v1/projects', { name: byId('project-name').value });
  byId('project-name').value = ''; await projects(p.id); message('项目已创建');
});
action('run-form', async () => {
  const projectId = byId('project').value;
  if (!projectId) throw new Error('请先选择项目');
  const source = await request(`/v1/projects/${projectId}/sources`, { connector: 'manual', externalId: crypto.randomUUID(), sourceRevision: '1', text: byId('source').value });
  const requirement = await request(`/v1/projects/${projectId}/requirements`, {
    schemaVersion: 1, title: byId('title').value, sourceIds: [source.id],
    scope: { in: [byId('title').value], out: ['本次仅模拟，不执行真实开发、测试或发布'] },
    requirements: [{ id: 'R1', statement: byId('source').value }],
    acceptance: [{ id: 'AC1', requirementIds: ['R1'], method: '待接入真实测试后验证；本次模拟不执行', expected: byId('acceptance').value }],
    blockingQuestions: [],
  });
  await request(`/v1/requirements/${requirement.id}/ready`, { expectedRevision: 1 });
  const delivery = await request(`/v1/projects/${projectId}/deliveries`, { requirementId: requirement.id, requirementDigest: requirement.digest, mode: 'simulation' });
  await deliveries(delivery.id); message('模拟已创建 · 等待 Worker 领取任务');
});
byId('project').addEventListener('change', () => deliveries().catch(error => message(error.message, true)));
byId('delivery').addEventListener('change', () => refresh().catch(error => message(error.message, true)));
byId('source-choice').addEventListener('change', showSource);
byId('draft-choice').addEventListener('change', showDraft);
byId('refresh-intake').addEventListener('click', () => refreshIntake().then(() => message('来源与草案已刷新'))
  .catch(error => message(error.message, true)));
action('scope-form', async () => {
  const projectId = byId('project').value;
  if (!projectId) throw new Error('请先选择项目');
  await request(`/v1/projects/${projectId}/scopes`, { connector: byId('scope-kind').value,
    externalScopeId: byId('scope-id').value, label: byId('scope-label').value });
  byId('scope-id').value = ''; byId('scope-label').value = '';
  await refreshIntake(); message('读取范围已添加；等待本地采集器扫描');
});
byId('create-draft').addEventListener('click', async () => {
  const projectId = byId('project').value;
  if (!projectId || !byId('source-choice').value) return;
  try {
    const draft = await request(`/v1/projects/${projectId}/drafts`, { sourceIds: [byId('source-choice').value] });
    await refreshIntake(draft.id); message('草案已生成，请核对范围、验收方式与阻塞问题');
  } catch (error) { message(error.message, true); }
});
action('draft-form', async () => {
  const draft = selectedDraft();
  if (!draft) throw new Error('请选择草案');
  const content = structuredClone(draft.content);
  content.title = byId('draft-title').value;
  content.scope.in[0] = byId('draft-scope').value;
  content.requirements[0].statement = byId('draft-requirement').value;
  content.acceptance[0].method = byId('draft-method').value;
  content.acceptance[0].expected = byId('draft-expected').value;
  content.blockingQuestions = byId('draft-blockers').value.split('\n').map(item => item.trim()).filter(Boolean);
  await request(`/v1/drafts/${draft.id}/revise`, { expectedRevision: draft.revision, content });
  await refreshIntake(draft.id); message('草案已保存');
});
byId('approve-draft').addEventListener('click', async () => {
  const draft = selectedDraft();
  if (!draft) return;
  byId('approve-draft').disabled = true;
  try {
    const ready = await request(`/v1/drafts/${draft.id}/approve`, { expectedRevision: draft.revision });
    await refreshIntake(draft.id);
    const delivery = await request(`/v1/projects/${byId('project').value}/deliveries`, {
      requirementId: ready.requirementId, requirementDigest: ready.digest, mode: 'simulation',
    });
    await deliveries(delivery.id); message('草案已批准，模拟交付已创建');
  } catch (error) { message(error.message, true); await refreshIntake(draft.id).catch(() => undefined); }
});
for (const action of ['pause', 'resume', 'cancel']) byId(action).addEventListener('click', async () => {
  if (!snapshot) return;
  try {
    await request(`/v1/deliveries/${snapshot.delivery.id}/control`, { action, expectedRevision: snapshot.delivery.revision });
    await refresh(); message('控制操作已保存');
  } catch (error) { message(`${error.message}；状态可能已变化，请重试。`, true); await refresh().catch(() => undefined); }
});
setInterval(async () => {
  if (!token || polling || !byId('delivery').value) return;
  polling = true;
  try { await refresh(); } catch (error) { message(error.message, true); }
  finally { polling = false; }
}, 2000);
render();
