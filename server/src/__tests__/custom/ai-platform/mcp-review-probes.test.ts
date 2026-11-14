import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../../db/index.js';
import { setFlags, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { createServer, syncServerTools, reviewTool, listServerTools, setAllowedInternalOrigins, testServer, listServers, getServerTransportConfig } from '../../../custom/ai-platform/mcp-client/registry.js';
import { setBindings, toolsForScope } from '../../../custom/ai-platform/mcp-client/bindings.js';
import { executeTool } from '../../../custom/ai-platform/mcp-client/tools.js';
import { approveAction, listApprovals } from '../../../custom/ai-platform/orchestrator/approvals.js';
import { toLoopbackMessages, extractLoopParams } from '../../../custom/ai-platform/mcp-client/messages.js';
import { mcpInitialize } from '../../../custom/ai-platform/mcp-client/transport.js';
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
describe('Reviewer security and behavior probes',()=>{
 it('never persists credentials/passwords in pending approval public args',async()=>{
  await setup(); const json=JSON.stringify(listApprovals());
  expect(json).not.toContain('opaque-review-credential');
  expect(json).not.toContain('opaque-review-password');
 });
 it('rejects an old approval after schema/description changes and the tool is reviewed again',async()=>{
  const s=await setup();
  fake.setConfig({tools:[{...descriptor,description:'different operation after remote update'}]});
  await syncServerTools(s.server.id,null); reviewTool(s.tool.id,{state:'allowed',effect:'write'},null);
  await expect(approveAction(s.approvalId,null)).rejects.toMatchObject({code:'tool_schema_changed'});
  expect(fake.getDispatchCount('tools/call')).toBe(0);
 });
 it('revoking scope enablement prevents dispatch of an existing approval',async()=>{
  const s=await setup(); setBindings(s.scope,{toolIds:[s.tool.id],enabled:false});
  await expect(approveAction(s.approvalId,null)).rejects.toBeTruthy();
  expect(fake.getDispatchCount('tools/call')).toBe(0);
 });
 it('persists the approved execution outcome rather than retaining awaiting_approval forever',async()=>{
  const s=await setup(); const a=await approveAction(s.approvalId,null);
  expect(a.status).toBe('succeeded');
  const row=getDb().prepare('SELECT status,result_masked FROM custom_ai_tool_calls').get() as {status:string;result_masked:string};
  expect(row.status).toBe('ok'); expect(row.result_masked).toContain('operation complete');
 });
 it('redacts remote credential echoes from initialize serverInfo and server lists',async()=>{
  const s=await setup(); fake.setConfig({serverInfo:{name:'fake',version:'1',echo:'opaque-review-credential'}});
  expect(JSON.stringify(await testServer(s.server.id))).not.toContain('opaque-review-credential');
  expect(JSON.stringify(listServers())).not.toContain('opaque-review-credential');
 });
 it('falls back instead of losing unsupported Anthropic thinking blocks',()=>{
  expect(toLoopbackMessages('anthropic',{messages:[{role:'assistant',content:[{type:'thinking',thinking:'reason',signature:'sig'},{type:'text',text:'prior answer'}]},{role:'user',content:'next'}]})).toBeNull();
 });
 it('preserves tool_choice none and structured output or declines takeover',()=>{
  const body={messages:[{role:'user',content:'hello'}],tool_choice:'none',response_format:{type:'json_object'}};
  const messages=toLoopbackMessages('openai-chat',body);
  const params=extractLoopParams('openai-chat',body);
  expect(messages===null || ('toolChoice' in params && 'responseFormat' in params)).toBe(true);
 });
 it('sanitizes protocol errors propagated from sync to its HTTP router',async()=>{
  const s=await setup(); fake.setConfig({protocolVersion:'opaque-review-credential'});
  let message='';try{await syncServerTools(s.server.id,null);}catch(error){message=String(error);}
  expect(message).not.toContain('opaque-review-credential');
 });
 it('includes DNS resolution in the transport deadline',async()=>{
  const s=await setup();
  const config={...getServerTransportConfig(s.server.id),url:'https://dns-review.example.test/mcp',timeoutMs:50};
  const start=Date.now();
  await expect(mcpInitialize(config,new AbortController().signal,{dnsResolver:async()=>{await new Promise(r=>setTimeout(r,350));return ['93.184.216.34'];}})).rejects.toBeTruthy();
  expect(Date.now()-start).toBeLessThan(200);
 });
});
