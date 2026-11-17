import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb, type Db } from '../../db/index.js';
import type {
  SupportLiveTestSandboxCleanupResponse,
  SupportLiveTestSandboxStats,
} from '@freellmapi/shared/support-service-desk-live-test.js';

const CONVERSATIONS_KEY = 'x_gateway_support_conversations_v1';
const TICKETS_KEY = 'x_gateway_support_tickets_v1';
const ACTIONS_KEY = 'x_gateway_support_actions_v1';
const CSAT_KEY = 'x_gateway_support_csat_v1';
const LIVE_TEST_INTAKES_KEY = 'x_gateway_support_live_test_intakes_v1';
const MAX_TRACKED_INTAKE_REQUESTS = 500;
const SQLITE_IN_CHUNK = 400;

interface LiveTestTagRecord {
  id?: string;
  conversationId?: string;
  isLiveTest?: boolean;
}

const liveTestStorage = new AsyncLocalStorage<{ tenantId: number }>();

export function runWithLiveTestContext<T>(tenantId: number, fn: () => T): T {
  return liveTestStorage.run({ tenantId }, fn);
}

export function isInLiveTestContext(): boolean {
  return Boolean(liveTestStorage.getStore());
}

function ensureSettingsTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function readSettingsRecord<T>(db: Db, key: string): Record<string, T> {
  ensureSettingsTable(db);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}

function writeSettingsRecord<T>(db: Db, key: string, store: Record<string, T>): void {
  ensureSettingsTable(db);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(store));
}

function tableExists(db: Db, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined;
  return Boolean(row?.found);
}

