'use strict';
const byId = id => document.getElementById(id);
let token = '';
let snapshot = null;
let polling = false;
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
  if (!projectId) return;
  const data = await request(`/v1/projects/${projectId}/snapshot`);
  byId('delivery').replaceChildren(option('', '请选择交付'), ...data.deliveries.slice().reverse().map(d => option(d.id, `${d.id.slice(0, 8)} · ${phaseLabels[d.phase]}`)));
  byId('delivery').value = selected || data.deliveries.at(-1)?.id || '';
  await refresh();
}
function render() {
  const delivery = snapshot?.delivery;
  byId('phase').textContent = delivery ? `${phaseLabels[delivery.phase]}${delivery.control_state === 'paused' ? ' · 已暂停' : ''}` : '尚未开始';
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
  byId('delivery-note').textContent = delivery?.phase === 'simulation_completed'
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
