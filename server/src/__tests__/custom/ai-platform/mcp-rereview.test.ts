import { updateServer } from '../../../custom/ai-platform/mcp-client/registry.js';
import { assertApprovalExecutable } from '../../../custom/ai-platform/mcp-client/approval-safety.js';
import { maybeRunMcpMaintenance } from '../../../custom/ai-platform/mcp-client/maintenance.js';
import { down as rollbackSafety } from '../../../db/migrations/20261114_200000_custom_ai_mcp_approval_safety.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../../db/index.js';
import { setFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { createServer, syncServerTools, reviewTool, listServerTools, setAllowedInternalOrigins, testServer, getServerTransportConfig } from '../../../custom/ai-platform/mcp-client/registry.js';
import { setBindings, toolsForScope } from '../../../custom/ai-platform/mcp-client/bindings.js';
import { executeTool } from '../../../custom/ai-platform/mcp-client/tools.js';
import { mcpInitialize, mcpCallTool } from '../../../custom/ai-platform/mcp-client/transport.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from '../../helpers/ai-platform-fake-mcp-http.js';

let fake: FakeMcpHttpServer;
const descriptor = { name: 'mutate', description: 'original approved operation', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
beforeEach(async () => {
 process.env.ENCRYPTION_KEY = '0'.repeat(64);
 initDb(':memory:'); resetFlagsCacheForTests(); setFlags({mcpClient:true});
 fake = await startFakeMcpHttpServer({tools:[descriptor],onToolCall:()=>({content:[{type:'text',text:'operation complete'}]})});
 setAllowedInternalOrigins([fake.origin]);
});
afterEach(async () => { await fake.close(); resetFlagsCacheForTests(); try {getDb().close();} catch {} });
async function setup() {
 const id = Number(getDb().prepare("INSERT INTO client_profiles(name,token_hash,encrypted_key,iv,auth_tag,enabled) VALUES ('review','review-hash','enc','iv','tag',1)").run().lastInsertRowid);
 const scope={kind:'profile' as const,id:String(id)};
 const server=await createServer({slug:'review',name:'Review',url:fake.url,authKind:'bearer',secret:'opaque-review-credential'},null);
 await syncServerTools(server.id,null);
 const tool=listServerTools(server.id)[0]!;
 reviewTool(tool.id,{state:'allowed',effect:'write'},null);
 setBindings(scope,{toolIds:[tool.id],enabled:true});
 const ctx={scope,endUser:'review-user',turnId:'review-turn',stepSeq:1,signal:new AbortController().signal};
 const outcome=await executeTool(ctx,toolsForScope(scope)[0]!,{id:'order',password:'opaque-review-password',note:'opaque-review-credential'});
 if(outcome.kind!=='awaiting_approval') throw new Error('setup did not queue approval');
 return {scope,server,tool,approvalId:outcome.approvalId};
}
describe('Second reviewer pass',()=>{
 it('redacts configured credentials shorter than six characters',async()=>{
  const s=await setup(); await updateServer(s.server.id,{revision:s.server.revision,secret:'zY9!q'},null);
  fake.setConfig({serverInfo:{name:'fake',version:'1',echo:'zY9!q'}});
  expect(JSON.stringify(await testServer(s.server.id))).not.toContain('zY9!q');
 });
 it('preserves an existing migration column when rolling back only the safety migration',()=>{
  rollbackSafety(getDb());
  const cols=getDb().prepare('PRAGMA table_info(custom_ai_mcp_servers)').all() as Array<{name:string}>;
  expect(cols.some(c=>c.name==='credential_generation')).toBe(true);
 });
 it('does not label another live owner as a restarted process',async()=>{
  const s=await setup();
  getDb().prepare("UPDATE custom_ai_approvals SET status='executing',owner_instance_id='live-process-A' WHERE id=?").run(s.approvalId);
  maybeRunMcpMaintenance({force:true,ownerInstanceId:'live-process-B'});
  const row=getDb().prepare('SELECT status FROM custom_ai_approvals WHERE id=?').get(s.approvalId) as {status:string};
  expect(row.status).toBe('executing');
 });
 it('prevents dispatch when scope is revoked after the guard but during DNS resolution',async()=>{
  const s=await setup();
  const url=`http://revocation-review.test:${fake.port}/mcp`;
  const config={...getServerTransportConfig(s.server.id),url};
  // Snapshot the actual target identity, then use the real HTTP transport with a pinned local DNS fixture.
  getDb().prepare('UPDATE custom_ai_mcp_servers SET url=? WHERE id=?').run(url,s.server.id);
  getDb().prepare("UPDATE custom_ai_approvals SET snapshot_json=json_set(snapshot_json,'$.serverUrl',?) WHERE id=?").run(url,s.approvalId);
  setAllowedInternalOrigins([fake.origin,new URL(url).origin]);
  const opts={allowedInternalOrigins:[new URL(url).origin],dnsResolver:async()=>['127.0.0.1']};
  const session=await mcpInitialize(config,new AbortController().signal,opts);
  const row=getDb().prepare('SELECT snapshot_json FROM custom_ai_approvals WHERE id=?').get(s.approvalId) as {snapshot_json:string};
  const promise=mcpCallTool(config,session,'mutate',{id:'order'},new AbortController().signal,{
   ...opts,retryOn404:false,
   preDispatchGuard:async()=>{await assertApprovalExecutable(row.snapshot_json);},
   dnsResolver:async()=>{setBindings(s.scope,{toolIds:[s.tool.id],enabled:false});await new Promise(r=>setTimeout(r,15));return ['127.0.0.1'];}
  });
  let failure:unknown;try{await promise;}catch(error){failure=error;}
  expect(fake.getDispatchCount('tools/call')).toBe(0);
  expect(failure).toBeTruthy();
 });
});
