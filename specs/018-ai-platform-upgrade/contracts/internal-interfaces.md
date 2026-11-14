# Contract: Giao diện nội bộ giữa các module

Các chữ ký dưới đây là ranh giới giữa các module trong `server/src/custom/ai-platform/`. Module chỉ import nhau qua các hàm này; kiểu dùng chung với client đặt ở `shared/ai-platform.ts`. Quy tắc chung: hàm trên đường nóng không ném lỗi ra ngoài (bắt, ghi cảnh báo, trả giá trị "không làm gì"), trừ khi ghi chú khác.

```ts
// flags.ts
export type Pillar = 'prompts' | 'retrieval' | 'promptCache' | 'mcpClient' | 'outputGuard' | 'orchestrator';
export function isPillarEnabled(p: Pillar): boolean;          // đọc có cache 5 giây; lỗi DB → false
export function getFlags(): Record<Pillar, boolean>;
export function setFlags(patch: Partial<Record<Pillar, boolean>>): Record<Pillar, boolean>;

// permissions.ts
export function aiPlatformPermission(method: string, path: string): Permission; // chưa ánh xạ → 'manage_ai_platform'

// wire/detect.ts
export type Wire = 'openai-chat' | 'anthropic' | 'responses' | 'gemini';
export function detectWire(req: Request): { wire: Wire; stream: boolean } | null;

// wire/extract.ts
export function lastUserText(wire: Wire, body: unknown): string;
export function requestedModel(wire: Wire, req: Request): string;
export function setRequestedModel(wire: Wire, req: Request, model: string): void;
export function addSystemBlock(wire: Wire, body: unknown, text: string, position: 'stable' | 'volatile'): void;
export function addTools(wire: Wire, body: unknown, tools: ToolDefinition[]): void;

// wire/respond.ts
export function sendText(res: Response, wire: Wire, stream: boolean, text: string,
  meta: { model: string; finish: 'stop' | 'content_filter'; usage?: Usage }): void;

// wire/interceptor.ts
export interface OutputFilter {
  name: string;
  onDelta?(text: string): { emit: string; stop?: { replacement: string; reason: string } };
  onComplete?(full: string): Promise<{ replaceWith?: string; reason?: string }> | { replaceWith?: string; reason?: string };
  onUsage?(usage: unknown): void;
  buffering?: boolean;            // true: cần toàn bộ văn bản trước khi nhả
}
export function installInterceptor(req: Request, res: Response, wire: Wire, filters: OutputFilter[]): void;
// Không có filter nào → không bọc res. Lỗi phân tích → cho qua nguyên vẹn (hoặc chặn nếu filter đặt failClosed).

// loopback.ts
export interface LoopbackRequest {
  messages: ChatMessage[]; model: string; tools?: ToolDefinition[]; maxTokens?: number;
  runId?: string; depth: number; signal: AbortSignal;
}
export function callGateway(req: Request, body: LoopbackRequest): Promise<{
  message: ChatMessage; finishReason: string; usage: Usage; servedModel: string;
}>;                                                                   // ném GatewayCallError (status, code)
export function isInternalCall(req: Request): { runId?: string; depth: number } | null;
export function captureInternalCall(req: Request): void;
// Gọi tại đầu profile gate, trước mọi thay đổi body. Lưu kết quả xác thực của request
// trong WeakMap riêng; isInternalCall dùng kết quả đó sau khi chèn tri thức/cap token.

// pipeline.ts — điểm vào duy nhất từ middleware/profile-gate.ts
export function runPreRequest(req: Request, res: Response, profile: GateProfile, endUser: string | null):
  Promise<'continue' | 'handled'>;
// 'handled': đã trả lời (quy trình, vòng lặp công cụ, lỗi); cổng không gọi next().
// Mọi công tắc tắt → trả 'continue' đồng bộ sau một lần đọc cờ, không đụng req/res.

// prompts/render.ts
export function renderPrompt(template: string | null | undefined): string | null | undefined;
// Không chứa "{{" hoặc trụ cột tắt → trả đúng tham chiếu đầu vào.
export function renderWith(template: string, values: Record<string, string>, declared: PromptVariable[]):
  { rendered: string; missing: string[] };
export function validateTemplate(body: string, declared: PromptVariable[]):
  { ok: true } | { ok: false; line: number; column: number; reason: string };

// prompts/store.ts
export function getPublishedPrompt(scope: Scope): { version: number; body: string; variables: PromptVariable[] } | null;
export function saveDraft(scope: Scope, input: DraftInput, actorId: number): PromptVersion;       // ném RevisionConflict
export function publish(scope: Scope, revision: number, actorId: number): PromptHead;
export function restore(scope: Scope, version: number, revision: number, actorId: number): PromptHead;

// retrieval/hybrid.ts
export interface RetrievalHit { docRef: string; docTitle: string; chunkOrd: number; text: string;
  score: number; bm25Rank: number | null; vectorRank: number | null }
export function retrieve(scope: Scope, query: string, opts: { role?: string; maxChars: number; signal?: AbortSignal }):
  Promise<{ hits: RetrievalHit[]; modeUsed: 'keyword' | 'semantic' | 'hybrid'; degraded: boolean }>;
// Trụ cột tắt hoặc mode 'keyword' → đúng kết quả của searchKnowledge / searchSupportKnowledge hiện có.

// retrieval/indexer.ts
export function onDocumentChanged(scope: Scope, docRef: string): void;     // xóa vector cũ đồng bộ, xếp job
export function onDocumentDeleted(scope: Scope, docRef: string): void;
export function startIndexWorker(): void;                                  // gọi một lần lúc khởi động

// retrieval/citations.ts
export function citationFilter(res: Response, wire: Wire, hits: RetrievalHit[]): OutputFilter | null;

// prompt-cache/breakpoints.ts
export function applyCacheBreakpoints<T extends ChatMessage[]>(messages: T, tools: unknown[] | undefined,
  target: { platform: string; modelId: string }): { messages: T; tools: unknown[] | undefined };
// Trụ cột tắt → trả đúng tham chiếu đầu vào. Không bao giờ sửa tại chỗ.

// prompt-cache/stats.ts
export function cacheUsageFilter(profileId: number, wire: Wire): OutputFilter;

// mcp-client/transport.ts
export function mcpInitialize(server: McpServerRow, signal: AbortSignal): Promise<McpSession>;
export function mcpListTools(session: McpSession, signal: AbortSignal): Promise<McpToolDescriptor[]>;
export function mcpCallTool(session: McpSession, name: string, args: unknown, signal: AbortSignal):
  Promise<{ content: string; isError: boolean; bytes: number; truncated: boolean }>;
// Ném McpTransportError('timeout' | 'unsafe_url' | 'http' | 'protocol' | 'too_large').

// mcp-client/tools.ts
export function toolsForScope(scope: Scope): BoundTool[];     // chỉ allowed + máy chủ enabled, chưa paused
export function executeTool(ctx: ToolContext, tool: BoundTool, args: unknown):
  Promise<{ kind: 'result'; text: string } | { kind: 'error'; text: string } | { kind: 'awaiting_approval'; approvalId: number }>;
// Luôn: che tham số và kết quả, bọc <tool_result trust="untrusted">, ghi custom_ai_tool_calls.

// mcp-client/tool-loop.ts
export function runToolLoop(req: Request, input: {
  scope: Scope; messages: ChatMessage[]; model: string; callerTools: ToolDefinition[];
  maxRounds: number; signal: AbortSignal; runId?: string; onStep?: (s: StepRecord) => void;
}): Promise<{ message: ChatMessage; finishReason: string; usage: Usage; rounds: number;
  pendingApprovalId?: number; callerToolCalls?: ChatToolCall[] }>;

// output-guard/policy.ts
export function outputFilterFor(scope: Scope, ctx: { role?: string; endUser: string | null; wire: Wire;
  stream: boolean; systemPrompt: string | null; runId?: string }): OutputFilter | null;   // mode 'off' → null
export function evaluateOutput(scope: Scope, text: string, ctx: GuardContext):
  Promise<{ action: 'pass' | 'logged' | 'masked' | 'blocked'; text: string; reason?: string }>;
// Dùng cho đường không qua interceptor: support runtime, câu trả lời cuối của lần chạy tiếp tục ở nền.

// orchestrator/engine.ts
export function isFlowModel(model: string): string | null;                // 'flow:x' → 'x'
export function startRun(req: Request, res: Response, input: { slug: string; profile: GateProfile;
  endUser: string | null; wire: Wire; stream: boolean; messages: ChatMessage[] }): Promise<void>;
export function resumeRun(runId: string, approval: { id: number; approved: boolean; note?: string }): Promise<void>;
export function cancelRun(runId: string, reason: 'client_disconnect' | 'admin'): boolean;
export function markInterruptedRuns(): number;                            // gọi một lần lúc khởi động

// masking.ts
export function maskText(scope: Scope, text: string, role?: string): string;
export function maskData<T>(scope: Scope, value: T, role?: string): T;
```

## Bất biến

- `runPreRequest`, `renderPrompt`, `applyCacheBreakpoints`, `retrieve` trả kết quả "không làm gì" bằng đúng tham chiếu đầu vào khi trụ cột tắt, để test hồi quy so sánh được bằng đồng nhất tham chiếu.
- Không module nào ngoài `mcp-client/transport.ts` mở kết nối tới máy chủ MCP; không module nào ngoài `loopback.ts` gọi lại gateway.
- Không module nào ghi tham số hay kết quả công cụ chưa che vào DB, trừ `custom_ai_approvals.args_ciphertext` (mã hóa).
- `orchestrator/` phụ thuộc `mcp-client/`, `output-guard/`, `retrieval/`, `prompts/`; chiều ngược lại bị cấm.
