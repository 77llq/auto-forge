import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { ForgeClient } from '../src/client.js';
const config = readConfig();
const api = new ForgeClient(`http://127.0.0.1:${config.PORT}`, config.CONTROL_API_TOKEN);
const project = await api.request<{ id: string }>('/v1/projects', { name: 'Auto Forge simulation demo' });
const source = await api.request<{ id: string }>(`/v1/projects/${project.id}/sources`, {
  connector: 'fixture', externalId: randomUUID(), sourceRevision: '1', text: '验证需求到模拟交付的持久化闭环；不修改业务仓库。',
});
const requirement = await api.request<{ id: string; digest: string }>(`/v1/projects/${project.id}/requirements`, {
  schemaVersion: 1, title: '第一个模拟交付', sourceIds: [source.id],
  scope: { in: ['验证四阶段调度'], out: ['真实代码修改、真实测试与发布'] },
  requirements: [{ id: 'R1', statement: '按顺序完成 plan、implement、verify、review 模拟阶段' }],
  acceptance: [{ id: 'AC1', requirementIds: ['R1'], method: '检查执行记录', expected: '四个模拟任务成功，交付状态为 simulation_completed' }],
  blockingQuestions: [],
});
await api.request(`/v1/requirements/${requirement.id}/ready`, { expectedRevision: 1 });
const delivery = await api.request<{ id: string }>(`/v1/projects/${project.id}/deliveries`, {
  requirementId: requirement.id, requirementDigest: requirement.digest, mode: 'simulation',
});
console.log(`Created simulation delivery ${delivery.id}`);
for (let count = 0; count < 60; count++) {
  const snapshot = await api.request<{ delivery: { phase: string }; jobs: unknown[] }>(`/v1/deliveries/${delivery.id}`);
  if (snapshot.delivery.phase === 'simulation_completed') {
    console.log(`Simulation completed (${snapshot.jobs.length} steps). No real code or tests were executed.`);
    process.exit(0);
  }
  if (['failed', 'cancelled'].includes(snapshot.delivery.phase)) throw new Error(`Delivery ${snapshot.delivery.phase}`);
  await delay(1000);
}
throw new Error('Demo timed out. Check that npm run worker is running; the delivery remains persisted.');
