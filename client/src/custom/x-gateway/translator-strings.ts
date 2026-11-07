import { useI18n } from '@/i18n';

export interface TranslatorStrings {
  translatorNav: string;
  translatorTitle: string;
  translatorHelp: string;
  sourceProtocol: string;
  targetProtocol: string;
  swapProtocols: string;
  templates: string;
  selectTemplate: string;
  beautifyJson: string;
  clear: string;
  copyJson: string;
  copied: string;
  inputPayload: string;
  outputPayload: string;
  pipelineTrace: string;
  pipelineTabTitle: string;
  transformedTabTitle: string;
  dispatchTabTitle: string;
  validJson: string;
  invalidJson: string;
  sourceTokens: string;
  targetTokens: string;
  tokenDelta: string;
  inspecting: string;
  stepNumber: string;
  warningsCount: string;
  testDispatch: string;
  dispatching: string;
  dispatchSuccess: string;
  dispatchError: string;
  availableKeys: string;
  latency: string;
  emptyOutputHelp: string;
  sendToGateway: string;
  protocolOpenAIChat: string;
  protocolAnthropic: string;
  protocolOpenAIResponses: string;
  protocolGemini: string;
  protocolSseOpenAI: string;
  protocolSseAnthropic: string;
  step1: string;
  step2: string;
  step3: string;
  step4: string;
  step5: string;
  step6: string;
  step7: string;
}

const STRINGS: Record<'en' | 'vi', TranslatorStrings> = {
  en: {
    translatorNav: 'Translator',
    translatorTitle: 'Protocol Translator Inspector',
    translatorHelp:
      'Inspect and debug the 7-step cross-protocol transformation pipeline between OpenAI, Anthropic Claude, Google Gemini, and streaming SSE events.',
    sourceProtocol: 'Source Protocol',
    targetProtocol: 'Target Protocol',
    swapProtocols: 'Swap source and target',
    templates: 'Templates',
    selectTemplate: 'Load sample template...',
    beautifyJson: 'Format JSON',
    clear: 'Clear',
    copyJson: 'Copy JSON',
    copied: 'Copied!',
    inputPayload: 'Source Request Payload',
    outputPayload: 'Transformed Payload',
    pipelineTrace: '7-Step Transformation Pipeline',
    pipelineTabTitle: 'Pipeline Trace (7 Steps)',
    transformedTabTitle: 'Transformed JSON',
    dispatchTabTitle: 'Gateway Dispatch Test',
    validJson: 'Valid JSON',
    invalidJson: 'Syntax Error',
    sourceTokens: 'Source Tokens',
    targetTokens: 'Target Tokens',
    tokenDelta: 'Delta',
    inspecting: 'Translating...',
    stepNumber: 'Step',
    warningsCount: 'warnings',
    testDispatch: 'Verify Gateway Route',
    dispatching: 'Verifying...',
    dispatchSuccess: 'Route Verified',
    dispatchError: 'Dispatch Failed',
    availableKeys: 'Active Accounts',
    latency: 'Latency',
    emptyOutputHelp: 'Enter valid JSON payload or choose a template to view the transformation pipeline.',
    sendToGateway: 'Simulate Gateway Route',
    protocolOpenAIChat: 'OpenAI Chat (/v1/chat/completions)',
    protocolAnthropic: 'Anthropic Claude (/v1/messages)',
    protocolOpenAIResponses: 'OpenAI Responses (/v1/responses)',
    protocolGemini: 'Google Gemini (generateContent)',
    protocolSseOpenAI: 'OpenAI SSE Stream Chunk',
    protocolSseAnthropic: 'Anthropic SSE Stream Event',
    step1: '1. Ingestion & Schema Validation',
    step2: '2. System Message Extraction',
    step3: '3. Turn & Role Normalization',
    step4: '4. Content & Multimodal Adaptation',
    step5: '5. Tool Calling & Function Schemas',
    step6: '6. Hyperparameters & Controls',
    step7: '7. Target Assembly & Token Estimation',
  },
  vi: {
    translatorNav: 'Bộ chuyển đổi',
    translatorTitle: 'Protocol Translator Inspector',
    translatorHelp:
      'Kiểm tra và gỡ lỗi quy trình chuyển đổi giao thức 7 bước giữa OpenAI, Anthropic Claude, Google Gemini và luồng streaming SSE.',
    sourceProtocol: 'Giao thức nguồn',
    targetProtocol: 'Giao thức đích',
    swapProtocols: 'Đổi chiều nguồn và đích',
    templates: 'Mẫu có sẵn',
    selectTemplate: 'Chọn mẫu payload mẫu...',
    beautifyJson: 'Định dạng JSON',
    clear: 'Xóa nội dung',
    copyJson: 'Sao chép JSON',
    copied: 'Đã sao chép!',
    inputPayload: 'Payload yêu cầu nguồn',
    outputPayload: 'Payload sau chuyển đổi',
    pipelineTrace: 'Pipeline chuyển đổi 7 bước',
    pipelineTabTitle: 'Truy vết Pipeline (7 bước)',
    transformedTabTitle: 'JSON sau chuyển đổi',
    dispatchTabTitle: 'Kiểm thử Gateway',
    validJson: 'JSON hợp lệ',
    invalidJson: 'Lỗi cú pháp',
    sourceTokens: 'Token nguồn',
    targetTokens: 'Token đích',
    tokenDelta: 'Chênh lệch',
    inspecting: 'Đang dịch...',
    stepNumber: 'Bước',
    warningsCount: 'cảnh báo',
    testDispatch: 'Kiểm tra Route Gateway',
    dispatching: 'Đang kiểm tra...',
    dispatchSuccess: 'Route hợp lệ',
    dispatchError: 'Kiểm tra thất bại',
    availableKeys: 'Tài khoản khả dụng',
    latency: 'Độ trễ',
    emptyOutputHelp: 'Nhập payload JSON hợp lệ hoặc chọn một mẫu thử để theo dõi quy trình chuyển đổi.',
    sendToGateway: 'Mô phỏng gửi qua Gateway',
    protocolOpenAIChat: 'OpenAI Chat (/v1/chat/completions)',
    protocolAnthropic: 'Anthropic Claude (/v1/messages)',
    protocolOpenAIResponses: 'OpenAI Responses (/v1/responses)',
    protocolGemini: 'Google Gemini (generateContent)',
    protocolSseOpenAI: 'OpenAI SSE Stream Chunk',
    protocolSseAnthropic: 'Anthropic SSE Stream Event',
    step1: '1. Nhận dạng & Kiểm tra Schema',
    step2: '2. Trích xuất chỉ dẫn hệ thống',
    step3: '3. Chuẩn hóa lượt hội thoại & Vai trò',
    step4: '4. Xử lý nội dung đa phương tiện',
    step5: '5. Ánh xạ Function & Schema Tool',
    step6: '6. Tham số sinh & Điều khiển lấy mẫu',
    step7: '7. Đóng gói đích & Ước tính Token',
  },
};

export function useTranslatorStrings(): TranslatorStrings {
  const { locale } = useI18n();
  return STRINGS[locale === 'vi' ? 'vi' : 'en'];
}
