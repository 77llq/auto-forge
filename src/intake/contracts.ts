import { z } from 'zod';
import { requirementContent, uuid } from '../contracts.js';

const label = z.string().trim().min(1).max(200);
const externalId = z.string().trim().min(1).max(200);
export const registerScope = z.strictObject({
  connector: z.enum(['vanish', 'confluence']),
  externalScopeId: externalId,
  label,
}).superRefine((value, ctx) => {
  if (value.connector === 'confluence' && !/^\d+$/.test(value.externalScopeId)) {
    ctx.addIssue({ code: 'custom', message: 'Confluence requires a numeric page ID', path: ['externalScopeId'] });
  }
});
export const scopeState = z.strictObject({ enabled: z.boolean() });
export const startRun = z.strictObject({
  startPage: z.number().int().min(1).max(10000).default(1),
  maxPages: z.number().int().min(1).max(20).default(5),
});
export const intakeRecord = z.strictObject({
  externalId,
  sourceRevision: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  text: z.string().min(1).max(32000),
});
export type IntakeRecord = z.infer<typeof intakeRecord>;
export const ingestPage = z.strictObject({
  page: z.number().int().min(1).max(10000),
  records: z.array(intakeRecord).max(100),
  hasMore: z.boolean(),
});
export const failRun = z.strictObject({ reason: z.enum(['access_denied','provider_error','invalid_provider_response','transport_error','ingestion_rejected']) });
export const createDraft = z.strictObject({ sourceIds: z.array(uuid).min(1).max(30) });
export const reviseDraft = z.strictObject({ expectedRevision: z.number().int().positive(), content: requirementContent });
export const approveDraft = z.strictObject({ expectedRevision: z.number().int().positive() });

export const intakeContracts = { registerScope, scopeState, startRun, ingestPage, failRun, createDraft, reviseDraft, approveDraft };
export function intakeContractCatalog(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(intakeContracts).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}
