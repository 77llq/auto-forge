import { z } from 'zod';

export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const key = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().trim().min(1).max(4000);
export const createProject = z.strictObject({ name: text });
export const createSource = z.strictObject({
  connector: z.enum(['manual', 'fixture']),
  externalId: key,
  sourceRevision: key,
  text: z.string().min(1).max(32000),
});
export const requirementContent = z.strictObject({
  schemaVersion: z.literal(1),
  title: text,
  sourceIds: z.array(uuid).min(1).max(30),
  scope: z.strictObject({ in: z.array(text).min(1).max(30), out: z.array(text).max(30) }),
  requirements: z.array(z.strictObject({ id: key, statement: text })).min(1).max(100),
  acceptance: z.array(z.strictObject({
    id: key,
    requirementIds: z.array(key).min(1).max(100),
    method: text,
    expected: text,
  })).min(1).max(100),
  blockingQuestions: z.array(text).max(30),
});
export type RequirementContent = z.infer<typeof requirementContent>;
export const readyRequirement = z.strictObject({ expectedRevision: z.literal(1) });
export const createDelivery = z.strictObject({
  requirementId: uuid,
  requirementDigest: digest,
  mode: z.literal('simulation'),
});
export const controlDelivery = z.strictObject({
  action: z.enum(['pause', 'resume', 'cancel']),
  expectedRevision: z.number().int().positive(),
});
export const steps = ['plan', 'implement', 'verify', 'review'] as const;
export const step = z.enum(steps);
export type Step = z.infer<typeof step>;
export const lease = z.strictObject({ token: uuid, epoch: z.number().int().positive() });
export type Lease = z.infer<typeof lease>;
export const claimRequest = z.strictObject({ capability: z.literal('simulation') });
export const heartbeatRequest = z.strictObject({ lease });
export const simulationResult = z.strictObject({
  kind: z.literal('simulation'),
  step,
  inputDigest: digest,
  summary: text,
});
export const completeRequest = z.discriminatedUnion('outcome', [
  z.strictObject({ lease, outcome: z.literal('succeeded'), result: simulationResult }),
  z.strictObject({ lease, outcome: z.literal('failed'), reason: key, retryable: z.boolean() }),
]);
export type Completion = z.infer<typeof completeRequest>;
export const claimedJob = z.strictObject({
  id: uuid, deliveryId: uuid, step,
  inputDigest: digest, attempt: z.number().int().positive(),
  lease, leaseExpiresAt: z.iso.datetime(),
});
export type ClaimedJob = z.infer<typeof claimedJob>;

export const contracts = {
  createProject, createSource, requirementContent, readyRequirement,
  createDelivery, controlDelivery, claimRequest, heartbeatRequest, completeRequest, claimedJob,
};

export function validateTraceability(content: RequirementContent): string[] {
  const issues: string[] = [];
  const requirements = new Set(content.requirements.map(item => item.id));
  if (requirements.size !== content.requirements.length) issues.push('Duplicate requirement IDs');
  if (new Set(content.acceptance.map(item => item.id)).size !== content.acceptance.length) issues.push('Duplicate acceptance IDs');
  const covered = new Set<string>();
  for (const acceptance of content.acceptance) {
    for (const id of acceptance.requirementIds) {
      if (!requirements.has(id)) issues.push(`Unknown requirement ${id}`);
      covered.add(id);
    }
  }
  for (const id of requirements) if (!covered.has(id)) issues.push(`No acceptance for ${id}`);
  if (new Set(content.sourceIds).size !== content.sourceIds.length) issues.push('Duplicate source IDs');
  return issues;
}

export function contractCatalog(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(contracts).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}