function deleteByColumnValues(
  db: Db,
  tableName: string,
  tenantId: number,
  column: string,
  values: readonly string[],
): void {
  if (values.length === 0 || !tableExists(db, tableName)) return;
  for (let i = 0; i < values.length; i += SQLITE_IN_CHUNK) {
    const chunk = values.slice(i, i + SQLITE_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    db.prepare(`DELETE FROM ${tableName} WHERE tenant_id = ? AND ${column} IN (${placeholders})`).run(
      tenantId,
      ...chunk,
    );
  }
}

export function isLiveTestConversation(
  tenantId: string | number,
  conversationId: string,
): boolean {
  const db = getDb();
  const tid = String(tenantId);
  const store = readSettingsRecord<LiveTestTagRecord[]>(db, CONVERSATIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  return list.some((c) => c.id === conversationId && c.isLiveTest === true);
}

export function recordLiveTestIntakeRequest(tenantId: number, requestId: string): void {
  const trimmed = requestId.trim();
  if (!trimmed) return;
  const db = getDb();
  const tid = String(tenantId);
  const store = readSettingsRecord<string[]>(db, LIVE_TEST_INTAKES_KEY);
  const existing = Array.isArray(store[tid]) ? store[tid] : [];
  if (existing.includes(trimmed)) return;
  store[tid] = [...existing, trimmed].slice(-MAX_TRACKED_INTAKE_REQUESTS);
  writeSettingsRecord(db, LIVE_TEST_INTAKES_KEY, store);
}

export function getLiveTestSandboxStats(tenantId: number): SupportLiveTestSandboxStats {
  const db = getDb();
  const tid = String(tenantId);

  const countLiveTest = (key: string): number => {
    const store = readSettingsRecord<LiveTestTagRecord[]>(db, key);
    const list = Array.isArray(store[tid]) ? store[tid] : [];
    return list.filter((item) => item.isLiveTest === true).length;
  };

  const conversationsCount = countLiveTest(CONVERSATIONS_KEY);
  const ticketsCount = countLiveTest(TICKETS_KEY);
  const pendingActionsCount = countLiveTest(ACTIONS_KEY);
  const csatRatingsCount = countLiveTest(CSAT_KEY);

  return {
    ok: true,
    tenantId,
    conversationsCount,
    ticketsCount,
    pendingActionsCount,
    csatRatingsCount,
    totalCount: conversationsCount + ticketsCount + pendingActionsCount + csatRatingsCount,
  };
}

export function purgeLiveTestSandboxData(tenantId: number): SupportLiveTestSandboxCleanupResponse {
  const db = getDb();
  const tid = String(tenantId);

  return db.transaction(() => {
    const convStore = readSettingsRecord<LiveTestTagRecord[]>(db, CONVERSATIONS_KEY);
    const convList = Array.isArray(convStore[tid]) ? convStore[tid] : [];
    const deletedConvIds = new Set<string>();
    const keptConvs = convList.filter((conv) => {
      if (conv.isLiveTest === true) {
        if (typeof conv.id === 'string' && conv.id) deletedConvIds.add(conv.id);
        return false;
      }
      return true;
    });
    const deletedConversations = convList.length - keptConvs.length;
    if (deletedConversations > 0) {
      convStore[tid] = keptConvs;
      writeSettingsRecord(db, CONVERSATIONS_KEY, convStore);
    }

    const ticketStore = readSettingsRecord<LiveTestTagRecord[]>(db, TICKETS_KEY);
    const ticketList = Array.isArray(ticketStore[tid]) ? ticketStore[tid] : [];
    const deletedTicketIds = new Set<string>();
    const keptTickets = ticketList.filter((ticket) => {
      const linked =
        typeof ticket.conversationId === 'string' && deletedConvIds.has(ticket.conversationId);
      if (ticket.isLiveTest === true || linked) {
        if (typeof ticket.id === 'string' && ticket.id) deletedTicketIds.add(ticket.id);
        return false;
      }
      return true;
    });
    const deletedTickets = ticketList.length - keptTickets.length;
    if (deletedTickets > 0) {
      ticketStore[tid] = keptTickets;
      writeSettingsRecord(db, TICKETS_KEY, ticketStore);
    }

    const actionStore = readSettingsRecord<LiveTestTagRecord[]>(db, ACTIONS_KEY);
    const actionList = Array.isArray(actionStore[tid]) ? actionStore[tid] : [];
    const deletedActionIds: string[] = [];
    const keptActions = actionList.filter((item) => {
      const linked =
        typeof item.conversationId === 'string' && deletedConvIds.has(item.conversationId);
      if (item.isLiveTest === true || linked) {
        if (typeof item.id === 'string' && item.id) deletedActionIds.push(item.id);
        return false;
      }
      return true;
    });
    const deletedActions = actionList.length - keptActions.length;
    if (deletedActions > 0) {
      actionStore[tid] = keptActions;
      writeSettingsRecord(db, ACTIONS_KEY, actionStore);
    }

    const filterLinked = (key: string): number => {
      const store = readSettingsRecord<LiveTestTagRecord[]>(db, key);
      const list = Array.isArray(store[tid]) ? store[tid] : [];
      const kept = list.filter((item) => {
        const linked =
          typeof item.conversationId === 'string' && deletedConvIds.has(item.conversationId);
        return item.isLiveTest !== true && !linked;
      });
      const removed = list.length - kept.length;
      if (removed > 0) {
        store[tid] = kept;
        writeSettingsRecord(db, key, store);
      }
      return removed;
    };

    const deletedCsat = filterLinked(CSAT_KEY);

    const intakeStore = readSettingsRecord<string[]>(db, LIVE_TEST_INTAKES_KEY);
    const intakeReqIds = Array.isArray(intakeStore[tid]) ? intakeStore[tid] : [];
    if (intakeReqIds.length > 0) {
      delete intakeStore[tid];
      writeSettingsRecord(db, LIVE_TEST_INTAKES_KEY, intakeStore);
    }

    const convIdArr = [...deletedConvIds];
    const ticketIdArr = [...deletedTicketIds];

    deleteByColumnValues(db, 'x_support_action_executions', tenantId, 'action_id', deletedActionIds);

    deleteByColumnValues(db, 'x_support_desk_ticket_state', tenantId, 'ticket_id', ticketIdArr);
    deleteByColumnValues(db, 'x_support_desk_ticket_state', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_desk_intakes', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_desk_intakes', tenantId, 'request_id', intakeReqIds);
    deleteByColumnValues(db, 'x_support_desk_copilot_jobs', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_runtime_leases', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_runtime_turns', tenantId, 'conversation_id', convIdArr);

    return {
      ok: true as const,
      tenantId,
      deleted: {
        conversations: deletedConversations,
        tickets: deletedTickets,
        pendingActions: deletedActions,
        csatRatings: deletedCsat,
      },
    };
  })();
}

export function purgeSpecificLiveTestRecords(
  tenantId: number,
  ids: {
    conversationIds: readonly string[];
    actionIds: readonly string[];
    intakeRequestIds: readonly string[];
    chatRequestIds?: readonly string[];
  },
): void {
  const convIdArr = [...new Set(ids.conversationIds.map((v) => v.trim()).filter(Boolean))];
  const actionIdArr = [...new Set(ids.actionIds.map((v) => v.trim()).filter(Boolean))];
  const intakeReqArr = [...new Set(ids.intakeRequestIds.map((v) => v.trim()).filter(Boolean))];
  const chatReqArr = [...new Set((ids.chatRequestIds ?? []).map((v) => v.trim()).filter(Boolean))];

  if (
    convIdArr.length === 0 &&
    actionIdArr.length === 0 &&
    intakeReqArr.length === 0 &&
    chatReqArr.length === 0
  ) {
    return;
  }

  const db = getDb();
  const tid = String(tenantId);
  const convSet = new Set(convIdArr);
  const actionSet = new Set(actionIdArr);
  const intakeSet = new Set(intakeReqArr);

  db.transaction(() => {
    if (convSet.size > 0) {
      const convStore = readSettingsRecord<LiveTestTagRecord[]>(db, CONVERSATIONS_KEY);
      const convList = Array.isArray(convStore[tid]) ? convStore[tid] : [];
      const keptConvs = convList.filter((c) => !c.id || !convSet.has(c.id));
      if (keptConvs.length !== convList.length) {
        convStore[tid] = keptConvs;
        writeSettingsRecord(db, CONVERSATIONS_KEY, convStore);
      }

      const ticketStore = readSettingsRecord<LiveTestTagRecord[]>(db, TICKETS_KEY);
      const ticketList = Array.isArray(ticketStore[tid]) ? ticketStore[tid] : [];
      const removedTicketIds: string[] = [];
      const keptTickets = ticketList.filter((t) => {
        if (typeof t.conversationId === 'string' && convSet.has(t.conversationId)) {
          if (typeof t.id === 'string' && t.id) removedTicketIds.push(t.id);
          return false;
        }
        return true;
      });
      if (keptTickets.length !== ticketList.length) {
        ticketStore[tid] = keptTickets;
        writeSettingsRecord(db, TICKETS_KEY, ticketStore);
      }
      deleteByColumnValues(db, 'x_support_desk_ticket_state', tenantId, 'ticket_id', removedTicketIds);
    }

    if (actionSet.size > 0 || convSet.size > 0) {
      const actionStore = readSettingsRecord<LiveTestTagRecord[]>(db, ACTIONS_KEY);
      const actionList = Array.isArray(actionStore[tid]) ? actionStore[tid] : [];
      const keptActions = actionList.filter((a) => {
        if (typeof a.id === 'string' && actionSet.has(a.id)) return false;
        if (typeof a.conversationId === 'string' && convSet.has(a.conversationId)) {
          if (typeof a.id === 'string' && a.id) actionSet.add(a.id);
          return false;
        }
        return true;
      });
      if (keptActions.length !== actionList.length) {
        actionStore[tid] = keptActions;
        writeSettingsRecord(db, ACTIONS_KEY, actionStore);
      }
    }

    if (intakeSet.size > 0) {
      const intakeStore = readSettingsRecord<string[]>(db, LIVE_TEST_INTAKES_KEY);
      const existing = Array.isArray(intakeStore[tid]) ? intakeStore[tid] : [];
      const kept = existing.filter((reqId) => !intakeSet.has(reqId));
      if (kept.length !== existing.length) {
        intakeStore[tid] = kept;
        writeSettingsRecord(db, LIVE_TEST_INTAKES_KEY, intakeStore);
      }
    }

    const allActionIds = [...actionSet];
    deleteByColumnValues(db, 'x_support_action_executions', tenantId, 'action_id', allActionIds);
    deleteByColumnValues(db, 'x_support_desk_ticket_state', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_desk_intakes', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_desk_intakes', tenantId, 'request_id', intakeReqArr);
    deleteByColumnValues(db, 'x_support_desk_copilot_jobs', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_runtime_leases', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_runtime_turns', tenantId, 'conversation_id', convIdArr);
    deleteByColumnValues(db, 'x_support_runtime_turns', tenantId, 'request_id', chatReqArr);
  })();
}
