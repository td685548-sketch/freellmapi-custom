import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import type {
  AgentScenarioLane,
  IntentCategory,
  IntentClassificationResult,
  IntentClassifyPreviewRequest,
  LearnedModelCapRecord,
  ModelsDevSyncResult,
  ModelsDevSyncStatus,
  ScenarioRoutingPolicy,
  SmartRoutingDecisionMode,
} from '../../../../shared/smart-routing-v2'

export type {
  AgentScenarioLane,
  IntentCategory,
  IntentClassificationResult,
  IntentClassifyPreviewRequest,
  LearnedModelCapRecord,
  ModelsDevSyncResult,
  ModelsDevSyncStatus,
  ScenarioRoutingPolicy,
  SmartRoutingDecisionMode,
}

export const SCENARIO_LANE_ORDER: readonly AgentScenarioLane[] = [
  'default',
  'background',
  'think',
  'longContext',
  'webSearch',
  'vision',
] as const

export interface LearnedCapsResponse {
  caps: LearnedModelCapRecord[]
}

export interface ClearLearnedCapsResponse {
  ok: boolean
  cleared: number
  caps: LearnedModelCapRecord[]
}

export interface SyncModelsDevResponse extends ModelsDevSyncResult {
  status: ModelsDevSyncStatus
}

