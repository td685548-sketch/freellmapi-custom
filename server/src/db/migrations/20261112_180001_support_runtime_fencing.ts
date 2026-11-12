import type { Db } from '../types.js';

export function up(db: Db): void {
  for (const [table, column] of [
    ['x_support_action_executions', 'decision'],
    ['x_support_partner_deliveries', 'claim_token'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length && !columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

export function down(db: Db): void {
  for (const [table, column] of [
    ['x_support_partner_deliveries', 'claim_token'],
    ['x_support_action_executions', 'decision'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
