import type { SupportSetupProposal } from '@freellmapi/shared/support-setup-copilot.js';
import { getDb, type Db } from '../../db/index.js';
import { up as upSetupCopilot } from '../../db/migrations/20261118_093000_custom_support_setup_copilot.js';

export class SupportSetupCopilotError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupportSetupCopilotError';
  }
}

const initializedDbs = new WeakSet<Db>();

export function ensureSupportSetupCopilotTables(targetDb?: Db): Db {
  const db = targetDb ?? getDb();
  if (initializedDbs.has(db)) return db;
  upSetupCopilot(db);
  initializedDbs.add(db);
  return db;
}

interface ProposalRow {
  id: string;
  user_id: number;
  target_mode: 'create_tenant' | 'update_tenant';
  tenant_id: number | null;
  status: SupportSetupProposal['status'];
  requirements_json: string;
  proposal_json: string;
  execution_result_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  applied_at: string | null;
}

function hydrateProposal(row: ProposalRow): SupportSetupProposal {
  const parsed = JSON.parse(row.proposal_json) as SupportSetupProposal;
  return {
    ...parsed,
    id: row.id,
    userId: row.user_id,
    targetMode: row.target_mode,
    tenantId: row.tenant_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    appliedAt: row.applied_at,
  };
}

export function createSetupProposal(proposal: SupportSetupProposal): SupportSetupProposal {
  const db = ensureSupportSetupCopilotTables();
  const now = proposal.createdAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO custom_support_setup_proposals (
       id, user_id, target_mode, tenant_id, status,
       requirements_json, proposal_json, execution_result_json,
       created_at, updated_at, expires_at, applied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    proposal.id,
    proposal.userId,
    proposal.targetMode,
    proposal.tenantId,
    proposal.status,
    JSON.stringify(proposal.requirements ?? {}),
    JSON.stringify(proposal),
    now,
    now,
    proposal.expiresAt,
  );
  return getSetupProposalForUser(proposal.id, proposal.userId);
}

export function getSetupProposalForUser(
  proposalId: string,
  userId: number,
): SupportSetupProposal {
  if (!proposalId || typeof proposalId !== 'string') {
    throw new SupportSetupCopilotError(400, 'invalid_input', 'proposalId is required.');
  }
  const db = ensureSupportSetupCopilotTables();
  const row = db
    .prepare(
      `SELECT * FROM custom_support_setup_proposals
        WHERE id = ? AND user_id = ?`,
    )
    .get(proposalId, userId) as ProposalRow | undefined;

  if (!row) {
    throw new SupportSetupCopilotError(
      404,
      'proposal_not_found',
      'Setup proposal not found.',
    );
  }

  const nowIso = new Date().toISOString();
  if (row.status === 'pending_consent' && Date.parse(row.expires_at) <= Date.parse(nowIso)) {
    const hydrated: SupportSetupProposal = {
      ...hydrateProposal(row),
      status: 'expired',
    };
    db.prepare(
      `UPDATE custom_support_setup_proposals
          SET status = 'expired', proposal_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'pending_consent'`,
    ).run(JSON.stringify(hydrated), nowIso, row.id, userId);
    return hydrated;
  }

  return hydrateProposal(row);
}

export function listPendingProposalsForUser(
  userId: number,
  tenantId?: number | null,
): SupportSetupProposal[] {
  const db = ensureSupportSetupCopilotTables();
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE custom_support_setup_proposals
        SET status = 'expired', updated_at = ?
      WHERE user_id = ? AND status = 'pending_consent' AND expires_at <= ?`,
  ).run(nowIso, userId, nowIso);

  const rows = db
    .prepare(
      `SELECT * FROM custom_support_setup_proposals
        WHERE user_id = ? AND status = 'pending_consent'
        ORDER BY created_at DESC
        LIMIT 10`,
    )
    .all(userId) as ProposalRow[];

  const hydrated = rows.map(hydrateProposal);
  if (tenantId === undefined) return hydrated;
  if (tenantId === null) {
    return hydrated.filter((p) => p.tenantId === null);
  }
  return hydrated.filter((p) => p.tenantId === tenantId || p.tenantId === null);
}

export function markSetupProposalApplied(
  proposalId: string,
  userId: number,
  tenantId: number,
  updatedProposal: SupportSetupProposal,
  executionResult: unknown,
): SupportSetupProposal {
  const db = ensureSupportSetupCopilotTables();
  const nowIso = new Date().toISOString();
  const nextProposal: SupportSetupProposal = {
    ...updatedProposal,
    tenantId,
    status: 'applied',
    appliedAt: nowIso,
  };

  const result = db
    .prepare(
      `UPDATE custom_support_setup_proposals
          SET status = 'applied',
              tenant_id = ?,
              proposal_json = ?,
              execution_result_json = ?,
              updated_at = ?,
              applied_at = ?
        WHERE id = ? AND user_id = ? AND status = 'pending_consent'`,
    )
    .run(
      tenantId,
      JSON.stringify(nextProposal),
      JSON.stringify(executionResult),
      nowIso,
      nowIso,
      proposalId,
      userId,
    );

  if (result.changes === 0) {
    throw new SupportSetupCopilotError(
      409,
      'proposal_conflict',
      'Setup proposal is no longer pending consent.',
    );
  }

  return getSetupProposalForUser(proposalId, userId);
}

export function markSetupProposalDeclined(
  proposalId: string,
  userId: number,
): SupportSetupProposal {
  const current = getSetupProposalForUser(proposalId, userId);
  if (current.status === 'applied') {
    throw new SupportSetupCopilotError(
      409,
      'proposal_already_applied',
      'Applied setup proposals cannot be declined.',
    );
  }
  if (current.status === 'declined') {
    return current;
  }
  if (current.status === 'expired') {
    throw new SupportSetupCopilotError(
      409,
      'proposal_expired',
      'Expired setup proposals cannot be declined.',
    );
  }

  const db = ensureSupportSetupCopilotTables();
  const nowIso = new Date().toISOString();
  const nextProposal: SupportSetupProposal = {
    ...current,
    status: 'declined',
  };

  db.prepare(
    `UPDATE custom_support_setup_proposals
        SET status = 'declined', proposal_json = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'pending_consent'`,
  ).run(JSON.stringify(nextProposal), nowIso, proposalId, userId);

  return getSetupProposalForUser(proposalId, userId);
}