export const smartRoutingV2Api = {
  getPolicy: (signal?: AbortSignal) =>
    apiFetch<ScenarioRoutingPolicy>('/api/thruline/smart-routing/policy', { signal }),
  savePolicy: (body: Partial<ScenarioRoutingPolicy>) =>
    apiFetch<ScenarioRoutingPolicy>('/api/thruline/smart-routing/policy', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  classifyPreview: (body: IntentClassifyPreviewRequest) =>
    apiFetch<IntentClassificationResult>('/api/thruline/smart-routing/classify-preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getLearnedCaps: (signal?: AbortSignal) =>
    apiFetch<LearnedCapsResponse>('/api/thruline/smart-routing/learned-caps', { signal }),
  clearLearnedCaps: (params?: { provider?: string; modelId?: string; endpointScope?: string }) => {
    const search = new URLSearchParams()
    if (params?.provider) search.set('provider', params.provider)
    if (params?.modelId) search.set('modelId', params.modelId)
    if (params?.endpointScope !== undefined) search.set('endpointScope', params.endpointScope)
    const qs = search.toString()
    return apiFetch<ClearLearnedCapsResponse>(
      `/api/thruline/smart-routing/learned-caps${qs ? `?${qs}` : ''}`,
      { method: 'DELETE' },
    )
  },
  getModelsDevStatus: (signal?: AbortSignal) =>
    apiFetch<ModelsDevSyncStatus>('/api/thruline/smart-routing/models-dev/status', { signal }),
  setModelsDevEnabled: (enabled: boolean) =>
    apiFetch<ModelsDevSyncStatus>('/api/thruline/smart-routing/models-dev/status', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  syncModelsDev: (dryRun = false) =>
    apiFetch<SyncModelsDevResponse>('/api/thruline/smart-routing/models-dev/sync', {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
    }),
}

const en = {
  sectionTitle: 'Smart Routing v2 & Learned Caps',
  sectionHelp: 'Sub-millisecond intent and agent scenario lane routing, persistent learned token ceilings, and models.dev capability sync.',
  readOnly: 'You can view smart routing status and run previews, but cannot modify policy.',
  loadError: 'Could not load Smart Routing v2 settings.',
  retry: 'Retry',
  enablePolicy: 'Enable Scenario & Intent Routing on auto requests',
  enablePolicyHelp: 'Automatically route /thruline/v1 auto requests to specialized combos or models in under 1ms.',
  decisionMode: 'Classifier mode',
  modeHeuristic: 'Heuristic (<1ms zero-latency multilingual)',
  modeLlm: 'LLM + Heuristic fallback',
  longContextThreshold: 'Long-context threshold (tokens)',
  longContextThresholdHelp: 'Requests at or above this estimated input size enter the longContext lane (1,000 – 2,000,000).',
  lanePlaceholder: 'e.g. combo:coding-flagship or groq/llama-3.3-70b-versatile',
  laneDefault: 'Default lane',
  laneBackground: 'Background lane (titles, commits, summaries)',
  laneThink: 'Think / Deep reasoning lane',
  laneLongContext: 'Long-context lane',
  laneWebSearch: 'Web search lane',
  laneVision: 'Vision / Multimodal lane',
  savePolicy: 'Save Smart Routing Policy',
  policySaved: 'Smart routing policy saved.',
  saveError: 'Could not save policy. Check inputs and try again.',
  testerTitle: 'Live <1ms Intent & Scenario Tester',
  testerHelp: 'Test English, Vietnamese, or multilingual prompts against your active scenario lanes.',
  testerPromptLabel: 'Sample user prompt',
  testerPromptPlaceholder: 'Viết hàm TypeScript giải phương trình hoặc tạo tiêu đề ngắn...',
  testerSystemLabel: 'System prompt (optional)',
  testerVisionFlag: 'Has image / vision block',
  testerWebSearchFlag: 'Has web_search tool',
  testerThinkingFlag: 'Extended thinking enabled',
  testerRun: 'Classify Prompt',
  testerRunning: 'Classifying...',
  resultIntent: 'Intent',
  resultScenario: 'Scenario Lane',
  resultPreset: 'Recommended Preset',
  resultTarget: 'Resolved Target',
  resultLatency: 'Classifier Latency',
  resultSignals: 'Signals',
  targetAutoFallback: 'auto (default pool)',
  capsTitle: 'Persistent Learned Model Caps',
  capsHelp: 'Ceilings automatically learned from upstream 400 rejections (max_tokens, thinking.budget_tokens, reasoning_effort) and persisted in SQLite.',
  capsEmpty: 'No learned model caps recorded yet.',
  capsClearAll: 'Clear All Learned Caps',
  capsDeleteRow: 'Clear',
  capsColModel: 'Provider / Model',
  capsColMaxOut: 'Max Output',
  capsColThinkBudget: 'Max Thinking',
  capsColEfforts: 'Reasoning Efforts',
  capsColHits: 'Hits',
  capsColActions: 'Actions',
  modelsDevTitle: 'models.dev Capability & Pricing Sync',
  modelsDevHelp: 'Sync context windows, output ceilings, modalities, and pricing from models.dev (Priority: User Override > models.dev > Builtin).',
  modelsDevEnablePeriodic: 'Enable background periodic sync (24h)',
  modelsDevEnvKillSwitch: 'Disabled by MODELS_DEV_SYNC_ENABLED=0 environment kill-switch.',
  modelsDevEnvForcedOn: 'Forced ON by MODELS_DEV_SYNC_ENABLED=1 environment variable.',
  modelsDevStoredModels: 'Stored model specs',
  modelsDevLastSync: 'Last synced',
  modelsDevNever: 'Never',
  modelsDevSyncNow: 'Sync Now',
  modelsDevDryRun: 'Dry Run',
  modelsDevSyncing: 'Syncing...',
  modelsDevSyncSuccess: 'Sync completed:',
  modelsDevDryRunSuccess: 'Dry-run verified:',
  modelsDevModelsLabel: 'models across',
  modelsDevProvidersLabel: 'providers.',
}

const vi: Record<keyof typeof en, string> = {
  sectionTitle: 'Định tuyến thông minh v2 & Giới hạn tự học',
  sectionHelp: 'Phân loại ý định và kịch bản tác tử dưới 1ms, lưu bền vững trần token tự học, và đồng bộ năng lực từ models.dev.',
  readOnly: 'Bạn có thể xem trạng thái định tuyến thông minh và chạy thử nghiệm, nhưng không thể sửa chính sách.',
  loadError: 'Không tải được cấu hình Định tuyến thông minh v2.',
  retry: 'Thử lại',
  enablePolicy: 'Bật định tuyến theo kịch bản & ý định cho request auto',
  enablePolicyHelp: 'Tự động điều hướng các request auto trên /thruline/v1 tới combo hoặc model chuyên biệt dưới 1ms.',
  decisionMode: 'Chế độ phân loại',
  modeHeuristic: 'Heuristic (<1ms đa ngôn ngữ không độ trễ)',
  modeLlm: 'LLM + Dự phòng Heuristic',
  longContextThreshold: 'Ngưỡng ngữ cảnh dài (token)',
  longContextThresholdHelp: 'Request đạt hoặc vượt số token đầu vào ước tính này sẽ vào làn longContext (1.000 – 2.000.000).',
  lanePlaceholder: 'VD: combo:coding-flagship hoặc groq/llama-3.3-70b-versatile',
  laneDefault: 'Làn mặc định (default)',
  laneBackground: 'Làn tác vụ nền (tiêu đề, commit, tóm tắt)',
  laneThink: 'Làn suy luận sâu (think)',
  laneLongContext: 'Làn ngữ cảnh dài (longContext)',
  laneWebSearch: 'Làn tìm kiếm web (webSearch)',
  laneVision: 'Làn thị giác / đa phương thức (vision)',
  savePolicy: 'Lưu chính sách định tuyến',
  policySaved: 'Đã lưu chính sách định tuyến thông minh.',
  saveError: 'Không lưu được chính sách. Hãy kiểm tra dữ liệu và thử lại.',
  testerTitle: 'Bộ thử phân loại ý định & kịch bản <1ms',
  testerHelp: 'Thử nghiệm câu lệnh tiếng Việt, tiếng Anh hoặc đa ngôn ngữ với cấu hình làn hiện tại.',
  testerPromptLabel: 'Câu lệnh mẫu của người dùng',
  testerPromptPlaceholder: 'Viết hàm TypeScript giải phương trình hoặc tạo tiêu đề ngắn...',
  testerSystemLabel: 'System prompt (tuỳ chọn)',
  testerVisionFlag: 'Có ảnh / khối thị giác',
  testerWebSearchFlag: 'Có công cụ web_search',
  testerThinkingFlag: 'Bật chế độ suy nghĩ mở rộng',
  testerRun: 'Phân loại ngay',
  testerRunning: 'Đang phân loại...',
  resultIntent: 'Ý định',
  resultScenario: 'Làn kịch bản',
  resultPreset: 'Preset đề xuất',
  resultTarget: 'Đích điều hướng',
  resultLatency: 'Độ trễ phân loại',
  resultSignals: 'Tín hiệu khớp',
  targetAutoFallback: 'auto (nhóm mặc định)',
  capsTitle: 'Giới hạn Model tự học (Lưu SQLite)',
  capsHelp: 'Trần giới hạn tự động học từ lỗi 400 của nhà cung cấp (max_tokens, thinking.budget_tokens, reasoning_effort) và lưu bền vững.',
  capsEmpty: 'Chưa có giới hạn model tự học nào được ghi nhận.',
  capsClearAll: 'Xoá tất cả giới hạn tự học',
  capsDeleteRow: 'Xoá',
  capsColModel: 'Nhà cung cấp / Model',
  capsColMaxOut: 'Trần Output',
  capsColThinkBudget: 'Trần Thinking',
  capsColEfforts: 'Mức Reasoning',
  capsColHits: 'Số lần',
  capsColActions: 'Thao tác',
  modelsDevTitle: 'Đồng bộ năng lực & bảng giá models.dev',
  modelsDevHelp: 'Đồng bộ cửa sổ ngữ cảnh, trần output, đa phương thức và giá từ models.dev (Ưu tiên: Ghi đè thủ công > models.dev > Mặc định).',
  modelsDevEnablePeriodic: 'Bật đồng bộ định kỳ chạy nền (24h)',
  modelsDevEnvKillSwitch: 'Đã bị tắt cứng bởi biến môi trường MODELS_DEV_SYNC_ENABLED=0.',
  modelsDevEnvForcedOn: 'Đang ép BẬT bởi biến môi trường MODELS_DEV_SYNC_ENABLED=1.',
  modelsDevStoredModels: 'Số model đã lưu',
  modelsDevLastSync: 'Đồng bộ lần cuối',
  modelsDevNever: 'Chưa từng',
  modelsDevSyncNow: 'Đồng bộ ngay',
  modelsDevDryRun: 'Chạy thử (Dry Run)',
  modelsDevSyncing: 'Đang đồng bộ...',
  modelsDevSyncSuccess: 'Đồng bộ hoàn tất:',
  modelsDevDryRunSuccess: 'Chạy thử hợp lệ:',
  modelsDevModelsLabel: 'model trên',
  modelsDevProvidersLabel: 'nhà cung cấp.',
}

export function useSmartRoutingV2Strings() {
  const { locale } = useI18n()
  return locale === 'vi' ? vi : en
}
