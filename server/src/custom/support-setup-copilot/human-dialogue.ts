import type {
  SupportSetupChatIntent,
  SupportSetupChatMessage,
  SupportSetupProposal,
  SupportSetupRequirements,
  SupportSetupStepId,
  SupportSetupTenantDiagnostic,
} from '@freellmapi/shared/support-setup-copilot.js';
import {
  buildPlatformExpertReply,
  matchPlatformKnowledgeQuestion,
} from './platform-guide.js';
import { matchPermissionGrantIntent } from './permission-grants.js';

export type HumanConversationalAct =
  | 'frustration_pushback'
  | 'capability_or_pushback'
  | 'hesitation_or_advice'
  | 'no_website_reassurance'
  | 'affirmation_proceed'
  | 'greeting'
  | 'thanks'
  | 'platform_guide'
  | 'step_question'
  | 'roadmap_guide'
  | 'identity_or_permissions'
  | 'permission_grant_revoke'
  | 'business_context';

export interface OpenDomainTopicInsight {
  /** Raw business/topic phrase captured from the user's own words (e.g. "web boardgame", "quán cà phê acoustic"). */
  rawTopic: string;
  /** Conversational Vietnamese label to weave naturally into prose (e.g. "web boardgame", "quán cà phê acoustic"). */
  shortLabelVi: string;
  /** Conversational English label to weave naturally into prose (e.g. "boardgame website", "acoustic cafe"). */
  shortLabelEn: string;
  /** Normalized Vietnamese industry/domain title for SupportSetupRequirements.industry. */
  industryVi: string;
  /** Normalized English industry/domain title for SupportSetupRequirements.industry. */
  industryEn: string;
  /** 2–3 realistic customer scenarios specific to this domain (Vietnamese). */
  customerScenariosVi: string[];
  /** 2–3 realistic customer scenarios specific to this domain (English). */
  customerScenariosEn: string[];
  /** Domain-tailored seed guidance for FAQ & System Prompt generation (Vietnamese). */
  seedFaqHintVi: string;
  /** Domain-tailored seed guidance for FAQ & System Prompt generation (English). */
  seedFaqHintEn: string;
  /** Tailored customer widget quick prompts (Vietnamese). */
  widgetQuickPromptsVi: string[];
  /** Tailored customer widget quick prompts (English). */
  widgetQuickPromptsEn: string[];
  /** Tailored quick-reply chip label for drafting a sample setup immediately (Vietnamese). */
  draftChipVi: string;
  /** Tailored quick-reply chip label for drafting a sample setup immediately (English). */
  draftChipEn: string;
  /** Tailored quick-reply chip example for sharing brand + policy details (Vietnamese). */
  detailExampleChipVi: string;
  /** Tailored quick-reply chip example for sharing brand + policy details (English). */
  detailExampleChipEn: string;
  /** Whether matched via curated domain knowledge or open-ended linguistic noun-phrase extraction. */
  source: 'curated_domain' | 'open_phrase';
}

export interface HumanDialogueTurnParams {
  messages: readonly SupportSetupChatMessage[];
  locale: 'vi' | 'en';
  currentPath?: string | null;
  requirements?: SupportSetupRequirements;
  diagnostic?: SupportSetupTenantDiagnostic | null;
  activeTenantName?: string | null;
  targetMode?: 'create_tenant' | 'update_tenant';
  canCreateTenant?: boolean;
  canEditAny?: boolean;
  hasBaseProposal?: boolean;
  /**
   * Deterministic DB-grounded identity reply (from identity.ts). When the act
   * is `identity_or_permissions` this exact text is returned — the LLM is
   * never asked to answer identity questions from its own knowledge.
   */
  identityReply?: string;
}

export interface HumanDialogueTurnResult {
  act: HumanConversationalAct;
  intent: SupportSetupChatIntent;
  shouldProposeNow: boolean;
  focusedStepId: SupportSetupStepId | null;
  reply: string;
  missingQuestions: string[];
  suggestedQuickReplies: string[];
  extractedRequirements: SupportSetupRequirements;
  topic: OpenDomainTopicInsight | null;
}

export interface HumanProposalIntroParams {
  locale: 'vi' | 'en';
  proposal: Pick<
    SupportSetupProposal,
    'tenantName' | 'tenantSlug' | 'targetMode' | 'requirements' | 'steps'
  >;
  priorMessages?: readonly SupportSetupChatMessage[];
  isRefinement?: boolean;
  topic?: OpenDomainTopicInsight | null;
}

interface CuratedDomainProfile {
  id: string;
  re: RegExp;
  defaultLabelVi: string;
  defaultLabelEn: string;
  industryVi: string;
  industryEn: string;
  customerScenariosVi: string[];
  customerScenariosEn: string[];
  seedFaqHintVi: string;
  seedFaqHintEn: string;
  widgetQuickPromptsVi: string[];
  widgetQuickPromptsEn: string[];
  sampleBrandVi: string;
  samplePolicyVi: string;
  sampleBrandEn: string;
  samplePolicyEn: string;
}

const CURATED_DOMAINS: readonly CuratedDomainProfile[] = [
  {
    id: 'boardgame',
    re: /\bboard\s*-?\s*game(?:s)?\b|trò\s+chơi\s+bàn|\btabletop\b|\bcard\s+game(?:s)?\b|cờ\s+tỷ\s+phú|ma\s+sói|\bcatan\b|\buno\b|\byugioh\b|\bpokemon\s+tcg\b|\bwarhammer\b|\bdnd\b|\bsplendor\b|\bavalon\b|mèo\s+nổ|exploding\s+kittens/i,
    defaultLabelVi: 'shop Boardgame',
    defaultLabelEn: 'boardgame shop',
    industryVi: 'Boardgame / Trò chơi bàn',
    industryEn: 'Board Games & Tabletop',
    customerScenariosVi: [
      'tư vấn chọn bộ game hợp số người chơi, độ tuổi hoặc độ khó (nhóm bạn mới chơi, gia đình hay hội mê chiến thuật)',
      'giải đáp nhanh luật chơi cơ bản và gợi ý kích cỡ bọc bài (sleeves) đi kèm',
      'kiểm tra tình trạng còn hàng, phí ship và chính sách đổi trả khi hộp game thiếu thành phần',
    ],
    customerScenariosEn: [
      'recommending games by player count, play time, and complexity (party games, family night, or heavy strategy)',
      'answering quick rule clarifications and card-sleeve size questions',
      'checking stock availability, shipping fees, and missing-piece replacement policies',
    ],
    seedFaqHintVi:
      'Hỗ trợ tư vấn chọn boardgame theo số lượng người chơi (2 người, nhóm 4–8 người, party đông người), thời lượng ván chơi và độ khó; giải đáp nhanh quy tắc cơ bản, phụ kiện bọc bài (sleeves); hướng dẫn kiểm tra tình trạng sẵn kho, phí giao hàng và quy trình bù mảnh ghép/đổi trả nếu lỗi nhà sản xuất.',
    seedFaqHintEn:
      'Help customers choose board games by player count, play duration, and complexity; clarify game basics and card sleeve sizes; explain stock availability, shipping rates, and manufacturer missing-component replacement policies.',
    widgetQuickPromptsVi: [
      'Gợi ý boardgame vui cho nhóm 4–6 người',
      'Tư vấn cỡ bọc bài (sleeves) & phụ kiện',
      'Chính sách ship hàng & bù thiếu mảnh ghép',
    ],
    widgetQuickPromptsEn: [
      'Recommend a fun board game for 4–6 players',
      'Card sleeve sizes & accessories help',
      'Shipping rates & missing-piece policy',
    ],
    sampleBrandVi: 'Meeple House',
    samplePolicyVi: 'đổi trả 7 ngày nếu thiếu chi tiết, ship nội thành 2h',
    sampleBrandEn: 'Meeple House',
    samplePolicyEn: '7-day missing-piece replacement, free shipping over $50',
  },
  {
    id: 'cafe_fnb',
    re: /quán\s+(?:cà\s+phê|cafe|cf|trà|nước|ăn|nhậu|lẩu|nướng)|tiệm\s+(?:bánh|cà\s+phê|cafe|trà)|cà\s+phê\s+acoustic|cafe\s+acoustic|\bacoustic\s+cafe\b|\bcoffee\s+shop\b|\bbakery\b|\bsourdough\b|trà\s+sữa|nhà\s+hàng|\bbistro\b|\brestaurant\b|đồ\s+ăn\s+vặt|bếp\s+ăn|cơm\s+văn\s+phòng/i,
    defaultLabelVi: 'quán cà phê / ẩm thực',
    defaultLabelEn: 'cafe & dining spot',
    industryVi: 'Quán cà phê & Ẩm thực (F&B)',
    industryEn: 'Cafe, Food & Beverage',
    customerScenariosVi: [
      'hỏi menu đồ uống/món best-seller, mức giá và ưu đãi theo khung giờ',
      'kiểm tra lịch đêm nhạc/sự kiện và đặt bàn trước cho nhóm bạn hoặc hẹn hò',
      'hỏi giờ mở cửa, địa chỉ chỉ đường, chỗ đậu xe và phí giao hàng tận nơi',
    ],
    customerScenariosEn: [
      'browsing signature drinks/menu highlights, pricing, and dietary options',
      'checking live music/event schedules and reserving tables for groups',
      'asking about opening hours, parking, directions, and local delivery',
    ],
    seedFaqHintVi:
      'Tư vấn thực đơn đồ uống/món đặc trưng, khoảng giá, lịch sự kiện/nhạc acoustic (nếu có), hỗ trợ giữ bàn trước theo số lượng khách, cung cấp giờ mở cửa, chỗ gửi xe và chính sách đặt món giao tận nơi.',
    seedFaqHintEn:
      'Assist guests with signature menu items, pricing, live event schedules, table reservations, opening hours, parking details, and delivery orders.',
    widgetQuickPromptsVi: [
      'Xem menu món nổi bật & bảng giá',
      'Đặt bàn trước / Hỏi lịch nhạc tối nay',
      'Giờ mở cửa & địa chỉ chỗ gửi xe',
    ],
    widgetQuickPromptsEn: [
      'Signature menu & pricing',
      'Book a table / Tonight schedule',
      'Opening hours & parking info',
    ],
    sampleBrandVi: 'Góc Nhỏ Acoustic',
    samplePolicyVi: 'mở cửa 7h–22h30, đêm nhạc tối thứ 6 & thứ 7, nhận giữ bàn trước 30 phút',
    sampleBrandEn: 'Corner Acoustic Cafe',
    samplePolicyEn: 'open 7am–10:30pm, live music Fri–Sat nights, free table reservations',
  },
  {
    id: 'sneaker_footwear',
    re: /giày\s+sneaker|\bsneaker(?:s)?\b|shop\s+giày|tiệm\s+giày|cửa\s+hàng\s+giày|giày\s+thể\s+thao|giày\s+chạy\s+bộ|giày\s+da|giày\s+cao\s+gót|\bfootwear\b|\bshoe\s+(?:shop|store)\b/i,
    defaultLabelVi: 'shop giày Sneaker',
    defaultLabelEn: 'sneaker & footwear store',
    industryVi: 'Shop giày Sneaker & Thời trang',
    industryEn: 'Sneaker & Footwear Retail',
    customerScenariosVi: [
      'tư vấn đo chân chọn size chuẩn từng dòng giày (tránh bị kích mũi hay rộng gót)',
      'kiểm tra tình trạng sẵn hàng theo size, cam kết chính hãng (legit/fullbox) và cách vệ sinh bảo quản',
      'hướng dẫn đổi size nhanh chóng nếu mang chưa vừa và phí ship COD toàn quốc',
    ],
    customerScenariosEn: [
      'helping shoppers pick the exact shoe size by foot length and fit profile',
      'checking in-stock sizes, authenticity guarantees, and care tips',
      'explaining hassle-free size exchanges and shipping timelines',
    ],
    seedFaqHintVi:
      'Hướng dẫn đo chiều dài bàn chân để chọn size giày chính xác cho từng form giày; giải đáp tình trạng sẵn size, cam kết hàng chính hãng/bảo hành keo chỉ, phí ship kiểm hàng và chính sách hỗ trợ đổi size nếu chưa vừa.',
    seedFaqHintEn:
      'Guide customers on accurate shoe sizing, stock availability by size, authenticity guarantees, shipping options, and easy size-exchange policies.',
    widgetQuickPromptsVi: [
      'Tư vấn chọn size giày vừa chân',
      'Chính sách hỗ trợ đổi size & bảo hành',
      'Kiểm tra hàng sẵn kho & phí ship',
    ],
    widgetQuickPromptsEn: [
      'Help me find my exact shoe size',
      'Size exchange & warranty policy',
      'Check stock & shipping time',
    ],
    sampleBrandVi: 'Kickz Lab',
    samplePolicyVi: 'cam kết chính hãng 100%, hỗ trợ đổi size trong 7 ngày, freeship đơn từ 1 triệu',
    sampleBrandEn: 'Kickz Lab',
    samplePolicyEn: '100% authentic guarantee, 7-day size exchange, free shipping over $80',
  },
  {
    id: 'yoga_fitness',
    re: /phòng\s+tập\s+yoga|\byoga\b|\bpilates\b|phòng\s+tập\s+gym|phòng\s+gym|\bfitness\b|thể\s+hình|\bboxing\b|clb\s+thể\s+thao|\bpickleball\b|sân\s+cầu\s+lông/i,
    defaultLabelVi: 'phòng tập Yoga / Fitness',
    defaultLabelEn: 'yoga & fitness studio',
    industryVi: 'Phòng tập Yoga & Chăm sóc sức khỏe',
    industryEn: 'Yoga Studio & Fitness',
    customerScenariosVi: [
      'tư vấn lớp học phù hợp cho người mới bắt đầu, trị liệu cổ vai gáy hoặc giữ dáng',
      'báo khung giờ các ca tập trong ngày, học phí theo tháng/quý và ưu đãi buổi tập thử',
      'hướng dẫn đăng ký giữ chỗ, quy định bảo lưu thẻ tập và chuẩn bị thảm/trang phục',
    ],
    customerScenariosEn: [
      'matching beginners or experienced members with the right class level and wellness goals',
      'sharing daily class schedules, membership packages, and trial session offers',
      'explaining booking rules, membership freeze policies, and what to bring',
    ],
    seedFaqHintVi:
      'Tư vấn lộ trình và lớp tập Yoga/Fitness cho người mới bắt đầu hoặc nâng cao; cung cấp lịch tập các khung giờ sáng–trưa–tối, bảng giá thẻ tập & gói buổi tập thử; hướng dẫn đặt lịch trước và chính sách bảo lưu gói tập.',
    seedFaqHintEn:
      'Recommend beginner and advanced classes, share daily schedules, membership plans, trial passes, class booking steps, and membership pause policies.',
    widgetQuickPromptsVi: [
      'Lịch lớp cho người mới bắt đầu',
      'Bảng giá gói tập & đăng ký tập thử',
      'Chính sách đặt lịch & bảo lưu thẻ',
    ],
    widgetQuickPromptsEn: [
      'Beginner class schedule',
      'Membership pricing & trial pass',
      'Booking & membership freeze rules',
    ],
    sampleBrandVi: 'An Nhiên Yoga',
    samplePolicyVi: 'có thảm tập miễn phí tại phòng, tặng 1 buổi tập thử, hỗ trợ bảo lưu thẻ 30 ngày',
    sampleBrandEn: 'Serene Yoga Studio',
    samplePolicyEn: 'free mats provided, complimentary first trial class, 30-day membership freeze',
  },
  {
    id: 'photo_studio',
    re: /studio\s+chụp\s+ảnh|tiệm\s+chụp\s+ảnh|chụp\s+ảnh\s+(?:cưới|kỷ\s+yếu|chân\s+dung|gia\s+đình|sản\s+phẩm|concept)|nhiếp\s+ảnh|\bphoto\s+studio\b|\bphotography\b|ảnh\s+viện|quay\s+dựng/i,
    defaultLabelVi: 'studio chụp ảnh',
    defaultLabelEn: 'photography studio',
    industryVi: 'Studio Chụp ảnh & Media',
    industryEn: 'Photography Studio & Media',
    customerScenariosVi: [
      'tư vấn concept chụp (chân dung, cặp đôi, kỷ yếu, sản phẩm), gói make-up & trang phục đi kèm',
      'báo giá từng gói chụp, kiểm tra lịch trống cuối tuần và quy trình đặt cọc giữ lịch',
      'giải đáp số lượng file ảnh gốc nhận về, số ảnh chỉnh sửa kỹ và thời gian trả ảnh',
    ],
    customerScenariosEn: [
      'exploring shoot concepts, wardrobe/makeup inclusions, and studio backdrops',
      'comparing package pricing, checking weekend availability, and booking deposits',
      'clarifying raw photo delivery, retouched photo counts, and turnaround times',
    ],
    seedFaqHintVi:
      'Tư vấn các concept và gói chụp ảnh (cá nhân, gia đình, kỷ yếu, cưới, lookbook), dịch vụ trang điểm & trang phục hỗ trợ; hướng dẫn kiểm tra lịch trống, mức cọc giữ lịch, chính sách dời lịch khi bận đột xuất và thời gian giao ảnh gốc/ảnh photoshop.',
    seedFaqHintEn:
      'Detail photography packages, styling/makeup inclusions, calendar booking and deposit rules, rescheduling flexibility, and photo delivery timelines.',
    widgetQuickPromptsVi: [
      'Các gói chụp & bảng giá chi tiết',
      'Kiểm tra lịch trống & quy định đặt cọc',
      'Thời gian nhận ảnh gốc & ảnh chỉnh sửa',
    ],
    widgetQuickPromptsEn: [
      'Packages & pricing details',
      'Check availability & booking deposit',
      'Photo editing & delivery timeline',
    ],
    sampleBrandVi: 'Nắng Studio',
    samplePolicyVi: 'cọc 30% giữ lịch, hỗ trợ dời lịch miễn phí báo trước 48h, trả toàn bộ ảnh gốc sau 24h',
    sampleBrandEn: 'Sunbeam Studio',
    samplePolicyEn: '30% booking deposit, free reschedule with 48h notice, raw photos within 24h',
  },
  {
    id: 'language_course',
    re: /khóa\s+học\s+tiếng\s+(?:trung|anh|nhật|hàn|đức|pháp)|dạy\s+tiếng\s+(?:trung|anh|nhật|hàn)|trung\s+tâm\s+(?:tiếng\s+(?:trung|anh|nhật|hàn)|ngoại\s+ngữ|anh\s+ngữ)|\bhsk\b|\bielts\b|\btoeic\b|\bjlpt\b|\btopik\b|\blanguage\s+(?:course|school|academy)\b/i,
    defaultLabelVi: 'khóa học ngoại ngữ',
    defaultLabelEn: 'language course program',
    industryVi: 'Khóa học ngoại ngữ & Đào tạo',
    industryEn: 'Language Courses & Education',
    customerScenariosVi: [
      'kiểm tra trình độ đầu vào và tư vấn lộ trình học từ mất gốc tới giao tiếp/thi chứng chỉ',
      'hỏi lịch khai giảng lớp online/offline, sĩ số lớp, học phí và đăng ký học thử miễn phí',
      'hỗ trợ học viên truy cập tài liệu, video bài giảng xem lại và chính sách học bù/bảo lưu',
    ],
    customerScenariosEn: [
      'assessing current proficiency and recommending beginner-to-certificate learning tracks',
      'sharing upcoming class schedules, tuition fees, class sizes, and free trial lessons',
      'helping students with learning materials, recorded replays, and make-up classes',
    ],
    seedFaqHintVi:
      'Tư vấn lộ trình học ngoại ngữ theo mục tiêu (giao tiếp thực tế, đi làm hoặc luyện thi chứng chỉ HSK/IELTS/TOEIC/JLPT); cung cấp lịch khai giảng, hình thức học, học phí ưu đãi, buổi học thử và chính sách xem lại record/học bù.',
    seedFaqHintEn:
      'Guide learners to the right proficiency track, share class schedules, tuition packages, free placement/trial sessions, and replay/make-up policies.',
    widgetQuickPromptsVi: [
      'Tư vấn lộ trình cho người mới bắt đầu',
      'Lịch khai giảng & ưu đãi học phí',
      'Đăng ký kiểm tra trình độ / học thử',
    ],
    widgetQuickPromptsEn: [
      'Recommended track for beginners',
      'Upcoming schedule & tuition offers',
      'Book a free placement or trial class',
    ],
    sampleBrandVi: 'Hoa Ngữ Minh Tâm',
    samplePolicyVi: 'tặng 1 buổi học thử + test đầu vào miễn phí, lớp tối đa 10 học viên, có video xem lại',
    sampleBrandEn: 'BrightPath Language Academy',
    samplePolicyEn: 'free placement test & trial lesson, max 10 students per class, full lesson replays',
  },
  {
    id: 'accounting_legal',
    re: /dịch\s+vụ\s+kế\s+toán|công\s+ty\s+kế\s+toán|kế\s+toán\s+(?:thuế|trọn\s+gói|doanh\s+nghiệp)|báo\s+cáo\s+thuế|quyết\s+toán\s+thuế|thành\s+lập\s+(?:công\s+ty|doanh\s+nghiệp)|hóa\s+đơn\s+điện\s+tử|chữ\s+ký\s+số|tư\s+vấn\s+pháp\s+lý|văn\s+phòng\s+luật|\baccounting\b|\bbookkeeping\b|\btax\s+(?:service|advisory)\b|\blaw\s+firm\b/i,
    defaultLabelVi: 'dịch vụ kế toán & thuế',
    defaultLabelEn: 'accounting & tax firm',
    industryVi: 'Dịch vụ Kế toán & Tư vấn thuế',
    industryEn: 'Accounting & Tax Advisory',
    customerScenariosVi: [
      'tư vấn gói kế toán thuế trọn gói theo loại hình & số lượng hóa đơn hàng quý của doanh nghiệp/hộ kinh doanh',
      'hướng dẫn hồ sơ thành lập công ty mới, đăng ký chữ ký số, hóa đơn điện tử và bảo hiểm xã hội',
      'tiếp nhận câu hỏi nghiệp vụ phức tạp để đặt lịch trao đổi trực tiếp với chuyên viên/kế toán trưởng',
    ],
    customerScenariosEn: [
      'matching businesses or sole proprietors with monthly/quarterly bookkeeping & tax packages',
      'explaining company registration paperwork, e-invoicing, and payroll compliance',
      'collecting basic company details to schedule a consultation with a senior accountant',
    ],
    seedFaqHintVi:
      'Tư vấn biểu phí dịch vụ kế toán trọn gói, kê khai & quyết toán thuế định kỳ cho doanh nghiệp SME và hộ kinh doanh; hướng dẫn thủ tục thành lập doanh nghiệp, hóa đơn điện tử; cam kết bảo mật chứng từ và kết nối chuyên viên kế toán trưởng khi cần rà soát sổ sách.',
    seedFaqHintEn:
      'Explain monthly/quarterly accounting & tax filing packages, business registration workflows, confidentiality standards, and direct escalation to certified accountants.',
    widgetQuickPromptsVi: [
      'Báo giá kế toán thuế trọn gói theo quý',
      'Thủ tục thành lập công ty / hộ kinh doanh',
      'Đặt lịch tư vấn với kế toán trưởng',
    ],
    widgetQuickPromptsEn: [
      'Monthly/quarterly accounting pricing',
      'New company registration checklist',
      'Book a call with a senior accountant',
    ],
    sampleBrandVi: 'Kế Toán Tín Việt',
    samplePolicyVi: 'bảo mật số liệu 100%, tư vấn ban đầu miễn phí, hỗ trợ trọn gói từ hộ kinh doanh tới SME',
    sampleBrandEn: 'TrustLedger Accounting',
    samplePolicyEn: 'strict data confidentiality, free initial consultation, full SME & tax filing support',
  },
  {
    id: 'beauty_skincare',
    re: /mỹ\s+phẩm|\bskincare\b|chăm\s+sóc\s+da|son\s+môi|nước\s+hoa|\bcosmetic(?:s)?\b|\bbeauty\s+(?:shop|store|brand)\b|dược\s+mỹ\s+phẩm/i,
    defaultLabelVi: 'shop mỹ phẩm & skincare',
    defaultLabelEn: 'skincare & beauty shop',
    industryVi: 'Mỹ phẩm & Chăm sóc sắc đẹp',
    industryEn: 'Beauty & Skincare Retail',
    customerScenariosVi: [
      'tư vấn chu trình skincare lành tính theo từng tình trạng da (da dầu mụn, da khô, da nhạy cảm)',
      'giải đáp bảng thành phần, hạn sử dụng, nguồn gốc chính hãng và ưu đãi combo',
      'hướng dẫn phí vận chuyển và chính sách đổi trả khi sản phẩm lỗi hoặc kích ứng',
    ],
    customerScenariosEn: [
      'recommending gentle skincare routines tailored to oily, dry, or sensitive skin',
      'answering ingredient, authenticity, and bundle-promotion questions',
      'clarifying shipping timelines and return/damaged-item policies',
    ],
    seedFaqHintVi:
      'Tư vấn chọn sản phẩm chăm sóc da/mỹ phẩm phù hợp loại da, cung cấp thông tin thành phần & cam kết chính hãng, hướng dẫn phí giao hàng và quy định đổi trả.',
    seedFaqHintEn:
      'Help customers select skincare/beauty products by skin type, verify ingredients and authenticity, and explain shipping and return policies.',
    widgetQuickPromptsVi: [
      'Tư vấn sản phẩm hợp loại da của mình',
      'Kiểm tra thành phần & hàng chính hãng',
      'Chính sách freeship & đổi trả',
    ],
    widgetQuickPromptsEn: [
      'Routine advice for my skin type',
      'Ingredients & authenticity info',
      'Shipping & return policy',
    ],
    sampleBrandVi: 'GlowSkin',
    samplePolicyVi: 'cam kết chính hãng, đổi trả 7 ngày, freeship đơn từ 300k',
    sampleBrandEn: 'GlowSkin',
    samplePolicyEn: '100% authentic, 7-day returns, free shipping over $35',
  },
  {
    id: 'fashion_apparel',
    re: /thời\s+trang|shop\s+(?:quần\s+áo|đồ|váy|đầm|áo)|local\s+brand|\bstreetwear\b|áo\s+thun|áo\s+khoác|đồng\s+phục|\bfashion\b|\bapparel\b|\bboutique\b/i,
    defaultLabelVi: 'shop thời trang',
    defaultLabelEn: 'fashion & apparel store',
    industryVi: 'Thời trang & May mặc',
    industryEn: 'Fashion & Apparel',
    customerScenariosVi: [
      'tư vấn bảng size theo chiều cao cân nặng và chất liệu vải thực tế',
      'gợi ý phối đồ theo dịp đi làm/đi chơi và kiểm tra màu/size còn sẵn',
      'hướng dẫn phí ship kiểm hàng và chính sách hỗ trợ đổi size tận nhà',
    ],
    customerScenariosEn: [
      'advising on garment sizing by height/weight and fabric details',
      'suggesting outfit pairings and checking color/size stock',
      'explaining delivery options and easy size exchanges',
    ],
    seedFaqHintVi:
      'Tư vấn chọn size trang phục theo chiều cao & cân nặng, mô tả chất liệu & cách giặt bảo quản, thông báo tình trạng còn hàng và chính sách đổi size/đổi mẫu.',
    seedFaqHintEn:
      'Guide shoppers on sizing charts, fabric care, stock availability, shipping, and size exchange policies.',
    widgetQuickPromptsVi: [
      'Tư vấn chọn size theo chiều cao cân nặng',
      'Kiểm tra mẫu còn hàng & chất vải',
      'Chính sách đổi size & giao hàng',
    ],
    widgetQuickPromptsEn: [
      'Find my size by height & weight',
      'Fabric details & stock check',
      'Exchange & delivery policy',
    ],
    sampleBrandVi: 'Linen Studio',
    samplePolicyVi: 'đổi size trong 7 ngày còn nguyên tag, được kiểm hàng trước khi thanh toán',
    sampleBrandEn: 'Linen Studio',
    samplePolicyEn: '7-day size exchange with tags attached, express nationwide delivery',
  },
  {
    id: 'electronics_gaming',
    re: /\blaptop\b|máy\s+tính|build\s+pc|bàn\s+phím\s+cơ|\bmechanical\s+keyboard\b|\bgaming\s+gear\b|tai\s+nghe|phụ\s+kiện\s+(?:công\s+nghệ|điện\s+thoại)|cửa\s+hàng\s+điện\s+thoại|điện\s+máy|\bps5\b|\bnintendo\b/i,
    defaultLabelVi: 'shop công nghệ / phụ kiện',
    defaultLabelEn: 'tech & gear store',
    industryVi: 'Thiết bị Công nghệ & Gaming Gear',
    industryEn: 'Electronics & Gaming Gear',
    customerScenariosVi: [
      'tư vấn cấu hình/thông số kỹ thuật và độ tương thích theo nhu cầu làm việc hay chơi game',
      'so sánh các phiên bản sản phẩm, tình trạng sẵn hàng và ưu đãi trả góp/quà tặng',
      'giải đáp thời hạn bảo hành chính hãng, lỗi 1 đổi 1 và hỗ trợ kỹ thuật sau mua',
    ],
    customerScenariosEn: [
      'recommending specs and compatibility for work setups or gaming rigs',
      'comparing models, stock availability, and bundle promotions',
      'explaining warranty coverage, DOA replacement, and technical support',
    ],
    seedFaqHintVi:
      'Tư vấn thông số kỹ thuật, khả năng tương thích thiết bị, chính sách bảo hành chính hãng, đổi mới khi lỗi phần cứng và hỗ trợ cài đặt/kỹ thuật.',
    seedFaqHintEn:
      'Assist with product specs, device compatibility, warranty terms, hardware replacement policies, and technical troubleshooting.',
    widgetQuickPromptsVi: [
      'Tư vấn chọn mẫu hợp nhu cầu & ngân sách',
      'Chính sách bảo hành & 1 đổi 1',
      'Hỗ trợ kỹ thuật / hướng dẫn sử dụng',
    ],
    widgetQuickPromptsEn: [
      'Recommend gear for my setup & budget',
      'Warranty & replacement coverage',
      'Technical setup support',
    ],
    sampleBrandVi: 'GearZone',
    samplePolicyVi: 'bảo hành chính hãng 12–24 tháng, lỗi 1 đổi 1 trong 15 ngày đầu',
    sampleBrandEn: 'GearZone',
    samplePolicyEn: '12-month official warranty, 15-day hardware replacement',
  },
  {
    id: 'healthcare_clinic',
    re: /phòng\s+khám|nha\s+khoa|y\s+tế|nhà\s+thuốc|\bspa\b|thẩm\s+mỹ|trị\s+liệu|\bclinic\b|\bdental\b|\bhealthcare\b|\bwellness\b/i,
    defaultLabelVi: 'phòng khám / chăm sóc sức khỏe',
    defaultLabelEn: 'clinic & wellness center',
    industryVi: 'Y tế, Nha khoa & Chăm sóc sức khỏe',
    industryEn: 'Healthcare, Dental & Wellness',
    customerScenariosVi: [
      'tư vấn danh mục dịch vụ khám/chăm sóc, quy trình thực hiện và bảng giá niêm yết minh bạch',
      'hướng dẫn đặt lịch hẹn trước để không phải chờ đợi lâu và lưu ý chuẩn bị trước buổi hẹn',
      'tự động che thông tin cá nhân nhạy cảm và chuyển tiếp bác sĩ/chuyên viên khi khách cần tư vấn chuyên sâu',
    ],
    customerScenariosEn: [
      'explaining service packages, procedures, and transparent pricing',
      'helping patients book appointments seamlessly and prepare for visits',
      'protecting patient privacy while escalating clinical questions to specialists',
    ],
    seedFaqHintVi:
      'Cung cấp thông tin dịch vụ, bảng giá tham khảo, giờ làm việc và hướng dẫn đặt lịch hẹn; tuyệt đối không chẩn đoán kê đơn thay bác sĩ và chủ động chuyển chuyên viên y tế khi khách có triệu chứng cần thăm khám trực tiếp.',
    seedFaqHintEn:
      'Share clinic services, hours, pricing ranges, and appointment booking steps; never provide medical diagnoses and escalate clinical concerns to licensed staff.',
    widgetQuickPromptsVi: [
      'Bảng giá dịch vụ & quy trình thăm khám',
      'Đặt lịch hẹn trước không cần chờ',
      'Giờ làm việc & địa chỉ phòng khám',
    ],
    widgetQuickPromptsEn: [
      'Services & transparent pricing',
      'Book an appointment',
      'Clinic hours & location',
    ],
    sampleBrandVi: 'Nha Khoa Tâm Đức',
    samplePolicyVi: 'khám & tư vấn ban đầu miễn phí, làm việc 8h–20h cả cuối tuần, bảo hành dịch vụ rõ ràng',
    sampleBrandEn: 'CarePlus Clinic',
    samplePolicyEn: 'free initial checkup consultation, open 8am–8pm daily, appointment priority booking',
  },
  {
    id: 'travel_hospitality',
    re: /du\s+lịch|khách\s+sạn|\bhomestay\b|\bresort\b|\bvilla\b|đặt\s+phòng|\bbooking\b|\btravel\b|\bhotel\b|\bhospitality\b|\btour\b/i,
    defaultLabelVi: 'dịch vụ lưu trú / du lịch',
    defaultLabelEn: 'travel & hospitality business',
    industryVi: 'Du lịch & Lưu trú',
    industryEn: 'Travel & Hospitality',
    customerScenariosVi: [
      'kiểm tra hạng phòng/lịch tour còn trống, tiện ích đi kèm và giá cuối tuần/lễ',
      'giải đáp giờ check-in/check-out, quy định mang thú cưng, phụ thu trẻ em và xe đưa đón',
      'hướng dẫn đặt cọc giữ phòng và chính sách hoàn/đổi lịch linh hoạt',
    ],
    customerScenariosEn: [
      'checking room/tour availability, amenities, and seasonal rates',
      'answering check-in/out times, family/pet policies, and airport transfers',
      'explaining booking deposits and cancellation/rescheduling rules',
    ],
    seedFaqHintVi:
      'Tư vấn các hạng phòng/lịch trình tour, tiện ích, giờ nhận–trả phòng (check-in/check-out), chính sách phụ thu và quy định đặt cọc/dời lịch.',
    seedFaqHintEn:
      'Assist guests with room types, tour itineraries, check-in/out schedules, amenities, deposit rules, and rescheduling policies.',
    widgetQuickPromptsVi: [
      'Xem hạng phòng / lịch trình & giá',
      'Giờ check-in, check-out & tiện ích',
      'Chính sách đặt cọc & hoàn đổi lịch',
    ],
    widgetQuickPromptsEn: [
      'Room types, tours & rates',
      'Check-in/out & amenities',
      'Deposit & cancellation policy',
    ],
    sampleBrandVi: 'Mây Homestay Đà Lạt',
    samplePolicyVi: 'check-in 14h – check-out 12h, miễn phí ăn sáng, hỗ trợ dời lịch báo trước 5 ngày',
    sampleBrandEn: 'CloudView Homestay',
    samplePolicyEn: 'check-in 2pm / check-out 12pm, complimentary breakfast, free reschedule 5 days prior',
  },
  {
    id: 'pet_care',
    re: /thú\s+cưng|\bpet\s+(?:shop|store|spa|hotel)\b|chó\s+mèo|thức\s+ăn\s+(?:chó|mèo)|cát\s+mèo|thú\s+y|\bgrooming\b/i,
    defaultLabelVi: 'shop / spa thú cưng',
    defaultLabelEn: 'pet shop & grooming care',
    industryVi: 'Thú cưng & Pet Shop',
    industryEn: 'Pet Care & Supplies',
    customerScenariosVi: [
      'tư vấn hạt dinh dưỡng, pate, cát vệ sinh và phụ kiện hợp độ tuổi/giống chó mèo',
      'báo giá combo tắm sấy, cắt tỉa lông (grooming) hoặc khách sạn thú cưng và đặt lịch trước',
      'hướng dẫn giao hàng hỏa tốc nội thành và đổi trả sản phẩm còn nguyên niêm phong',
    ],
    customerScenariosEn: [
      'recommending food, litter, and accessories by pet breed and age',
      'sharing grooming/boarding rates and booking spa time slots',
      'explaining express local delivery and unopened-item exchanges',
    ],
    seedFaqHintVi:
      'Tư vấn thức ăn & phụ kiện theo độ tuổi/cân nặng thú cưng, bảng giá dịch vụ spa cắt tỉa & trông giữ thú cưng, đặt lịch hẹn và giao hàng nhanh.',
    seedFaqHintEn:
      'Recommend pet nutrition and accessories by age/weight, share grooming and boarding packages, and handle express delivery inquiries.',
    widgetQuickPromptsVi: [
      'Tư vấn thức ăn & phụ kiện cho bé',
      'Bảng giá tắm cắt tỉa & đặt lịch spa',
      'Giao hàng hỏa tốc nội thành',
    ],
    widgetQuickPromptsEn: [
      'Food & supply recommendations',
      'Grooming packages & booking',
      'Same-day local delivery info',
    ],
    sampleBrandVi: 'Paws & Meow',
    samplePolicyVi: 'ship hỏa tốc 1h nội thành, nhận đặt lịch spa cho bé từ 9h–20h',
    sampleBrandEn: 'Paws & Meow',
    samplePolicyEn: '1-hour express local delivery, grooming appointments 9am–8pm daily',
  },
  {
    id: 'education_training',
    re: /giáo\s+dục|khóa\s+học|học\s+viện|trung\s+tâm\s+đào\s+tạo|luyện\s+thi|gia\s+sư|\beducation\b|\bedtech\b|\btraining\b|\bbootcamp\b|\bonline\s+course(?:s)?\b/i,
    defaultLabelVi: 'khóa học / trung tâm đào tạo',
    defaultLabelEn: 'education & training program',
    industryVi: 'Giáo dục & Đào tạo',
    industryEn: 'Education & Training',
    customerScenariosVi: [
      'tư vấn khóa học phù hợp mục tiêu đầu ra và kinh nghiệm hiện tại của học viên',
      'cung cấp lịch khai giảng, học phí ưu đãi đăng ký sớm và đề cương bài học',
      'hỗ trợ kích hoạt tài khoản học tập, tài liệu và chính sách bảo lưu/hỗ trợ sau khóa học',
    ],
    customerScenariosEn: [
      'matching prospective learners with the right course track and prerequisites',
      'sharing syllabus details, cohort schedules, and tuition bundles',
      'assisting with course access, study materials, and deferral policies',
    ],
    seedFaqHintVi:
      'Tư vấn nội dung chương trình học, đối tượng phù hợp, lịch khai giảng, học phí và chính sách hỗ trợ học viên trong suốt khóa học.',
    seedFaqHintEn:
      'Guide students through course curricula, schedules, tuition plans, enrollment steps, and learner support policies.',
    widgetQuickPromptsVi: [
      'Tư vấn khóa học phù hợp với mình',
      'Xem đề cương & ưu đãi học phí',
      'Hỗ trợ tài khoản học viên',
    ],
    widgetQuickPromptsEn: [
      'Help me pick the right course',
      'Curriculum & tuition details',
      'Student account assistance',
    ],
    sampleBrandVi: 'SkillUp Academy',
    samplePolicyVi: 'học thử miễn phí bài đầu, hỗ trợ giải đáp bài tập 1-1, truy cập bài giảng trọn đời',
    sampleBrandEn: 'SkillUp Academy',
    samplePolicyEn: 'free preview lesson, 1-on-1 mentor Q&A, lifetime course access',
  },
  {
    id: 'fintech_finance',
    re: /tài\s+chính|ngân\s+hàng|\bfintech\b|bảo\s+hiểm|chứng\s+khoán|\bfinance\b|\bbanking\b|\binsurance\b/i,
    defaultLabelVi: 'dịch vụ tài chính / FinTech',
    defaultLabelEn: 'financial services platform',
    industryVi: 'Tài chính & Dịch vụ số',
    industryEn: 'Financial Services & FinTech',
    customerScenariosVi: [
      'giải đáp biểu phí, hạn mức giao dịch và điều kiện mở tài khoản/gói dịch vụ minh bạch',
      'hướng dẫn xác thực bảo mật, xử lý giao dịch treo và tự động che số thẻ/thông tin nhạy cảm',
      'chuyển tiếp khẩn cấp cho bộ phận chuyên trách khi khách báo sự cố thanh toán hoặc nghi ngờ gian lận',
    ],
    customerScenariosEn: [
      'explaining fee schedules, limits, and account eligibility clearly',
      'guiding verification steps while masking sensitive card/account numbers automatically',
      'escalating urgent payment disputes or security incidents to human specialists',
    ],
    seedFaqHintVi:
      'Giải đáp minh bạch biểu phí, hạn mức, quy trình xác thực và an toàn giao dịch; tự động che dữ liệu nhạy cảm (số thẻ, SĐT, email) và chuyển ngay cho chuyên viên khi có khiếu nại giao dịch.',
    seedFaqHintEn:
      'Provide accurate fee, limit, and verification guidance; mask PII/card details automatically and escalate transaction disputes immediately.',
    widgetQuickPromptsVi: [
      'Biểu phí & hạn mức giao dịch',
      'Hướng dẫn xác thực tài khoản',
      'Hỗ trợ khẩn cấp về giao dịch',
    ],
    widgetQuickPromptsEn: [
      'Fees & transaction limits',
      'Account verification guide',
      'Urgent payment assistance',
    ],
    sampleBrandVi: 'FinSafe',
    samplePolicyVi: 'hỗ trợ sự cố giao dịch 24/7, tuyệt đối không yêu cầu khách cung cấp mã OTP hay mật khẩu',
    sampleBrandEn: 'FinSafe',
    samplePolicyEn: '24/7 incident escalation, never ask customers for OTPs or passwords',
  },
  {
    id: 'saas_tech',
    re: /\bsaas\b|phần\s+mềm|\bsoftware\b|nền\s+tảng\s+(?:số|quản\s+lý|ai|cloud)|\bcloud\b|\bhosting\b|công\s+nghệ\s+thông\s+tin|\btech\s+platform\b|\bapi\s+platform\b/i,
    defaultLabelVi: 'nền tảng phần mềm / SaaS',
    defaultLabelEn: 'SaaS & software platform',
    industryVi: 'Phần mềm SaaS & Công nghệ',
    industryEn: 'SaaS & Technology',
    customerScenariosVi: [
      'hướng dẫn bắt đầu nhanh (onboarding), tích hợp hệ thống và giải thích tính năng theo gói cước',
      'hỗ trợ xử lý lỗi đăng nhập, cấu hình API/webhook và câu hỏi thanh toán gia hạn',
      'tạo ticket kỹ thuật ưu tiên kèm ngữ cảnh khi khách gặp sự cố vận hành',
    ],
    customerScenariosEn: [
      'guiding new users through onboarding, integrations, and plan comparisons',
      'troubleshooting login, API/webhook setup, and subscription billing questions',
      'routing technical incidents to engineering support with clear priority SLAs',
    ],
    seedFaqHintVi:
      'Hỗ trợ người dùng khởi tạo tài khoản, so sánh các gói dịch vụ, hướng dẫn cấu hình/tích hợp kỹ thuật và chuyển tiếp ticket cho đội ngũ kỹ thuật hoặc thanh toán.',
    seedFaqHintEn:
      'Support user onboarding, plan comparisons, integration guides, billing questions, and prioritized technical ticket escalation.',
    widgetQuickPromptsVi: [
      'Hướng dẫn bắt đầu nhanh (Onboarding)',
      'So sánh tính năng các gói cước',
      'Báo lỗi kỹ thuật / Hỗ trợ tích hợp',
    ],
    widgetQuickPromptsEn: [
      'Quickstart & onboarding guide',
      'Compare subscription plans',
      'Technical issue / API help',
    ],
    sampleBrandVi: 'CloudFlow',
    samplePolicyVi: 'dùng thử miễn phí 14 ngày, hỗ trợ kỹ thuật 24/7, cam kết SLA phản hồi sự cố trong 15 phút',
    sampleBrandEn: 'CloudFlow',
    samplePolicyEn: '14-day free trial, 24/7 technical support, 15-minute urgent SLA response',
  },
  {
    id: 'ecommerce_retail',
    re: /bán\s+hàng\s+online|thương\s+mại\s+điện\s+tử|\be-?commerce\b|\bonline\s+(?:shop|store)\b|bán\s+lẻ|\bretail\b|cửa\s+hàng\s+tạp\s+hóa|siêu\s+thị\s+mini/i,
    defaultLabelVi: 'cửa hàng bán lẻ / online',
    defaultLabelEn: 'online retail store',
    industryVi: 'Thương mại điện tử & Bán lẻ',
    industryEn: 'E-commerce & Retail',
    customerScenariosVi: [
      'tư vấn thông tin sản phẩm, chương trình khuyến mãi đang áp dụng và kiểm tra hàng còn sẵn',
      'giải đáp phí giao hàng dự kiến, hình thức thanh toán COD/chuyển khoản',
      'hướng dẫn quy trình đổi trả/bảo hành và kết nối nhân viên khi khách cần tra cứu đơn riêng',
    ],
    customerScenariosEn: [
      'answering product details, active promotions, and stock availability',
      'explaining shipping rates, delivery windows, and payment options',
      'guiding returns/exchanges and connecting shoppers to order support',
    ],
    seedFaqHintVi:
      'Tư vấn sản phẩm, ưu đãi hiện hành, thời gian & phí giao hàng, hình thức thanh toán và chính sách đổi trả hàng hóa minh bạch.',
    seedFaqHintEn:
      'Provide clear product details, shipping fees and timelines, payment methods, and return/exchange instructions.',
    widgetQuickPromptsVi: [
      'Tư vấn sản phẩm & ưu đãi hiện có',
      'Phí giao hàng & thời gian nhận',
      'Chính sách đổi trả & bảo hành',
    ],
    widgetQuickPromptsEn: [
      'Product details & current offers',
      'Shipping fees & delivery time',
      'Returns & warranty policy',
    ],
    sampleBrandVi: 'Việt Mart Online',
    samplePolicyVi: 'đổi trả miễn phí 7 ngày nếu lỗi, freeship đơn từ 299k, giao nội thành trong ngày',
    sampleBrandEn: 'PrimeCart Shop',
    samplePolicyEn: '7-day hassle-free returns, free shipping over $40, same-day metro dispatch',
  },
];

const GENERIC_NON_DOMAIN_PHRASE_RE =
  /^(?:của\s+(?:tôi|mình|em|anh|chị|chúng\s+tôi|chúng\s+mình|bạn)|cho\s+(?:tôi|mình|em|doanh\s+nghiệp|shop|công\s+ty)|hiện\s+tại|mới|này|đó|kia|đâu|nào|gì|sao|thế\s+nào|một\s+con\s+ai|1\s+con\s+ai|con\s+ai|ai\s+support|support\s+ai|chatbot|bot|trợ\s+lý(?:\s+ai)?|tenant(?:\s+hiện\s+tại|\s+mới|\s+tên.*)?|tiêu\s+chuẩn|mặc\s+định|tự\s+động|trọn\s+gói|hoàn\s+chỉnh|my\s+(?:own|current|new)?\s*(?:business|shop|store|company|website|site|tenant|ai|assistant|bot)?|a\s+(?:new\s+|brand-?new\s+)?(?:tenant|ai\s+support|chatbot|support\s+assistant|setup)|current\s+tenant|standard\s+defaults|for\s+me|right\s+now|yet)$/i;

const META_OR_PUSHBACK_TURN_RE =
  /^(?:bạn\s+có\s+thể\s+(?:làm|nói|giúp)|ban\s+co\s+the\s+(?:lam|noi|giup)|bạn\s+làm\s+được|ban\s+lam\s+duoc|mày\s+biết\s+làm|may\s+biet\s+lam|em\s+giúp\s+được|em\s+giup\s+duoc|sao\s+(?:trả\s+lời\s+|tra\s+loi\s+)?(?:cứng\s+nhắc|cung\s+nhac)|hỏi\s+nhiều\s+quá|hoi\s+nhieu\s+qua|nói\s+chuyện\s+như\s+máy|noi\s+chuyen\s+nhu\s+may|đừng\s+lặp\s+lại|dung\s+lap\s+lai|tư\s+vấn\s+(?:cho\s+mình|giúp\s+mình)|tu\s+van\s+(?:cho\s+minh|giup\s+minh)|tôi\s+chưa\s+biết\s+bắt\s+đầu|toi\s+chua\s+biet\s+bat\s+dau|chưa\s+có\s+website|chua\s+co\s+web|không\s+có\s+website|khong\s+co\s+web|xin\s+chào|xin\s+chao|chào\s+bạn|chao\s+ban|cảm\s+ơn|cam\s+on|ok\b|ừ\b|được\s+đó|duoc\s+do|làm\s+đi|lam\s+di|triển\s+luôn|trien\s+luon|lên\s+(?:luôn\s+)?(?:kế\s+hoạch|bản\s+mẫu|bản\s+nháp)|len\s+(?:luon\s+)?(?:ke\s+hoach|ban\s+mau|ban\s+nhap)|what\s+can\s+you|who\s+are\s+you|why\s+are\s+you\s+so|how\s+do\s+i|explain\s+step)/i;

function capitalizeFirst(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

function cleanExtractedTopicPhrase(raw: string): string {
  return raw
    .replace(
      /\s*(?:,|;|\b(?:và|va)\s+(?:muốn|muon|cần|can|đang\s+muốn|dang\s+muon|nhờ|nho|tư\s+vấn|tu\s+van|setup|thiết\s+lập|thiet\s+lap|cài\s+đặt|cai\s+dat|làm\s+chatbot|làm\s+ai|tạo\s+ai)|\b(?:đang|dang)\s+(?:muốn|muon)\s+(?:setup|thiết\s+lập|thiet\s+lap|cài\s+đặt|cai\s+dat|làm|lam|tạo|tao)|\b(?:muốn|muon)\s+(?:setup|thiết\s+lập|thiet\s+lap|cài\s+đặt|cai\s+dat|tích\s+hợp|nhúng|làm\s+ai|làm\s+bot|tạo\s+bot|tạo\s+ai|nhờ)|\b(?:cần|can)\s+(?:setup|thiết\s+lập|thiet\s+lap|cài\s+đặt|cai\s+dat|tư\s+vấn|tu\s+van|làm\s+bot|hỗ\s+trợ)|\b(?:để|de)\s+(?:setup|hỗ\s+trợ|ho\s+tro|tư\s+vấn|tu\s+van|trả\s+lời\s+khách)|\bnhờ\s+(?:bạn|mình|ad|em|ai)|\bgiúp\s+(?:tôi|mình|em)\b|\bgiup\s+(?:toi|minh|em)\b|\bmột\s+con\s+ai\b|\b1\s+con\s+ai\b|\bcon\s+ai\s+support\b|\bmàu\s+(?:chủ\s+đạo|#|[a-zà-ỹ]+)|\bgiọng\s+(?:điệu\s+)?(?:thân\s+thiện|chuyên\s+nghiệp|kỹ\s+thuật|đồng\s+cảm)|\bwebsite\s+https?:\/\/|\bđổi\s+trả\s+\d+|\bfreeship\b|\band\s+(?:i\s+)?(?:want|need|would\s+like)\s+to\b|\bto\s+set\s+up\b|\bfor\s+my\s+customers\b).*$/i,
      '',
    )
    .replace(/\s+(?:ở|tại)\s+[A-ZÀ-Ỹ][\wÀ-ỹ\s]{1,25}$/u, '')
    .replace(/^["'`«“]+|["'`»”.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function refineConversationalChannelLabelVi(
  text: string,
  fallbackLabelVi: string,
): string {
  const channelMatch =
    /\b((?:web(?:site)?|trang\s+web|shop|cửa\s+hàng|tiệm|quán|phòng\s+tập|phòng\s+khám|trung\s+tâm|studio|xưởng|dịch\s+vụ|cộng\s+đồng|kênh|app|ứng\s+dụng)\s+[^\n,.;!?]{2,36})/i.exec(
      text,
    );
  if (channelMatch?.[1]) {
    const cleaned = cleanExtractedTopicPhrase(channelMatch[1]);
    const strippedChannelOnly = cleaned
      .replace(
        /^(?:web(?:site)?|trang\s+web|shop|cửa\s+hàng|tiệm|quán|phòng\s+tập|phòng\s+khám|trung\s+tâm|studio|xưởng|dịch\s+vụ|cộng\s+đồng|kênh|app|ứng\s+dụng)\s+/i,
        '',
      )
      .trim();
    if (
      cleaned.length >= 4 &&
      cleaned.length <= 42 &&
      strippedChannelOnly.length >= 2 &&
      !GENERIC_NON_DOMAIN_PHRASE_RE.test(strippedChannelOnly)
    ) {
      return cleaned;
    }
  }
  return fallbackLabelVi;
}

function buildCuratedTopicInsight(
  profile: CuratedDomainProfile,
  sourceText: string,
): OpenDomainTopicInsight {
  const shortLabelVi = refineConversationalChannelLabelVi(sourceText, profile.defaultLabelVi);
  return {
    rawTopic: shortLabelVi,
    shortLabelVi,
    shortLabelEn: profile.defaultLabelEn,
    industryVi: profile.industryVi,
    industryEn: profile.industryEn,
    customerScenariosVi: [...profile.customerScenariosVi],
    customerScenariosEn: [...profile.customerScenariosEn],
    seedFaqHintVi: profile.seedFaqHintVi,
    seedFaqHintEn: profile.seedFaqHintEn,
    widgetQuickPromptsVi: [...profile.widgetQuickPromptsVi],
    widgetQuickPromptsEn: [...profile.widgetQuickPromptsEn],
    draftChipVi: `Lên luôn bản mẫu cho ${profile.defaultLabelVi} để mình xem`,
    draftChipEn: `Draft a starter plan for my ${profile.defaultLabelEn} now`,
    detailExampleChipVi: `Tên là ${profile.sampleBrandVi}, ${profile.samplePolicyVi}`,
    detailExampleChipEn: `Brand is ${profile.sampleBrandEn}, ${profile.samplePolicyEn}`,
    source: 'curated_domain',
  };
}

function buildOpenPhraseInsight(
  channelNoun: string,
  coreTopic: string,
  isEnglishPhrase: boolean,
): OpenDomainTopicInsight {
  const fullPhrase = channelNoun ? `${channelNoun} ${coreTopic}`.replace(/\s+/g, ' ').trim() : coreTopic.trim();
  const displayVi = isEnglishPhrase ? coreTopic.trim() : fullPhrase;
  const displayEn = isEnglishPhrase ? fullPhrase : coreTopic.trim();

  const lowerChannel = channelNoun.toLowerCase();
  const isServiceArchetype =
    /dịch\s+vụ|tư\s+vấn|sửa\s+chữa|lắp\s+đặt|vệ\s+sinh|thiết\s+kế|thi\s+công|cho\s+thuê|service|agency|consulting|installation|repair|rental/i.test(
      fullPhrase,
    );
  const isCommunityOrMedia =
    /cộng\s+đồng|diễn\s+đàn|nhóm|clb|câu\s+lạc\s+bộ|kênh|blog|tạp\s+chí|tin\s+tức|community|forum|club|portal|media/i.test(
      lowerChannel || fullPhrase,
    );

  const scenariosVi = isServiceArchetype
    ? [
        `tư vấn chi tiết các gói ${displayVi}, quy trình thực hiện và báo giá tham khảo theo nhu cầu khách`,
        'kiểm tra lịch trống, khu vực phục vụ và hướng dẫn đặt lịch hẹn nhanh chóng',
        'giải đáp chính sách bảo hành/cam kết chất lượng và chuyển nhân viên khi khách cần báo giá riêng',
      ]
    : isCommunityOrMedia
      ? [
          `giải đáp nhanh các câu hỏi thường gặp của thành viên mới khi tham gia ${displayVi}`,
          'hướng dẫn nội quy, cách tìm kiếm tài liệu/bài viết và quyền lợi thành viên',
          'tiếp nhận góp ý hoặc hỗ trợ sự cố tài khoản để chuyển ban quản trị xử lý kịp thời',
        ]
      : [
          `tư vấn chọn mẫu mã, đặc điểm và mức giá phù hợp nhất khi khách tìm hiểu tại ${displayVi}`,
          'kiểm tra tình trạng sẵn hàng, cách sử dụng/bảo quản thực tế',
          'giải đáp phí vận chuyển, thời gian giao nhận và chính sách đổi trả minh bạch',
        ];

  const scenariosEn = isServiceArchetype
    ? [
        `explaining ${displayEn} packages, service scope, and transparent pricing`,
        'checking schedule availability, service coverage areas, and booking steps',
        'answering warranty/quality guarantees and escalating custom quote requests to your team',
      ]
    : isCommunityOrMedia
      ? [
          `answering common onboarding questions from members visiting ${displayEn}`,
          'guiding visitors to resources, community guidelines, and membership perks',
          'routing account issues or moderation requests to your team cleanly',
        ]
      : [
          `helping customers pick the right items, specs, and options from your ${displayEn}`,
          'answering stock availability, usage tips, and care instructions',
          'clarifying shipping fees, delivery timelines, and return/exchange policies',
        ];

  const industryVi = capitalizeFirst(displayVi).slice(0, 80);
  const industryEn = capitalizeFirst(displayEn).slice(0, 80);

  return {
    rawTopic: fullPhrase,
    shortLabelVi: displayVi,
    shortLabelEn: displayEn,
    industryVi,
    industryEn,
    customerScenariosVi: scenariosVi,
    customerScenariosEn: scenariosEn,
    seedFaqHintVi: `Tư vấn tận tình về ${displayVi}: giới thiệu sản phẩm/dịch vụ chủ lực, bảng giá niêm yết, thời gian phục vụ/vận chuyển, chính sách bảo hành đổi trả và kết nối nhân viên hỗ trợ khi khách có yêu cầu đặc thù.`,
    seedFaqHintEn: `Provide helpful guidance for ${displayEn}: highlight core offerings, transparent pricing, fulfillment/service hours, return or warranty rules, and seamless human escalation for custom requests.`,
    widgetQuickPromptsVi: [
      `Tư vấn về ${coreTopic.slice(0, 48)}`,
      'Bảng giá & ưu đãi hiện tại',
      'Chính sách vận chuyển / hỗ trợ',
    ],
    widgetQuickPromptsEn: [
      `Help me choose (${coreTopic.slice(0, 42)})`,
      'Pricing & current offers',
      'Delivery & support policy',
    ],
    draftChipVi: `Lên luôn bản mẫu cho ${displayVi.slice(0, 42)} để mình xem`,
    draftChipEn: `Draft a starter plan for my ${displayEn.slice(0, 42)} now`,
    detailExampleChipVi: 'Tên thương hiệu là ..., hỗ trợ đổi trả 7 ngày, giọng thân thiện',
    detailExampleChipEn: 'Brand name is ..., 7-day returns, friendly tone',
    source: 'open_phrase',
  };
}

/**
 * Extracts ANY business, website, shop, product, service, or community topic from natural
 * Vietnamese or English speech — never restricted to 6 hardcoded regex buckets.
 */
export function extractOpenDomainTopic(
  text: string,
  _locale: 'vi' | 'en' = 'vi',
): OpenDomainTopicInsight | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Never treat questions about this platform/website or current screen as a customer business domain
  if (matchPlatformKnowledgeQuestion(trimmed)) {
    return null;
  }

  // 1. Check curated rich domain profiles first (covers boardgame, cafe, sneaker, yoga, studio, Chinese course, accounting, etc.)
  for (const profile of CURATED_DOMAINS) {
    if (profile.re.test(trimmed)) {
      return buildCuratedTopicInsight(profile, trimmed);
    }
  }

  // Guard: skip pure meta/capability/frustration/affirmation turns
  if (META_OR_PUSHBACK_TURN_RE.test(trimmed)) {
    return null;
  }

  // Guard: skip explicit "create tenant named X" admin commands without a real business domain
  if (
    /^(?:tạo\s+mới|create\s+(?:a\s+)?(?:new|brand-?new))\s+(?:\d+\s+)?(?:support\s+)?tenant\b/i.test(
      trimmed,
    )
  ) {
    return null;
  }

  // 2. Open-ended Vietnamese noun-phrase extraction:
  // Examples: "tôi có tiệm gốm thủ công", "bên mình chuyên dịch vụ vệ sinh công nghiệp",
  // "mình đang bán đặc sản thịt trâu gác bếp", "cộng đồng nuôi cá thủy sinh", "xưởng in áo mưa"
  const viChannelPattern =
    /(?:^|\b)(?:(?:tôi|mình|em|anh|chị|bên\s+(?:tôi|mình|em)|nhà\s+mình|chúng\s+tôi)\s+)?(?:(?:đang|mới|vừa|sắp)\s+)?(?:(?:có|làm|mở|vận\s+hành|quản\s+lý|xây\s+dựng|phát\s+triển|kinh\s+doanh|chuyên)\s+)?(?:một\s+|1\s+)?(web(?:site)?|trang\s+web|shop|cửa\s+hàng|tiệm|quán|phòng\s+tập|phòng\s+khám|trung\s+tâm|học\s+viện|studio|xưởng|nhà\s+xưởng|dịch\s+vụ|cộng\s+đồng|diễn\s+đàn|nhóm|clb|câu\s+lạc\s+bộ|kênh|sàn|kho|thương\s+hiệu)\s+([^\n,.;!?()]{2,65})/i;

  const viChannelMatch = viChannelPattern.exec(trimmed);
  if (viChannelMatch?.[1] && viChannelMatch[2]) {
    const channel = viChannelMatch[1].trim();
    const cleanedCore = cleanExtractedTopicPhrase(viChannelMatch[2])
      .replace(/^(?:về|mảng|ngành|bán|làm|chuyên)\s+/i, '')
      .replace(/(?:^|\s+)của\s+(?:tôi|mình|em|anh|chị|bạn|chúng\s+tôi|chúng\s+mình).*$/i, '')
      .trim();

    if (
      cleanedCore.length >= 2 &&
      cleanedCore.length <= 55 &&
      !GENERIC_NON_DOMAIN_PHRASE_RE.test(cleanedCore) &&
      !/^(?:ai\s+support|support\s+ai|chatbot|con\s+ai|tenant)\b/i.test(cleanedCore) &&
      !/^(?:này|nay|đó|do|kia|ấy|ay|hiện\s+tại|hien\s+tai|đang\s+mở|dang\s+mo)\b/i.test(
        cleanedCore,
      ) &&
      !/\b(?:làm\s+gì|lam\s+gi|là\s+gì|la\s+gi|để\s+làm\s+gì|de\s+lam\s+gi|dùng\s+sao|dung\s+sao)\b/i.test(
        cleanedCore,
      )
    ) {
      return buildOpenPhraseInsight(channel, cleanedCore, false);
    }
  }

  // Vietnamese action-verb business phrase without a channel noun:
  // e.g. "bên mình chuyên cho thuê lều cắm trại", "tôi đang bán đặc sản Tây Bắc", "mình dạy đàn guitar đệm hát"
  const viVerbPattern =
    /(?:tôi|mình|em|bên\s+(?:tôi|mình|em)|nhà\s+mình|chúng\s+tôi)\s+(?:(?:đang|mới|vừa|chuyên|cũng)\s+)*(bán|kinh\s+doanh|buôn\s+bán|cho\s+thuê|cung\s+cấp|sản\s+xuất|gia\s+công|dạy|nhận\s+làm|sửa\s+chữa|lắp\s+đặt)\s+([^\n,.;!?()]{3,60})/i;
  const viVerbMatch = viVerbPattern.exec(trimmed);
  if (viVerbMatch?.[1] && viVerbMatch[2]) {
    const verb = viVerbMatch[1].trim();
    const cleanedCore = cleanExtractedTopicPhrase(viVerbMatch[2]);
    if (
      cleanedCore.length >= 3 &&
      cleanedCore.length <= 55 &&
      !GENERIC_NON_DOMAIN_PHRASE_RE.test(cleanedCore) &&
      !/^(?:ai\s+support|chatbot|con\s+ai|tenant)\b/i.test(cleanedCore)
    ) {
      const prefix = /cho\s+thuê|sửa\s+chữa|lắp\s+đặt|dạy/i.test(verb) ? `dịch vụ ${verb}` : `kinh doanh`;
      return buildOpenPhraseInsight(prefix, cleanedCore, false);
    }
  }

  // 3. Open-ended English noun-phrase extraction:
  // e.g. "I run a vintage vinyl record shop", "we have an artisanal sourdough store",
  // "setting up support for a solar panel installation company", "I built a custom mechanical keyboard website"
  const enPattern =
    /\b(?:(?:i|we)\s+(?:have|run|own|manage|operate|built|started|are\s+building|are\s+launching)|for\s+(?:my|our|a|an)|my\s+business\s+is|our\s+business\s+is)\s+(?:a\s+|an\s+|my\s+|our\s+)?([a-z0-9][a-z0-9\s&-]{2,55}?)\s+(shop|store|website|site|studio|clinic|agency|service|services|company|firm|community|club|platform|app|marketplace|bakery|brewery|workshop|rental|business)\b/i;
  const enMatch = enPattern.exec(trimmed);
  if (enMatch?.[1] && enMatch[2]) {
    const descriptor = cleanExtractedTopicPhrase(enMatch[1]).replace(
      /^(?:new|small|local|online|custom|brand-?new|existing|current|ai|customer\s+support|support)\s+/i,
      '',
    );
    const noun = enMatch[2].trim();
    if (
      descriptor.length >= 3 &&
      !GENERIC_NON_DOMAIN_PHRASE_RE.test(descriptor) &&
      !/^(?:ai|support|customer\s+support|chat|tenant|test)$/i.test(descriptor)
    ) {
      return buildOpenPhraseInsight('', `${descriptor} ${noun}`, true);
    }
  }

  const enServiceOfPattern =
    /\b(?:we|i)\s+(?:sell|offer|provide|teach|rent\s+out)\s+([a-z0-9][a-z0-9\s&-]{3,50})/i;
  const enServiceMatch = enServiceOfPattern.exec(trimmed);
  if (enServiceMatch?.[1]) {
    const item = cleanExtractedTopicPhrase(enServiceMatch[1]);
    if (
      item.length >= 3 &&
      !GENERIC_NON_DOMAIN_PHRASE_RE.test(item) &&
      !/^(?:ai\s+support|support|chatbots?)$/i.test(item)
    ) {
      return buildOpenPhraseInsight('', item, true);
    }
  }

  return null;
}

/**
 * Scans user messages (newest to oldest so refinements win, while preserving Turn 1's domain
 * across follow-up meta/affirmation turns) and returns the best OpenDomainTopicInsight.
 */
export function extractOpenDomainTopicFromMessages(
  messages: readonly SupportSetupChatMessage[],
  locale: 'vi' | 'en' = 'vi',
): OpenDomainTopicInsight | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const found = extractOpenDomainTopic(msg.content, locale);
    if (found) return found;
  }
  return null;
}

/**
 * Resolves domain-specific guidance from an already-extracted `industry` string
 * (useful inside `buildSanitizedSetupProposal`, `buildSystemPrompt`, and `buildKnowledgeDocs`).
 */
export function resolveDomainGuidanceFromIndustry(
  industry: string | undefined,
  locale: 'vi' | 'en' = 'vi',
): OpenDomainTopicInsight | null {
  if (!industry || !industry.trim()) return null;
  const trimmed = industry.trim();
  if (/^(?:dịch vụ khách hàng|customer service)/i.test(trimmed)) {
    return null;
  }
  for (const profile of CURATED_DOMAINS) {
    if (
      profile.industryVi.toLowerCase() === trimmed.toLowerCase() ||
      profile.industryEn.toLowerCase() === trimmed.toLowerCase() ||
      profile.re.test(trimmed)
    ) {
      return buildCuratedTopicInsight(profile, trimmed);
    }
  }
  return buildOpenPhraseInsight('', trimmed, locale === 'en');
}

/**
 * Enriches `SupportSetupRequirements` with open-domain topic extraction so open-domain businesses
 * (like "web boardgame", "quán cà phê acoustic", "tiệm gốm thủ công") populate `industry` cleanly.
 */
export function enrichRequirementsWithOpenDomain(
  messages: readonly SupportSetupChatMessage[],
  baseRequirements: SupportSetupRequirements,
  locale: 'vi' | 'en' = 'vi',
  explicitIndustryHint?: string,
): { requirements: SupportSetupRequirements; topic: OpenDomainTopicInsight | null } {
  const topic =
    extractOpenDomainTopicFromMessages(messages, locale) ??
    (explicitIndustryHint ? resolveDomainGuidanceFromIndustry(explicitIndustryHint, locale) : null) ??
    resolveDomainGuidanceFromIndustry(baseRequirements.industry, locale);

  const next: SupportSetupRequirements = { ...baseRequirements };

  if (explicitIndustryHint?.trim()) {
    next.industry = explicitIndustryHint.trim().slice(0, 80);
  } else if (topic) {
    const hasGenericFallbackOnly =
      !next.industry ||
      /^(?:Thương mại điện tử & Bán lẻ|E-commerce & Retail|Dịch vụ khách hàng|Customer Service)/i.test(
        next.industry,
      );
    if (!next.industry || (topic.source === 'curated_domain' && hasGenericFallbackOnly)) {
      next.industry = locale === 'vi' ? topic.industryVi : topic.industryEn;
    }
  }

  if (!next.websiteOrigin) {
    const saidNoWebsite = messages.some(
      (m) => m.role === 'user' && NO_WEBSITE_YET_RE.test(m.content),
    );
    if (saidNoWebsite) {
      next.websiteOrigin = '*';
    }
  }

  return { requirements: next, topic };
}

function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`*_~#>[\]()!?,.:;"'“”‘’—–\-+/\\|]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOpeningSignature(text: string): string {
  const firstLine =
    text
      .split(/\n+/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const firstSentence = firstLine.split(/[.!?…]+/)[0] ?? firstLine;
  return normalizeForSimilarity(firstSentence).split(' ').slice(0, 10).join(' ');
}

function buildWordShingles(normText: string): Set<string> {
  const words = normText.split(' ').filter((w) => w.length > 0);
  const shingles = new Set<string>();
  if (words.length < 3) {
    for (const w of words) shingles.add(w);
    return shingles;
  }
  for (let i = 0; i <= words.length - 3; i += 1) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return shingles;
}

function computeJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Returns `true` if `candidate` is identical or near-identical to ANY prior assistant reply
 * in the conversation (comparing normalized full text, opening sentence signature, and 3-gram overlap).
 */
export function isReplyTooSimilar(
  candidate: string,
  priorAssistantMessages: readonly string[],
): boolean {
  const candNorm = normalizeForSimilarity(candidate);
  if (!candNorm) return true;
  const candOpening = extractOpeningSignature(candidate);
  const candShingles = buildWordShingles(candNorm);

  for (const prior of priorAssistantMessages) {
    const priorNorm = normalizeForSimilarity(prior);
    if (!priorNorm) continue;
    if (candNorm === priorNorm) return true;
    const priorOpening = extractOpeningSignature(prior);
    if (candOpening.length >= 16 && candOpening === priorOpening) {
      return true;
    }
    const overlap = computeJaccard(candShingles, buildWordShingles(priorNorm));
    if (overlap >= 0.52) {
      return true;
    }
  }
  return false;
}

/**
 * Selects the first natural candidate that has NOT been said (or nearly said) earlier in the
 * conversation; if all static variants have already been used in a long conversation, synthesizes
 * a fresh, concise, human follow-up tailored to the turn count so two turns never repeat.
 */
export function ensureNonRepetitiveReply(
  candidates: readonly string[],
  priorAssistantMessages: readonly string[],
  locale: 'vi' | 'en',
  contextTopicLabel?: string,
): string {
  for (const candidate of candidates) {
    if (candidate.trim() && !isReplyTooSimilar(candidate, priorAssistantMessages)) {
      return candidate;
    }
  }

  const turnIndex = priorAssistantMessages.length + 1;
  const topicNoteVi = contextTopicLabel ? ` cho **${contextTopicLabel}**` : '';
  const topicNoteEn = contextTopicLabel ? ` for **${contextTopicLabel}**` : '';

  const dynamicFallbacks =
    locale === 'vi'
      ? [
          `Nếu bạn chưa tiện gõ dài lúc này (lượt trao đổi #${turnIndex}), để mình tạo luôn một bản nháp cấu hình chuẩn${topicNoteVi} nhé — nhìn trực tiếp trên giao diện xong muốn đổi tên hay màu sắc gì mình chỉnh lại trong một nốt nhạc thôi!`,
          `Mình vẫn đang lắng nghe bạn đây (cập nhật #${turnIndex})! Thay vì hỏi thêm làm bạn mất thời gian, bạn chỉ cần nhắn **"ok"** là mình dựng sẵn bản kế hoạch mẫu${topicNoteVi} để bạn duyệt thử ngay nha.`,
          `Cứ thong thả theo nhịp của bạn nhé (#${turnIndex})! Bất cứ khi nào bạn sẵn sàng, gõ nhẹ **"lên bản mẫu"** để mình bày sẵn phương án${topicNoteVi} ra thẻ xem trước cho bạn dễ hình dung nhất.`,
        ]
      : [
          `No rush at all (note #${turnIndex}) — instead of making you type more details, just say **"ok"** and I will spin up a clean starter draft${topicNoteEn} that you can preview and tweak anytime!`,
          `Still right here with you (step #${turnIndex})! Whenever you want to see something concrete${topicNoteEn}, reply **"draft it"** and I will lay out a safe preview plan with zero live changes until you approve.`,
          `Take your time (#${turnIndex})! Tell me any single preference you care about${topicNoteEn}, or say **"go ahead"** so I can put a ready-to-review setup draft in front of you.`,
        ];

  for (const fb of dynamicFallbacks) {
    if (!isReplyTooSimilar(fb, priorAssistantMessages)) {
      return fb;
    }
  }

  return locale === 'vi'
    ? `Mình hiểu ý bạn rồi (gợi ý nhanh #${turnIndex}) — bạn nhắn **"ok lên kế hoạch"** bất cứ lúc nào để mình soạn ngay bản nháp${topicNoteVi} cho bạn xem thử nhé!`
    : `Got you (quick check-in #${turnIndex}) — just reply **"ok draft it"** whenever you want me to put together a starter plan${topicNoteEn} for your review!`;
}

export function matchSpecificStepQuestion(text: string): SupportSetupStepId | null {
  const trimmed = text.trim();
  const looksLikeQuestion =
    /\?|làm\s+sao|như\s+thế\s+nào|là\s+gì|ở\s+đâu|cách\s+|giải\s+thích|bước\s*[1-7]|step\s*[1-7]|how\s+|what\s+|where\s+|explain/i.test(
      trimmed,
    );
  if (!looksLikeQuestion) return null;
  if (/(?:7|bảy|all|từng|các)\s*(?:bước|steps)/i.test(trimmed)) return null;

  if (/bước\s*1|step\s*1|system\s*prompt|nhân\s*cách|persona/i.test(trimmed)) return 'tenant_ai';
  if (
    /bước\s*2|step\s*2|knowledge|\brag\b|tài\s*liệu|tri\s*thức|\bfaq\b|\bpii\b|masking|che\s*(?:dữ\s*liệu|sđt|email)/i.test(
      trimmed,
    )
  ) {
    return 'knowledge_masking';
  }
  if (
    /bước\s*3|step\s*3|guardrail|firewall|tường\s*lửa|injection|quota|hạn\s*mức|chủ\s*đề\s*cấm/i.test(
      trimmed,
    )
  ) {
    return 'guardrails_quotas';
  }
  if (/bước\s*4|step\s*4|output\s*control|kiểm\s*soát\s*đầu\s*ra|redact|che\s*khóa/i.test(trimmed)) {
    return 'output_controls';
  }
  if (/bước\s*5|step\s*5|widget|nút\s*chat|khung\s*chat|intake|form\s*thu\s*thập/i.test(trimmed)) {
    return 'widget_appearance';
  }
  if (/bước\s*6|step\s*6|\bsla\b|routing|phân\s*luồng|service\s*desk|ticket/i.test(trimmed)) {
    return 'sla_routing';
  }
  if (/bước\s*7|step\s*7|\bcors\b|origin|nhúng|embed|<script|snippet|runtime|context\s*token/i.test(trimmed)) {
    return 'runtime_policy';
  }
  return null;
}

const FRUSTRATION_RE =
  /cứng\s*nhắc|cung\s*nhac|máy\s*móc|may\s*moc|như\s*(?:cái\s*)?(?:máy|robot|bot)|nhu\s*(?:cai\s*)?(?:may|robot|bot)|hỏi\s*(?:nhiều|lắm)\s*(?:quá|thế|vậy)|hoi\s*(?:nhieu|lam)\s*(?:qua|the|vay)|nhiều\s*câu\s*hỏi\s*quá|bắt\s*điền\s*form|đừng\s*lặp\s*lại|dung\s*lap\s*lai|lặp\s*(?:đi\s*)?lặp\s*lại|lặp\s*lại\s*(?:hoài|quài|mãi|nữa)|nói\s*đi\s*nói\s*lại|vẫn\s*câu\s*đó|copy\s*paste|trả\s*lời\s*chán|sao\s*hỏi\s*hoài|\b(?:so\s+robotic|like\s+a\s+(?:robot|bot)|too\s+many\s+questions|stop\s+repeating|repeating\s+yourself|why\s+so\s+stiff|rigid\s+form)\b/i;

const LANGUAGE_SWITCH_REQUEST_RE =
  /^(?:(?:dạ|ơi|này|ê|bạn\s+ơi)\s*,?\s*)?(?:(?:bạn|ban|em|ai)\s+(?:có\s+thể|co\s+the|biết|biet)\s+)?(?:nói|dùng|trả\s+lời|chat)\s*(?:bằng\s*)?tiếng\s*(?:việt|anh)|tieng\s+viet\s+(?:khong|duoc\s+khong|nhe|di)|\b(?:can\s+you\s+|do\s+you\s+|please\s+)?(?:speak|talk\s+in|reply\s+in|switch\s+to)\s+(?:vietnamese|english)\b/i;

const BUSINESS_COURSE_EXCLUSION_RE =
  /khóa\s+học|trung\s+tâm|học\s+viện|lớp\s+học|dạy\s+(?:giao\s+tiếp|tiếng)|bán\s+khóa|\bcourse\b|\bschool\b|\bacademy\b/i;

const CAPABILITY_PUSHBACK_RE =
  /(?:bạn|ban|mày|may|em|anh|ai|cậu|cau|ad)\s+(?:thực\s+sự\s+|thật\s+sự\s+|rốt\s+cuộc\s+|thuc\s+su\s+|that\s+su\s+|rot\s+cuoc\s+)?(?:có\s+thể|co\s+the|biết|biet|làm\s+được|lam\s+duoc|giúp\s+được|giup\s+duoc|hỗ\s+trợ\s+được|ho\s+tro\s+duoc)\s*(?:những\s+|nhung\s+|cái\s+|cai\s+)?(?:làm\s+|lam\s+|giúp\s+|giup\s+)?(?:gì|gi|những\s+gì|nhung\s+gi)|(?:bạn|ban|mày|may|em)\s+(?:là\s+ai|la\s+ai|giúp\s+gì\s+được|giup\s+gi\s+duoc|làm\s+gì\s+được|lam\s+gi\s+duoc)|chức\s+năng\s+của\s+(?:bạn|ban|em)|chuc\s+nang\s+cua\s+(?:ban|em)|tác\s+dụng\s+gì|tac\s+dung\s+gi|\b(?:who\s+are\s+you|what\s+can\s+you\s+(?:actually\s+)?do|how\s+can\s+you\s+help|what\s+do\s+you\s+do|what\s+are\s+your\s+capabilities)\b/i;

const HESITATION_OR_ADVICE_RE =
  /chưa\s+biết\s+bắt\s+đầu|chua\s+biet\s+bat\s+dau|không\s+biết\s+bắt\s+đầu|bắt\s+đầu\s+từ\s+đâu|tư\s+vấn\s+(?:cho\s+|giúp\s+|giùm\s+)?(?:mình|tôi|em)|tu\s+van\s+(?:cho\s+|giup\s+)?(?:minh|toi|em)|gợi\s+ý\s+(?:cho\s+|giúp\s+)?(?:mình|tôi|em)|goi\s+y\s+(?:cho\s+|giup\s+)?(?:minh|toi|em)|không\s+rành\s+kỹ\s+thuật|khong\s+ranh\s+ky\s+thuat|mù\s+công\s+nghệ|không\s+biết\s+code|mới\s+dùng\s+lần\s+đầu|khó\s+hiểu\s+quá|rối\s+quá|nên\s+bắt\s+đầu\s+sao|\b(?:don'?t\s+know\s+where\s+to\s+start|not\s+sure\s+where\s+to\s+(?:start|begin)|not\s+technical|advise\s+me|give\s+me\s+(?:some\s+)?advice|what\s+do\s+you\s+recommend|guide\s+me\s+gently)\b/i;

const NO_WEBSITE_YET_RE =
  /chưa\s+có\s+(?:web(?:site)?|trang\s+web|domain|tên\s+miền)|không\s+có\s+(?:web(?:site)?|trang\s+web|domain)|chua\s+co\s+web|mới\s+bán\s+(?:trên\s+)?(?:facebook|fanpage|tiktok|shopee|zalo|instagram)|\b(?:no\s+website\s+yet|don'?t\s+have\s+a\s+website|no\s+domain\s+yet)\b/i;

const THANKS_RE =
  /^(?:ok\s+)?(?:cảm\s+ơn|cám\s+ơn|cam\s+on|thank\s+you|thanks|tks|cảm\s+ơn\s+(?:bạn|em|nhiều|nha|nhé)|thank\s+you\s+so\s+much)[!.?,\s]*$/i;

/**
 * The caller asking about their OWN role / permissions — e.g. "tôi có role và
 * quyền gì", "tôi là admin hay member", "quyền của tôi là gì",
 * "what are my permissions", "am I an admin". Checked BEFORE the roadmap /
 * step guides (whose "là gì" patterns would otherwise swallow these), and
 * answered deterministically from the server identity record — never by LLM.
 *
 * NOTE: plain `\b` is ASCII-only in JS, so it never matches next to a
 * Vietnamese diacritic (e.g. after "có" or "quyền"). Boundaries here use
 * Unicode-aware lookarounds over [A-Za-zÀ-ỹ0-9_] instead.
 */
const U = 'A-Za-zÀ-ỹ0-9_';
const IDENTITY_OR_PERMISSIONS_RE = new RegExp(
  [
    `(?:tôi|mình|tui|em)\\s+(?:có|đang\\s+có)(?![${U}])[^.!?\\n]{0,60}?(?<![${U}])(?:role|quyền|quyen|quyền\\s+hạn)(?![${U}])`,
    `(?<![${U}])(?:quyền|quyen|quyền\\s+hạn|vai\\s+trò|role)\\s+(?:của\\s+)?(?:tôi|mình|tui|em)(?![${U}])`,
    `(?<![${U}])(?:tôi|mình|tui|em)\\s+là\\s+(?:admin|member|quản\\s+trị|quan\\s+tri|người\\s+dùng|nguoi\\s+dung)(?![${U}])`,
    `(?<![${U}])(?:tôi|mình)\\s+(?:có\\s+)?(?:được\\s+)?(?:những\\s+)?quyền\\s+(?:gì|nào|han)(?![${U}])`,
    `(?<![${U}])(?:tôi|mình)\\s+được\\s+(?:phép\\s+)?(?:làm\\s+)?(?:những\\s+)?(?:gì|gi)(?![${U}])`,
    `(?<![${U}])(?:cho\\s+)?(?:tôi|mình)\\s+(?:biết\\s+)?(?:role|quyền|quyen)\\s+(?:của\\s+)?(?:tôi|mình)(?![${U}])`,
    `\\bam\\s+i\\s+(?:an\\s+)?(?:admin|a\\s+member)\\b`,
    `\\bwhat(?:'s|\\s+is)\\s+my\\s+role\\b`,
    `\\bwhat\\s+are\\s+my\\s+permissions\\b`,
    `\\bwhat\\s+(?:permissions|access|role)\\s+do\\s+i\\s+have\\b`,
    `\\bdo\\s+i\\s+have\\s+(?:admin|permission|access)\\b`,
    `\\bmy\\s+(?:role|permissions)\\b`,
    `\\bshow\\s+(?:me\\s+)?my\\s+permissions\\b`,
    `\\bcheck\\s+my\\s+(?:role|permissions)\\b`,
    `\\bwho\\s+am\\s+i\\b`,
  ].join('|'),
  'i',
);

export function isIdentityOrPermissionsQuestion(text: string): boolean {
  return IDENTITY_OR_PERMISSIONS_RE.test((text || '').trim());
}

const GREETING_RE =
  /^(?:(?:xin\s+)?(?:chào|chao)(?:\s+(?:bạn|ban|ad|em|anh|chị|ai|mình|nhé|nha))?|alo|hi|hello|hey|good\s+(?:morning|afternoon|evening)|ban\s+oi|bạn\s+ơi)[!.?,\s]*$/i;

const SHORT_AFFIRMATION_RE =
  /^(?:ok|oke|okay|okie|ok\s+(?:bạn|ban|em|nhé|nha|luôn|luon|đi|di)|ừ|ừa|uh|uhm|ờ|được|duoc|được\s+(?:đó|đấy|nha|nhé|bạn|luôn)|duoc\s+(?:do|day|nha|nhe|luon)|nhất\s+trí|đồng\s+ý|chốt|chốt\s+luôn|triển|triển\s+(?:luôn|đi|thôi)|trien\s+(?:luon|di)|làm\s+(?:đi|luôn|luôn\s+đi|thử\s+đi)|lam\s+(?:di|luon|luon\s+di)|yes|yep|sure|sounds\s+good|go\s+ahead|let'?s\s+do\s+it|do\s+it|proceed)[!.?,\s]*$/i;

const PROCEED_OR_DRAFT_NOW_RE =
  /(?:lên|tạo|dựng|làm|soạn)\s+(?:thử\s+)?(?:luôn\s+)?(?:1\s+|một\s+)?(?:kế\s+hoạch|bản\s+mẫu|bản\s+nháp|phương\s+án|cấu\s+hình)|(?:len|tao|dung|lam|soan)\s+(?:thu\s+)?(?:luon\s+)?(?:1\s+|mot\s+)?(?:ke\s+hoach|ban\s+mau|ban\s+nhap)|hoàn\s+thiện\s+cấu\s+hình\s+tiêu\s+chuẩn|dùng\s+(?:cấu\s+hình\s+)?mặc\s+định|tiêu\s+chuẩn|tùy\s+bạn|tuy\s+ban|sao\s+cũng\s+được|tự\s+chọn|tự\s+đề\s+xuất|làm\s+luôn|tạo\s+luôn|triển\s+khai\s+luôn|cứ\s+đề\s+xuất|\b(?:auto-?complete|standard\s+defaults|smart\s+defaults|use\s+(?:smart\s+)?defaults|(?:ok\s+)?draft\s+(?:it|one|now|(?:a\s+|the\s+)?(?:standard\s+)?(?:starter\s+)?(?:plan|setup|draft)|smart\s+defaults)|generate\s+(?:a\s+|the\s+)?(?:starter\s+)?plan|up\s+to\s+you|just\s+set\s+it\s+up)\b/i;

const ROADMAP_GUIDE_RE =
  /hướng\s+dẫn|các\s+bước|7\s+bước|bảy\s+bước|lộ\s+trình|quy\s+trình|làm\s+sao|như\s+thế\s+nào|cách\s+dùng|cách\s+setup|tại\s+sao|là\s+gì|ở\s+đâu|\broadmap\b|\bhow\s+to\b|\bhow\s+do\s+i\b|\bsteps\s+to\b|\bstep\s+by\s+step\b|\bguide\s+me\b|\bexplain\b|\bwhat\s+does\b|\bwhat\s+is\b|\bwhere\s+do\s+i\b|\btroubleshooting\b|kiểm\s+tra\s+tình\s+trạng/i;

const AUTO_DO_IT_PHRASE_RE =
  /setup\s+giúp|setup\s+thay|làm\s+giúp|làm\s+thay|cài\s+đặt\s+tự\s+động|tự\s+động\s+setup|thiết\s+lập\s+giúp|thiết\s+lập\s+thay|tạo\s+giúp|tạo\s+giùm|hoàn\s+thiện\s+giúp|muốn\s+setup|cần\s+setup|auto[- ]?setup|set\s+up\s+.*for\s+me|configure\s+.*for\s+me|do\s+it\s+for\s+me/i;

/**
 * Classifies a human user's message into a warm conversational act so pushback, capability
 * questions, hesitation, greetings, and quick affirmations never trigger stiff intake forms.
 */
export function classifyHumanConversationalAct(
  text: string,
  currentPath?: string | null,
): HumanConversationalAct {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'business_context';

  if (THANKS_RE.test(trimmed)) return 'thanks';
  if (GREETING_RE.test(trimmed)) return 'greeting';

  // Identity / permissions questions are answered deterministically from the
  // server identity record — classify them before any guide/step matcher.
  if (isIdentityOrPermissionsQuestion(trimmed)) return 'identity_or_permissions';

  // Phase 3: grant/revoke requests are handled deterministically before any
  // dialogue branch — classify them so the read-only loop path can offer
  // the grant tools instead of swallowing the turn as a guide.
  if (matchPermissionGrantIntent(trimmed)) return 'permission_grant_revoke';

  if (matchPlatformKnowledgeQuestion(trimmed, currentPath)) {
    return 'platform_guide';
  }

  // If the user explicitly asks to draft/proceed right now (without complaining first), honor proceed
  if (SHORT_AFFIRMATION_RE.test(trimmed) || PROCEED_OR_DRAFT_NOW_RE.test(trimmed)) {
    // Unless they are specifically complaining about stiffness without asking to proceed
    if (FRUSTRATION_RE.test(trimmed) && !PROCEED_OR_DRAFT_NOW_RE.test(trimmed)) {
      return 'frustration_pushback';
    }
    return 'affirmation_proceed';
  }

  if (FRUSTRATION_RE.test(trimmed)) {
    return 'frustration_pushback';
  }

  if (
    trimmed.length <= 160 &&
    (CAPABILITY_PUSHBACK_RE.test(trimmed) ||
      (!BUSINESS_COURSE_EXCLUSION_RE.test(trimmed) && LANGUAGE_SWITCH_REQUEST_RE.test(trimmed)))
  ) {
    return 'capability_or_pushback';
  }

  if (trimmed.length <= 180 && HESITATION_OR_ADVICE_RE.test(trimmed)) {
    return 'hesitation_or_advice';
  }

  if (trimmed.length <= 160 && NO_WEBSITE_YET_RE.test(trimmed)) {
    return 'no_website_reassurance';
  }

  if (matchSpecificStepQuestion(trimmed)) {
    return 'step_question';
  }

  if (ROADMAP_GUIDE_RE.test(trimmed) && !AUTO_DO_IT_PHRASE_RE.test(trimmed)) {
    return 'roadmap_guide';
  }

  return 'business_context';
}

function countConcreteRequirementSignals(
  reqs: SupportSetupRequirements,
  topic: OpenDomainTopicInsight | null,
): number {
  let score = 0;
  if (reqs.brandName?.trim()) score += 1;
  if (reqs.industry?.trim() || topic) score += 1;
  if (reqs.faqSummaryOrPolicies?.trim()) score += 1;
  if (reqs.websiteOrigin?.trim()) score += 1;
  if (reqs.primaryColor?.trim()) score += 1;
  if (reqs.tone) score += 1;
  if (reqs.competitorKeywords?.length || reqs.blockedTopics?.length) score += 1;
  if (typeof reqs.requireContactIntake === 'boolean') score += 1;
  return score;
}

function countPriorDiscoveryPrompts(messages: readonly SupportSetupChatMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const t = msg.content;
    if (
      /bản mẫu|bản nháp|tên shop|tên thương hiệu|đổi trả|kế hoạch|starter plan|draft a|brand name|return window/i.test(
        t,
      ) &&
      !/Chờ xác nhận triển khai|Consent Required/i.test(t)
    ) {
      count += 1;
    }
  }
  return count;
}

function buildMissingHintList(
  locale: 'vi' | 'en',
  reqs: SupportSetupRequirements,
  hasActiveTenant: boolean,
  hasKnownTopicOrIndustry: boolean,
): string[] {
  const hints: string[] = [];
  if (locale === 'vi') {
    if (!reqs.brandName && !hasActiveTenant) {
      hints.push(
        hasKnownTopicOrIndustry
          ? 'Tên shop / thương hiệu bạn muốn hiển thị trên khung chat'
          : 'Tên thương hiệu / cửa hàng và mảng sản phẩm dịch vụ của bạn',
      );
    } else if (!hasKnownTopicOrIndustry) {
      hints.push('Mảng kinh doanh / sản phẩm dịch vụ chính của bên bạn');
    }
    if (!reqs.faqSummaryOrPolicies) {
      hints.push('Quy định cơ bản khách hay hỏi (ví dụ: phí ship, đổi trả mấy ngày, giờ mở cửa)');
    }
    if (!reqs.websiteOrigin || !reqs.primaryColor || !reqs.tone) {
      hints.push('Website (nếu đã có), tông màu chủ đạo hoặc giọng điệu tư vấn bạn thích');
    }
    if (!reqs.competitorKeywords?.length && !reqs.blockedTopics?.length && hints.length < 3) {
      hints.push('Lưu ý riêng nếu có (từ khóa không muốn nhắc tới hoặc bật/tắt nhập email trước khi chat)');
    }
    return hints;
  }

  if (!reqs.brandName && !hasActiveTenant) {
    hints.push(
      hasKnownTopicOrIndustry
        ? 'Your brand or shop name for the chat header'
        : 'Your brand/shop name and what products or services you offer',
    );
  } else if (!hasKnownTopicOrIndustry) {
    hints.push('What kind of products, services, or community you run');
  }
  if (!reqs.faqSummaryOrPolicies) {
    hints.push('Key customer policies (e.g. shipping, return window, support hours, or pricing)');
  }
  if (!reqs.websiteOrigin || !reqs.primaryColor || !reqs.tone) {
    hints.push('Website domain (if live), brand accent color, or preferred support tone');
  }
  if (!reqs.competitorKeywords?.length && !reqs.blockedTopics?.length && hints.length < 3) {
    hints.push('Optional guardrails (competitor names to avoid or pre-chat email intake)');
  }
  return hints;
}

const STEP_WARM_EXPLANATIONS: Record<SupportSetupStepId, { vi: string[]; en: string[] }> = {
  tenant_ai: {
    vi: [
      '**Bước 1 — Tạo Trợ lý & Định hình giọng điệu** (`/thruline/support` · tab *AI & Prompt*):\nỞ bước này mình đặt tên cho trợ lý, viết lời dặn dò cốt lõi (**System Prompt**) để AI biết xưng hô thân thiện đúng chất thương hiệu, chọn model mặc định (`auto` để tự động dự phòng mượt mà) và bật `allowGuest` cho khách ghé web chat được ngay.\n\nBạn muốn mình viết sẵn luôn đoạn System Prompt chuẩn cho bên bạn để xem thử không?',
      'Về **Bước 1 (Nhân cách AI tại `/thruline/support`)**: đây giống như bước "đào tạo nhân viên mới" vậy — mình quy định rõ AI đại diện cho thương hiệu nào, giọng văn gần gũi hay trang trọng, và dặn kỹ không bao giờ tự bịa giá hay đơn hàng ảo (cùng cài đặt `allowGuest` cho khách vãng lai). Nhắn mình tên shop là mình nháp sẵn cho bạn duyệt liền nhé!',
    ],
    en: [
      '**Step 1 — Tenant & AI Persona** (`/thruline/support` · *AI & Prompt* tab):\nThink of this as briefing a new support teammate: you set the **System Prompt** (brand voice, helpfulness, and strict grounding rules), pick a **Default Model** (`auto` handles failover smoothly), and turn on `allowGuest` for website visitors.\n\nTell me your brand name and vibe if you want me to draft this prompt for you!',
      'In **Step 1 (`/thruline/support`)**, we shape how your assistant speaks and behaves — setting its System Prompt, model (`auto`), and `allowGuest` visitor access so it represents your brand naturally without hallucinating policies.',
    ],
  },
  knowledge_masking: {
    vi: [
      '**Bước 2 — Nạp tài liệu câu hỏi thường gặp (FAQ) & Che thông tin nhạy cảm** (`/thruline/support-knowledge`):\n- Bạn đưa bảng giá, quy định ship/đổi trả vào kho tri thức để AI trả lời chuẩn xác. **Mẹo cực quan trọng:** khi lưu bài viết, nhớ bật quyền xem cho `guest` và `customer` trong mục `allowedRoles` thì khách chat ngoài website mới tra cứu được nội dung đó nhé!\n- Đồng thời bật **PII Masking** (`email`, `phone`, `credit_card`, `api_key`) để hệ thống tự động che SĐT, email hay số thẻ của khách trước khi gửi lên model.',
      'Ở **Bước 2 (`/thruline/support-knowledge`)**, để khách bên ngoài hỏi mà AI đọc được bài FAQ thì bí quyết nằm ở trường `allowedRoles`: bạn nhớ tích chọn cả `guest` lẫn `customer` (nếu chỉ để `admin` thì tài liệu chỉ lưu hành nội bộ thôi). Kèm theo đó mình bật luôn **PII Masking** để tự che SĐT/email/thẻ khách hàng cho an toàn tuyệt đối nhé!',
    ],
    en: [
      '**Step 2 — Knowledge Base (RAG) & PII Masking** (`/thruline/support-knowledge`):\n- Add your FAQs, shipping rules, and return policies here. **Key tip:** make sure both `guest` and `customer` are checked in `allowedRoles` so your public website widget can retrieve those articles!\n- Enable **PII Masking** (`email`, `phone`, `credit_card`, `api_key`) so customer contact and card details are automatically redacted before hitting the model.',
      'For **Step 2 (`/thruline/support-knowledge`)**, customer visibility comes down to `allowedRoles`: include `guest` and `customer` on public FAQ docs, while keeping internal notes restricted. Pairing that with **PII Masking** protects emails, phone numbers, and cards automatically.',
    ],
  },
  guardrails_quotas: {
    vi: [
      '**Bước 3 — Lớp chắn bảo vệ (Guardrails) & Hạn mức** (`/thruline/support-guardrails`):\nBước này giúp bạn yên tâm mở chat công khai mà không sợ bị phá: hệ thống bật 4 bộ lọc chống **Prompt Injection** (ngăn mẹo lừa AI lộ hướng dẫn nội bộ), chặn nhắc tên đối thủ hoặc chủ đề nhạy cảm, và giới hạn số lượt hỏi mỗi giờ cho khách vãng lai (`guest`) để tránh tốn quota oan.',
      'Về **Bước 3 (`/thruline/support-guardrails`)**: mình dựng hàng rào an toàn gồm chống Prompt Injection, danh sách chủ đề/từ khóa đối thủ không bàn tới, kèm hạn mức hợp lý theo từng nhóm người dùng (`guest`, `customer`, `staff`).',
    ],
    en: [
      '**Step 3 — Prompt Firewall & Quotas** (`/thruline/support-guardrails`):\nThis keeps your public chat safe from abuse: turn on all 4 **Prompt Injection** detectors, add any competitor names or off-limit topics, and set hourly request/token quotas per role (`guest`, `customer`, `staff`) so traffic spikes never burn through your budget.',
      'In **Step 3 (`/thruline/support-guardrails`)**, we protect your assistant against prompt-injection tricks, filter out restricted topics, and cap hourly usage per visitor role.',
    ],
  },
  output_controls: {
    vi: [
      '**Bước 4 — Kiểm duyệt câu trả lời đầu ra** (`/thruline/support-output`):\nTrước khi tin nhắn của AI hiện lên màn hình khách hàng, bước này quét lại một vòng cuối ở chế độ **`enforce`** và bật **`redactCredentials`** để đảm bảo không bao giờ lọt khóa bí mật hay từ ngữ bị cấm ra ngoài.',
      'Ở **Bước 4 (`/thruline/support-output`)**, bạn chỉ cần đặt chế độ `enforce` và bật che khóa bí mật (`redactCredentials`) — coi như chốt kiểm tra chất lượng cuối cùng trước khi câu trả lời tới tay khách.',
    ],
    en: [
      '**Step 4 — Output Safety Controls** (`/thruline/support-output`):\nSet mode to **`enforce`** and turn on **`redactCredentials`** — it acts as a final safety filter before any AI message reaches your customer, scrubbing accidental secrets or restricted terms.',
      'In **Step 4 (`/thruline/support-output`)**, `enforce` mode plus `redactCredentials` ensures outbound replies never leak keys or forbidden phrases.',
    ],
  },
  widget_appearance: {
    vi: [
      '**Bước 5 — Giao diện khung Chat Widget** (`/thruline/support-desk`):\nĐây là phần khách nhìn thấy đầu tiên trên web của bạn! Mình bật Widget lên, phối màu trùng tông thương hiệu, viết câu chào mở đầu thật thân thiện, gắn sẵn 3 nút gợi ý câu hỏi nhanh, và tùy chọn xem có cần khách điền Tên/Email trước khi chat hay cho hỏi liền không cần điền form.',
      'Về **Bước 5 (`/thruline/support-desk`)**: bạn thoải mái chỉnh màu sắc, tiêu đề, lời chào và các nút bấm hỏi nhanh của khung chat nổi góc màn hình sao cho hợp gu website nhất.',
    ],
    en: [
      '**Step 5 — Chat Widget & Branding** (`/thruline/support-desk`):\nCustomize what visitors see on your site: match your brand colors, craft a welcoming greeting, add 3 helpful quick-prompt pills, and choose between instant zero-friction chat or a quick Name/Email pre-chat form.',
      'In **Step 5 (`/thruline/support-desk`)**, you style the floating chat launcher, colors, greeting, quick prompts, and optional contact intake.',
    ],
  },
  sla_routing: {
    vi: [
      '**Bước 6 — Cam kết phản hồi (SLA) & Chuyển đúng bộ phận** (`/thruline/support-desk`):\nKhi khách gặp ca khó cần người thật xử lý (như hoàn tiền, lỗi đơn hàng), hệ thống tự động tạo ticket gắn mốc thời gian ưu tiên (ví dụ ca khẩn 5 phút) và phân luồng về đúng nhóm **Đổi trả (`returns`)**, **Thanh toán (`billing`)** hoặc **Kỹ thuật (`technical`)**.',
      'Ở **Bước 6 (`/thruline/support-desk`)**, mình cài đặt SLA thời gian phản hồi và từ khóa tự động chuyển tiếp ticket sang bộ phận Đổi trả, Thanh toán hoặc Kỹ thuật để đội ngũ của bạn không bỏ sót khách.',
    ],
    en: [
      '**Step 6 — Service Desk SLA & Routing** (`/thruline/support-desk`):\nWhen a conversation needs a human touch, SLA timers track response goals (e.g. 5m urgent / 15m high) and keyword rules automatically route tickets to `returns`, `billing`, or `technical` teams.',
      'In **Step 6 (`/thruline/support-desk`)**, you set response-time SLAs and automatic department routing so human handoffs stay fast and organized.',
    ],
  },
  runtime_policy: {
    vi: [
      '**Bước 7 — Khóa tên miền (CORS), Giới hạn Runtime & Nhúng lên web** (`/thruline/support-integration`):\nBước hoàn thiện cuối cùng: bạn điền tên miền website thật vào **Allowed Origins (CORS)** để chỉ web của bạn mới nhúng được widget, đặt giới hạn token an toàn mỗi lượt trả lời, rồi copy đoạn mã `<script>` ngắn gọn dán vào web là chạy ngay!',
      'Về **Bước 7 (`/thruline/support-integration`)**: mình khóa CORS theo domain chính thức, kiểm tra độ dài câu trả lời tối đa hợp lý, và lấy đoạn mã nhúng `<script>` đưa lên website.',
    ],
    en: [
      '**Step 7 — CORS Origins, Runtime Bounds & Website Embed** (`/thruline/support-integration`):\nLock **Allowed Origins (CORS)** to your live domain so nobody else can embed your widget, set clean token/tool limits per turn, and copy the `<script>` snippet right into your site.',
      'In **Step 7 (`/thruline/support-integration`)**, we restrict CORS to your domain, cap per-turn token bounds, and grab the `<script>` tag to go live.',
    ],
  },
};

function buildWarmRoadmapGuide(params: {
  locale: 'vi' | 'en';
  diagnostic: SupportSetupTenantDiagnostic | null;
  canCreateTenant: boolean;
  canEditAny: boolean;
  priorAssistantMessages: readonly string[];
}): { reply: string; quickReplies: string[] } {
  const { locale, diagnostic, canCreateTenant, canEditAny, priorAssistantMessages } = params;
  const stepIcon = (status: SupportSetupTenantDiagnostic['steps'][number]['status']) =>
    status === 'complete' ? '✅' : status === 'partial' ? '🟡' : status === 'restricted' ? '🔒' : '⭕';

  if (locale === 'vi') {
    const diagSummary = diagnostic
      ? `Hiện trên tenant **${diagnostic.tenant.name}** của bạn đã hoàn tất **${diagnostic.completedSteps}/${diagnostic.totalSteps} hạng mục**:\n` +
        diagnostic.steps.map((st) => `- ${stepIcon(st.status)} ${st.summaryVi}`).join('\n')
      : canCreateTenant
        ? 'Hiện bạn chưa chọn tenant nào — mình có thể hướng dẫn từng phần hoặc khởi tạo mới trọn gói giúp bạn.'
        : 'Bạn hãy chọn tenant được phân quyền để xem chi tiết trạng thái từng phần nhé.';

    const closing =
      canEditAny || canCreateTenant
        ? 'Bạn không cần tự tay chỉnh hết từng màn hình đâu — chỉ cần kể nhẹ cho mình nghe bên bạn đang kinh doanh mảng gì (hoặc bấm nút gợi ý bên dưới), mình sẽ soạn sẵn bản nháp trọn gói để bạn xem và duyệt!'
        : 'Tài khoản của bạn hiện ở chế độ **Chỉ xem (Read-Only)** nên mình sẽ hỗ trợ giải thích chi tiết từng mục mà không tự động thay đổi cấu hình nhé.';

    const v1 = [
      'Để dựng một trợ lý AI trực web vừa trả lời tự nhiên vừa an toàn, mình đi qua **7 mảnh ghép chính** như sau nhé:',
      '',
      '- **Nhân cách & Model** (`/thruline/support`): Đặt tên, chọn model mặc định và viết hướng dẫn xưng hô cho AI.',
      '- **Kho câu hỏi FAQ & Bảo vệ thông tin cá nhân** (`/thruline/support-knowledge`): Nạp chính sách/bảng giá (bật quyền `guest` & `customer`) và tự che SĐT, email, số thẻ.',
      '- **Hàng rào chống phá rối** (`/thruline/support-guardrails`): Chặn mẹo lừa lộ prompt, lọc từ khóa nhạy cảm và giới hạn lượt hỏi hợp lý.',
      '- **Kiểm duyệt đầu ra** (`/thruline/support-output`): Bật chế độ `enforce` để rà soát câu trả lời trước khi gửi tới khách.',
      '- **Giao diện khung Chat** (`/thruline/support-desk`): Phối màu thương hiệu, lời chào thân thiện và câu hỏi gợi ý.',
      '- **Phân luồng nhân viên & SLA** (`/thruline/support-desk`): Tự chuyển các ca hoàn tiền, thanh toán, kỹ thuật về đúng người phụ trách.',
      '- **Khóa tên miền & Nhúng web** (`/thruline/support-integration`): Cấp phép CORS cho domain thật và lấy mã `<script>` gắn lên web.',
      '',
      diagSummary,
      '',
      closing,
    ].join('\n');

    const v2 = [
      'Mình tóm tắt bức tranh toàn cảnh **7 phần thiết lập AI Support** theo cách dễ hiểu nhất nha: từ việc định hình giọng nói của AI (`/thruline/support`), nạp kiến thức bán hàng & che SĐT khách (`/thruline/support-knowledge`), dựng tường lửa đầu vào (`/thruline/support-guardrails`) + đầu ra (`/thruline/support-output`), tới trang trí khung chat & chia ca trực (`/thruline/support-desk`) rồi nhúng mã lên website (`/thruline/support-integration`).',
      '',
      diagSummary,
      '',
      closing,
    ].join('\n');

    const quickReplies: string[] = [];
    if (diagnostic && canEditAny) {
      quickReplies.push('Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại');
    }
    if (canCreateTenant) {
      quickReplies.push(
        diagnostic
          ? 'Tạo mới 1 AI Support trọn gói thay cho tôi'
          : 'Thiết lập tự động trọn gói AI Support thay cho tôi',
      );
    }

    return {
      reply: ensureNonRepetitiveReply([v1, v2], priorAssistantMessages, 'vi'),
      quickReplies,
    };
  }

  const diagSummaryEn = diagnostic
    ? `Right now, **${diagnostic.tenant.name}** has **${diagnostic.completedSteps}/${diagnostic.totalSteps} areas ready**:\n` +
      diagnostic.steps.map((st) => `- ${stepIcon(st.status)} ${st.summaryEn}`).join('\n')
    : 'No tenant is selected yet — I can walk you through any area or draft a complete new setup for you.';

  const closingEn =
    canEditAny || canCreateTenant
      ? 'You do not have to configure all seven screens manually — just tell me a bit about your business (or pick a starter option below), and I will put together a complete preview plan for your approval!'
      : 'Your account currently has **Read-Only** access, so I can walk you through any step clearly without modifying settings.';

  const en1 = [
    'Here is how the **7 building blocks** of a production-ready AI Support assistant fit together:',
    '',
    '- **Persona & Gateway** (`/thruline/support`): Define your brand voice, grounding rules, and default model.',
    '- **Knowledge & Privacy** (`/thruline/support-knowledge`): Seed customer-visible FAQs (`guest` & `customer` roles) and mask emails, phones, and cards.',
    '- **Input Guardrails** (`/thruline/support-guardrails`): Turn on prompt-injection protection, topic filters, and hourly visitor quotas.',
    '- **Output Safety** (`/thruline/support-output`): Enforce outbound secret redaction before replies reach visitors.',
    '- **Chat Widget** (`/thruline/support-desk`): Style brand colors, welcome copy, and helpful starter prompts.',
    '- **SLA & Routing** (`/thruline/support-desk`): Route billing, returns, and technical tickets with clear response targets.',
    '- **CORS & Website Embed** (`/thruline/support-integration`): Lock allowed domains, set token bounds, and copy your `<script>` tag.',
    '',
    diagSummaryEn,
    '',
    closingEn,
  ].join('\n');

  const en2 = [
    'At a glance, setting up your AI Support covers **7 connected areas**: shaping its voice (`/thruline/support`), teaching it your FAQs while masking PII (`/thruline/support-knowledge`), securing input & output guardrails (`/thruline/support-guardrails`, `/thruline/support-output`), styling your widget & ticket routing (`/thruline/support-desk`), and embedding the `<script>` tag on your domain (`/thruline/support-integration`).',
    '',
    diagSummaryEn,
    '',
    closingEn,
  ].join('\n');

  const quickRepliesEn: string[] = [];
  if (diagnostic && canEditAny) {
    quickRepliesEn.push('Auto-complete current tenant with standard defaults');
  }
  if (canCreateTenant) {
    quickRepliesEn.push(
      diagnostic
        ? 'Create a brand-new AI Support setup for me'
        : 'Set up a complete AI Support assistant for me',
    );
  }

  return {
    reply: ensureNonRepetitiveReply([en1, en2], priorAssistantMessages, 'en'),
    quickReplies: quickRepliesEn,
  };
}

/**
 * Core human-like conversational engine for AI Support Setup Copilot.
 * Understands open-domain businesses, answers pushback/hesitation/capability turns with genuine
 * empathy, never dumps numbered intake forms, and guarantees zero repeated replies across turns.
 */
export function buildHumanDialogueTurn(
  params: HumanDialogueTurnParams,
): HumanDialogueTurnResult {
  const {
    messages,
    locale,
    requirements: baseReqs = {},
    diagnostic = null,
    activeTenantName = diagnostic?.tenant.name ?? null,
    targetMode = activeTenantName ? 'update_tenant' : 'create_tenant',
    canCreateTenant = true,
    canEditAny = true,
    hasBaseProposal = false,
  } = params;

  const priorAssistantMessages = messages
    .filter((m) => m.role === 'assistant' && m.content.trim().length > 0)
    .map((m) => m.content);

  const latestUserMessage =
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '';

  const { requirements: extractedRequirements, topic } = enrichRequirementsWithOpenDomain(
    messages,
    baseReqs,
    locale,
  );

  const act = classifyHumanConversationalAct(latestUserMessage, params.currentPath);
  const focusedStepId = act === 'step_question' ? matchSpecificStepQuestion(latestUserMessage) : null;

  const isReadOnly = !canEditAny && !canCreateTenant;
  const topicLabelVi = topic?.shortLabelVi ?? extractedRequirements.industry ?? null;
  const topicLabelEn = topic?.shortLabelEn ?? extractedRequirements.industry ?? null;

  const buildContextualQuickReplies = (): string[] => {
    if (isReadOnly) {
      return locale === 'vi'
        ? [
            'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
            'Giải thích Bước 2 nạp FAQ & che dữ liệu nhạy cảm',
          ]
        : [
            'How do I set up a complete AI Support assistant step by step?',
            'Explain Step 2 Knowledge Base & PII masking',
          ];
    }

    if (topic) {
      return locale === 'vi'
        ? [
            topic.draftChipVi,
            topic.detailExampleChipVi,
            act === 'capability_or_pushback'
              ? 'Chưa có website đâu, cứ lên bản mẫu mặc định trước nhé'
              : 'Bạn có thể làm được những gì cho web của mình?',
          ]
        : [
            topic.draftChipEn,
            topic.detailExampleChipEn,
            act === 'capability_or_pushback'
              ? 'No website yet — draft smart defaults first'
              : 'What can you actually set up for my site?',
          ];
    }

    return locale === 'vi'
      ? [
          ...(activeTenantName && canEditAny
            ? ['Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại']
            : ['Lên luôn một bản mẫu tiêu chuẩn để mình xem thử']),
          'Mình đang có web boardgame, muốn setup trợ lý tư vấn',
          'Shop mỹ phẩm GlowSkin, đổi trả 7 ngày, màu hồng #ec4899, giọng thân thiện',
        ]
      : [
          ...(activeTenantName && canEditAny
            ? ['Auto-complete current tenant with standard defaults']
            : ['Draft a standard starter setup so I can preview it']),
          'I have a boardgame website and want to set up customer support',
          'GlowSkin Skincare shop, 7-day returns, #ec4899 pink, friendly tone',
        ];
  };

  // 0. Identity / permissions — answered ONLY from the server identity record.
  // The deterministic branch in playbook/router normally returns first; this
  // fallback keeps the dialogue layer from ever inventing permissions.
  if (act === 'identity_or_permissions') {
    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply:
        params.identityReply ??
        (locale === 'vi'
          ? 'Mình chỉ trả lời về role và quyền từ hồ sơ hệ thống của tài khoản bạn — bấm chip “Quyền của tôi” ở trên để xem chi tiết, hoặc nhắn lại “Tôi có quyền gì?” nhé.'
          : 'I only answer role and permission questions from your account record — tap the “My permissions” chip above to see the details, or ask me “What are my permissions?” again.'),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 1. Frustration / complaint about stiffness or repetition
  if (act === 'frustration_pushback') {
    const candidatesVi = topic
      ? [
          `Ôi cho mình xin lỗi bạn nhé! 😅 Đọc lại mới thấy mình trả lời hơi máy móc thật. Mình bỏ qua hết mấy câu hỏi thủ tục rườm rà luôn nha — vì mình biết bên bạn đang làm **${topic.shortLabelVi}** rồi, bạn chỉ cần nhắn **"ok"** (hoặc bấm nút bên dưới) là mình dựng ngay bản mẫu hoàn chỉnh có sẵn kịch bản tư vấn cho ${topic.shortLabelVi} để bạn xem trực tiếp luôn!`,
          `Thật sự xin lỗi vì làm bạn thấy khó chịu nha! Mình nói chuyện ngắn gọn, đi thẳng vào việc luôn nhé: bạn muốn mình **tạo luôn bản nháp cấu hình cho ${topic.shortLabelVi}** ngay bây giờ để bạn nhìn tận mắt rồi thích sửa chỗ nào bảo mình chỗ đó không?`,
          `Cảm ơn bạn đã nhắc thẳng nhé, lỗi mình hỏi hơi cứng nhắc! Giờ mình làm gọn thế này nha: mình tự chọn bộ thông số an toàn hợp với **${topic.shortLabelVi}** rồi bày sẵn ra thẻ xem trước cho bạn duyệt — bạn gật đầu **"làm đi"** là có liền nhé!`,
        ]
      : [
          `Ôi cho mình xin lỗi nhé, vừa rồi mình nói chuyện hơi cứng nhắc như điền biểu mẫu thật! 😅 Mình bỏ qua mấy câu hỏi dài dòng luôn nha. Giờ bạn chỉ cần kể ngắn 1 câu bên mình bán hay làm mảng gì (ví dụ: *shop quần áo, quán cafe, web boardgame...*), hoặc nhắn **"lên bản mẫu luôn"** để mình dựng sẵn một bản nháp cho bạn xem trước nhé!`,
          `Xin lỗi bạn nhiều nha, để mình trao đổi tự nhiên và gọn gàng hơn! Thay vì hỏi nhiều thứ cùng lúc, bạn muốn mình **tạo luôn một bản cấu hình mẫu** ngay bây giờ để bạn nhìn trực quan rồi chỉnh dần, hay bạn có 1 điều quan trọng nhất muốn dặn con AI trước?`,
          `Mình rút kinh nghiệm liền, không hỏi kiểu liệt kê máy móc nữa nhé! Bạn cứ nói tự nhiên bất cứ ý nào bạn muốn, hoặc gõ **"ok"** để mình bày luôn bản nháp mặc định ra màn hình cho bạn tiện duyệt nha.`,
        ];

    const candidatesEn = topic
      ? [
          `I'm really sorry about that — you're right, that sounded way too stiff! 😅 Let's skip the questionnaire completely. Since I already know you're running a **${topic.shortLabelEn}**, just say **"ok"** (or tap below) and I'll put together a tailored draft plan right now so you can review it visually!`,
          `Fair point, my bad for sounding robotic! Let's keep this super easy: want me to go ahead and generate a ready-to-review setup draft for your **${topic.shortLabelEn}** right now, and we can tweak anything you want from there?`,
          `Apologies for the rigid tone earlier! No more checklists — say **"go ahead"** anytime and I'll draft a clean starter setup for your **${topic.shortLabelEn}** with zero changes applied until you approve.`,
        ]
      : [
          `I'm really sorry — you're totally right, nobody likes being handed a stiff checklist! 😅 Let's keep this relaxed: just tell me in plain words what kind of shop or project you run, or say **"draft it"** and I'll spin up a clean starter plan right away so you have something concrete to look at!`,
          `My apologies for sounding like a form! Instead of asking a bunch of questions, would you like me to generate a starter draft right now that you can tweak visually, or just share the one thing your customers ask most?`,
          `Point taken — dropping the rigid questions right away! Tell me anything about your site in one casual line, or reply **"ok"** and I'll put a safe preview plan in front of you immediately.`,
        ];

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? candidatesVi : candidatesEn,
        priorAssistantMessages,
        locale,
        locale === 'vi' ? (topicLabelVi ?? undefined) : (topicLabelEn ?? undefined),
      ),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 2. Capability / skepticism / language switch ("bạn có thể làm gì mà", "bạn có thể nói tiếng việt không", "what can you actually do")
  if (act === 'capability_or_pushback') {
    const asksVietnameseExplicitly =
      /tiếng\s*việt|tieng\s*viet|vietnamese/i.test(latestUserMessage);

    const tenantSentenceVi = diagnostic
      ? `Hiện trên **${diagnostic.tenant.name}** đang sẵn sàng **${diagnostic.completedSteps}/${diagnostic.totalSteps} hạng mục**.`
      : '';
    const tenantSentenceEn = diagnostic
      ? `Right now **${diagnostic.tenant.name}** has **${diagnostic.completedSteps}/${diagnostic.totalSteps} areas** configured.`
      : '';

    const candidatesVi = asksVietnameseExplicitly
      ? [
          [
            'Dạ hoàn toàn được ạ — mình trao đổi bằng **tiếng Việt** tự nhiên 100% nhé! 😊',
            '',
            `Mình là người đồng hành giúp bạn dựng trợ lý AI chăm sóc khách hàng trên web mà không phải tự mò từng mục kỹ thuật. ${tenantSentenceVi}`.trim(),
            canEditAny || canCreateTenant
              ? 'Bạn chỉ cần kể nhẹ về shop/dịch vụ của mình (hoặc chọn dùng cấu hình tiêu chuẩn bên dưới), mình sẽ soạn sẵn lời hướng dẫn cho AI, bộ câu hỏi thường gặp, lớp che SĐT/email và màu khung chat rồi trình bạn xem trước — khi nào bạn bấm **Đồng ý** mới áp dụng nhé!'
              : 'Bất cứ mục nào trong 7 bước cấu hình bạn muốn tìm hiểu, cứ hỏi tự nhiên để mình giải thích rõ ràng nhé!',
          ].join('\n'),
          `Tất nhiên rồi ạ, mình nói **tiếng Việt** suốt buổi với bạn nha! Bạn muốn mình tự lên bản nháp cấu hình AI trực web trọn gói cho bên bạn duyệt, hay muốn mình giải thích nhanh từng phần trước?`,
        ]
      : topic
        ? [
            [
              `À mình giải thích ngắn gọn ngay nhé! 😊 Với **${topic.shortLabelVi}** của bạn, thay vì bạn phải tự ngồi viết câu lệnh hay mò từng trang cài đặt, mình có thể chuẩn bị sẵn trọn gói giúp bạn:`,
              `- Soạn hướng dẫn để con AI biết tư vấn tự nhiên đúng mảng **${topic.industryVi}** (như ${topic.customerScenariosVi[0]} hay ${topic.customerScenariosVi[1]}) kèm bộ bài FAQ vận chuyển/đổi trả.`,
              '- Bật sẵn lớp bảo vệ tự che SĐT/email khách hàng, chống tin nhắn phá rối, phối màu khung chat nổi trên web và chia luồng khi khách cần gặp nhân viên thật.',
              '',
              'Mọi thứ mình đều **bày ra bản nháp để bạn xem trước**, tuyệt đối chưa đụng gì vào hệ thống cho tới khi bạn ưng ý bấm duyệt. Bạn muốn mình lên thử luôn bản mẫu cho **' +
                topic.shortLabelVi +
                '** để nhìn tận mắt không?',
            ].join('\n'),
            [
              `Mình đóng vai trò như một chuyên viên setup đứng cạnh phụ bạn từ A–Z cho **${topic.shortLabelVi}** đó! Cụ thể là mình viết sẵn nhân cách tư vấn, nạp câu hỏi mẫu khách hay thắc mắc, bật lọc bảo mật thông tin và chỉnh luôn khung chat nhúng web.`,
              '',
              `Bạn không cần điền biểu mẫu dài đâu — chỉ cần nhắn **"ok lên bản mẫu đi"** là mình tạo ngay một phương án hoàn chỉnh để bạn duyệt thử, ưng chỗ nào giữ chỗ đó, chưa ưng mình sửa lại liền nha!`,
            ].join('\n'),
          ]
        : [
            [
              `À để mình kể ngắn gọn những việc mình đỡ đần được cho bạn nhé! 😊 Mình giúp bạn dựng một **trợ lý AI trực website/cửa hàng** từ đầu đến cuối mà không cần rành kỹ thuật:`,
              canEditAny || canCreateTenant
                ? `- Bạn chỉ cần nói qua bên mình bán hay làm dịch vụ gì, mình sẽ tự viết lời dặn dò nhân cách cho AI, soạn sẵn kho câu hỏi thường gặp (FAQ), bật chế độ tự che SĐT/email khách, chỉnh màu khung chat và phân luồng hỗ trợ.\n- Quan trọng nhất là mình luôn trình **bản nháp rõ ràng để bạn duyệt trước** — bạn gật đầu xác nhận thì hệ thống mới cài đặt. ${tenantSentenceVi}`.trim()
                : `- Mình giúp bạn kiểm tra tiến độ cấu hình và giải thích cặn kẽ cách vận hành của từng bước một cách dễ hiểu nhất. ${tenantSentenceVi}`.trim(),
              '',
              canEditAny || canCreateTenant
                ? 'Bên bạn đang làm mảng sản phẩm hay dịch vụ gì để mình gợi ý thử kịch bản sát nhất cho bạn xem nhé?'
                : 'Bạn đang muốn xem chi tiết phần nào trước để mình hướng dẫn nha?',
            ].join('\n'),
            [
              `Hiểu nôm na thì mình là người phụ trách khâu "dựng kịch bản & cài đặt kỹ thuật" thay cho bạn đó! Từ việc dạy AI cách ăn nói lịch sự, nạp bảng giá/chính sách đổi trả, chặn lộ thông tin nhạy cảm cho tới làm đẹp nút chat trên web — mình gom lại thành 1 bản nháp gọn gàng để bạn duyệt trong 1 lần bấm.`,
              '',
              'Bạn muốn kể qua về web/shop của mình, hay để mình tạo thử một bản mẫu tiêu chuẩn ngay cho bạn dễ hình dung?',
            ].join('\n'),
          ];

    const candidatesEn = topic
      ? [
          [
            `Great question — let me make it super concrete! 😊 For your **${topic.shortLabelEn}**, instead of making you dig through seven separate settings screens, I can draft the entire AI support setup for you:`,
            `- Shape an authentic support persona and starter FAQs tailored to **${topic.industryEn}** (like ${topic.customerScenariosEn[0]} and ${topic.customerScenariosEn[1]}).`,
            '- Configure privacy masking for customer emails/phones, prompt-injection safety, widget colors & quick prompts, plus human ticket routing.',
            '',
            `Everything appears as a **safe preview draft first** — nothing touches your live configuration until you click Approve. Want me to put together that starter draft for your **${topic.shortLabelEn}** right now?`,
          ].join('\n'),
          `Think of me as your hands-on onboarding specialist for your **${topic.shortLabelEn}**! I can draft your AI's system prompt, customer FAQs, privacy/security guardrails, and chat widget styling in one go — all staged safely for your review before anything goes live. Just say **"draft it"** if you'd like to see it!`,
        ]
      : [
          [
            `Happy to explain! 😊 Think of me as your hands-on onboarding teammate — I help you launch a complete customer-support AI without wrestling with technical settings yourself. ${tenantSentenceEn}`.trim(),
            canEditAny || canCreateTenant
              ? '- Tell me a bit about what your business or site does, and I will draft your AI persona, starter FAQs, PII privacy masking, safety guardrails, chat widget styling, and ticket routing in one clean preview card — nothing changes until you approve.\n- Or ask me about any part of the setup in plain language and I will walk you through it!'
              : '- Ask me about any of the 7 setup areas and I will walk you through how everything works clearly.',
          ].join('\n'),
          `In short, I take the heavy lifting out of configuring AI customer support! Share a sentence about your shop or project (or ask for smart defaults), and I'll assemble a tailored draft covering prompts, FAQs, privacy protection, and widget design for you to review safely before anything goes live.`,
        ];

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? candidatesVi : candidatesEn,
        priorAssistantMessages,
        locale,
        locale === 'vi' ? (topicLabelVi ?? undefined) : (topicLabelEn ?? undefined),
      ),
      missingQuestions: [],
      suggestedQuickReplies:
        asksVietnameseExplicitly && locale === 'vi'
          ? [
              ...(diagnostic && canEditAny
                ? ['Hoàn thiện cấu hình tiêu chuẩn cho tenant hiện tại']
                : canCreateTenant
                  ? ['Tạo mới 1 AI Support trọn gói thay cho tôi']
                  : []),
              'Hướng dẫn chi tiết 7 bước setup',
              ...(canEditAny
                ? ['Shop mỹ phẩm GlowSkin, đổi trả 7 ngày, màu hồng #ec4899, giọng thân thiện']
                : []),
            ]
          : buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 3. Hesitation / beginner asking for gentle advice ("tư vấn giúp mình", "chưa biết bắt đầu từ đâu", "không rành kỹ thuật")
  if (act === 'hesitation_or_advice') {
    const candidatesVi = topic
      ? [
          [
            `Bạn cứ yên tâm hoàn toàn nha, không cần rành kỹ thuật hay biết viết câu lệnh gì hết — phần đó mình lo trọn cho bạn! 🤝`,
            '',
            `Vì mình đã nắm được bên bạn làm **${topic.shortLabelVi}** rồi, cách nhẹ đầu nhất là **mình dựng luôn một bản mẫu hoàn chỉnh** ngay bây giờ (có sẵn lời chào thân thiện, kịch bản ${topic.customerScenariosVi[0]} và cấu hình bảo mật chuẩn). Khi bản nháp hiện ra, bạn nhìn vào đó thấy chỗ nào muốn đổi tên hay sửa ý chỉ cần nhắn mình một câu thôi. Mình lên bản mẫu luôn cho bạn xem nhé?`,
          ].join('\n'),
          `Đừng áp lực chuyện kỹ thuật nhé! Với **${topic.shortLabelVi}**, kinh nghiệm của mình là cứ lên khung sườn chạy mượt trước (tư vấn chọn sản phẩm + giải đáp ship/đổi trả + khung chat gọn đẹp), rồi mình tinh chỉnh dần sau. Bạn bấm nút **"${topic.draftChipVi}"** bên dưới hoặc nhắn **"ok"** để mình bày bản nháp ra cho bạn dễ hình dung nha!`,
        ]
      : [
          [
            `Bạn yên tâm nha, bạn không cần rành công nghệ hay chuẩn bị tài liệu dài dòng gì đâu — cứ coi mình như người phụ việc cùng bạn thôi! 😊`,
            '',
            'Để bắt đầu nhẹ nhàng nhất, mình gợi ý 2 cách cực dễ:',
            '- **Cách 1 (Sát thực tế nhất):** Bạn nhắn cho mình 1 câu tự nhiên bên mình đang bán hàng hay làm dịch vụ gì (ví dụ: *quán cà phê, web boardgame, shop quần áo, khóa học tiếng Trung...*), mình sẽ tự nghĩ kịch bản khách hay hỏi cho đúng ngành đó.',
            '- **Cách 2 (Xem hình hài trước):** Bạn bấm nút lên bản mẫu tiêu chuẩn bên dưới để mình tạo sẵn một bản nháp — nhìn thấy tận mắt rồi mình chỉnh tên với màu sắc sau sẽ dễ hơn rất nhiều!',
          ].join('\n'),
          `Mới làm lần đầu thấy hơi ngợp là bình thường lắm bạn ơi! Mẹo dễ nhất là đừng cố nghĩ đủ mọi chính sách ngay từ đầu — bạn chỉ cần cho mình biết **mảng kinh doanh hoặc tên shop** của bạn thôi, toàn bộ phần lời chào, bảo mật và giao diện chat mình sẽ tự phối sẵn bản nháp an toàn để bạn xem qua trước nhé!`,
        ];

    const candidatesEn = topic
      ? [
          `No technical background needed at all — I've got the setup details covered for you! 🤝 Since you're building support for your **${topic.shortLabelEn}**, the easiest way to start is letting me put together a tailored starter draft right now (already tuned for ${topic.customerScenariosEn[0]}). Once you see it on screen, tweaking names, colors, or policies is effortless. Shall I draft it for you now?`,
          `Don't sweat the technical side! Because I already know your project is a **${topic.shortLabelEn}**, just reply **"ok"** (or tap below) and I'll lay out a complete preview plan with sensible defaults — nothing goes live until you're happy with it.`,
        ]
      : [
          [
            `No worries at all — you don't need any technical experience here! 😊 Let's take the easiest path:`,
            '- **Tell me in plain words** what kind of website, shop, or service you run (for instance: *a boardgame store, an acoustic cafe, an online course...*), and I will tailor practical customer scenarios around it.',
            '- **Or preview a starter draft right away** using the quick button below — seeing a working draft first makes it much easier to decide what you want to tweak!',
          ].join('\n'),
          `Totally normal not to know where to start! You don't need a big document ready — just share one casual line about what your business offers, or say **"draft it"** so I can show you a clean starter plan that we can refine together.`,
        ];

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? candidatesVi : candidatesEn,
        priorAssistantMessages,
        locale,
        locale === 'vi' ? (topicLabelVi ?? undefined) : (topicLabelEn ?? undefined),
      ),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 3B. Reassurance when user says they don't have a website yet ("chưa có website đâu", "mới bán trên Facebook")
  if (act === 'no_website_reassurance') {
    const reqsWithOpenOrigin: SupportSetupRequirements = {
      ...extractedRequirements,
      websiteOrigin: extractedRequirements.websiteOrigin || '*',
    };

    const noWebVi = topic
      ? [
          `Chưa có website cũng không sao hết bạn ơi! 😊 Mình vẫn dựng sẵn bộ trợ lý AI cho **${topic.shortLabelVi}** để bạn test thử hội thoại ngay trong màn hình quản trị trước được luôn — mai mốt có web riêng chỉ việc copy đúng 1 dòng mã nhúng dán vào sau thôi. Bạn muốn nhắn thêm tên shop/quy định đổi trả, hay gõ **"ok lên kế hoạch luôn đi"** để mình tạo bản nháp ngay bây giờ?`,
          `Hoàn toàn thoải mái nha! Chưa có domain riêng thì mình để tạm chế độ mở thử nghiệm cho **${topic.shortLabelVi}** trước, chừng nào làm web xong khóa tên miền lại sau 1 giây là xong. Mình lên bản kế hoạch mẫu luôn cho bạn xem nhé?`,
        ]
      : [
          'Chưa có website cũng không sao đâu bạn ơi! 😊 Hệ thống vẫn khởi tạo sẵn trợ lý AI để bạn chat thử và rèn kịch bản trực tiếp ngay trên bảng điều khiển — sau này có web chỉ cần dán 1 dòng mã `<script>` vào là chạy liền. Bạn muốn kể nhẹ mảng kinh doanh của mình trước, hay nhắn **"ok lên kế hoạch luôn đi"** để mình dựng bản mẫu ngay?',
          'Không cần có sẵn website mới làm được đâu nha! Mình có thể tạo trước cấu hình thử nghiệm để bạn dùng ngay trong trang quản trị, bao giờ có tên miền chính thức mình cập nhật sau rất dễ. Bạn bấm nút bên dưới hoặc nhắn **"ok"** để mình lên bản nháp luôn nhé!',
        ];

    const noWebEn = topic
      ? [
          `Not having a website yet is totally fine! 😊 We can set up your **${topic.shortLabelEn}** assistant right now so you can test and refine conversations directly inside the dashboard — and whenever your site goes live later, pasting the 1-line embed snippet takes seconds. Want to share a shop name first, or say **"ok generate the plan"** so I can draft it right away?`,
          `No problem at all! We can leave domain restrictions open for testing your **${topic.shortLabelEn}** assistant now and lock it to your live domain later anytime. Shall I go ahead and draft the starter plan?`,
        ]
      : [
          'No website yet? Totally fine! 😊 You can build and test your AI Support assistant directly in the workspace playground first, then drop the 1-line `<script>` snippet onto your site whenever you launch. Want to tell me what kind of business you run, or reply **"ok draft it"** to preview smart defaults right away?',
          `You don't need a live domain to get started! I can stage a ready-to-test setup now and you can bind your website domain anytime later. Just say **"ok"** whenever you'd like me to generate the preview plan!`,
        ];

    return {
      act,
      intent: 'gather_requirements',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? noWebVi : noWebEn,
        priorAssistantMessages,
        locale,
        locale === 'vi' ? (topicLabelVi ?? undefined) : (topicLabelEn ?? undefined),
      ),
      missingQuestions: buildMissingHintList(
        locale,
        reqsWithOpenOrigin,
        Boolean(activeTenantName),
         Boolean(topic || reqsWithOpenOrigin.industry),
      ),
      suggestedQuickReplies: topic
        ? locale === 'vi'
          ? ['Ok lên kế hoạch luôn đi', topic.detailExampleChipVi]
          : ['Ok generate the plan now', topic.detailExampleChipEn]
        : locale === 'vi'
          ? ['Ok lên kế hoạch luôn đi', 'Mình đang có web boardgame, muốn setup']
          : ['Ok generate the plan now', 'I run a boardgame shop and want to set up support'],
      extractedRequirements: reqsWithOpenOrigin,
      topic,
    };
  }

  // 4. Greeting & Thanks
  if (act === 'greeting') {
    const tenantLineVi = diagnostic
      ? `Mình thấy bạn đang mở tenant **${diagnostic.tenant.name}** (hiện đã hoàn thiện **${diagnostic.completedSteps}/${diagnostic.totalSteps} mục**). `
      : '';
    const tenantLineEn = diagnostic
      ? `I see you have **${diagnostic.tenant.name}** open (**${diagnostic.completedSteps}/${diagnostic.totalSteps} steps** ready). `
      : '';

    const greetVi = [
      `Chào bạn! 👋 Rất vui được đồng hành cùng bạn hôm nay. ${tenantLineVi}${
        canEditAny || canCreateTenant
          ? 'Bên mình đang làm web hay kinh doanh mảng gì thế? Bạn cứ kể tự nhiên để mình thiết kế giúp bộ trợ lý AI vừa vặn nhất, hoặc bảo mình hướng dẫn từng bước đều được nha!'
          : 'Bạn muốn mình giải thích chi tiết phần nào trong hệ thống AI Support hôm nay nhé?'
      }`,
      `Xin chào bạn nha! 😊 ${tenantLineVi}${
        canEditAny || canCreateTenant
          ? 'Hôm nay bạn muốn mình lên sẵn một bản nháp cấu hình AI trực web cho dự án của bạn duyệt thử, hay cùng điểm qua cách hoạt động trước?'
          : 'Cần mình giải đáp mục cấu hình nào bạn cứ nhắn tự nhiên nhé!'
      }`,
    ];

    const greetEn = [
      `Hello! 👋 Great to have you here. ${tenantLineEn}${
        canEditAny || canCreateTenant
          ? 'What kind of website, shop, or service are you setting up support for today? Share a quick note in your own words and I can tailor a draft plan for you — or walk you through any step!'
          : 'Which part of the AI Support setup would you like me to walk you through today?'
      }`,
      `Hi there! 😊 ${tenantLineEn}${
        canEditAny || canCreateTenant
          ? 'Would you like to tell me a little about your project so I can draft a tailored AI support plan for your review, or explore how the setup works first?'
          : 'Let me know which setup area you are curious about!'
      }`,
    ];

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? greetVi : greetEn,
        priorAssistantMessages,
        locale,
      ),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  if (act === 'thanks') {
    const thanksVi = [
      'Không có chi đâu bạn ơi, rất vui được phụ bạn một tay! 😊 Bất cứ lúc nào bạn muốn đổi màu khung chat, sửa lời chào, thêm câu hỏi thường gặp hay kiểm tra mã nhúng web thì cứ ới mình nhé.',
      'Dạ rất vui vì hỗ trợ được bạn nha! Cần tinh chỉnh thêm chi tiết nhỏ nào cho con AI mượt hơn nữa bạn cứ nhắn mình bất cứ lúc nào nhé.',
    ];
    const thanksEn = [
      'Anytime — glad I could help! 😊 Whenever you want to tweak widget colors, refine your greeting, add FAQs, or check your website embed snippet, just let me know.',
      'Happy to help! Feel free to ping me anytime if you want to adjust your assistant’s tone, policies, or widget design.',
    ];

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? thanksVi : thanksEn,
        priorAssistantMessages,
        locale,
      ),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies().slice(0, 2),
      extractedRequirements,
      topic,
    };
  }

  // 5A. Platform / website / current-page / feature expertise ("web này làm gì?", "trang này dùng để làm gì?", "what does this website do?")
  if (act === 'platform_guide') {
    const platformMatch = matchPlatformKnowledgeQuestion(latestUserMessage, params.currentPath);
    if (platformMatch) {
      const expert = buildPlatformExpertReply({
        match: platformMatch,
        locale,
        currentPath: params.currentPath,
        diagnostic,
        canCreateTenant,
        canEditAny,
        priorAssistantMessages,
      });
      return {
        act,
        intent: 'guide',
        shouldProposeNow: false,
        focusedStepId: null,
        reply: expert.reply,
        missingQuestions: [],
        suggestedQuickReplies: expert.suggestedQuickReplies,
        extractedRequirements,
        topic,
      };
    }
  }

  // 5. Focused single-step question
  if (act === 'step_question' && focusedStepId) {
    const stepVariants = STEP_WARM_EXPLANATIONS[focusedStepId];
    const diagStep = diagnostic?.steps.find((s) => s.stepId === focusedStepId);
    const liveNoteVi =
      diagStep && diagStep.canView !== false
        ? `\n\n*(Hiện tại trên **${diagnostic!.tenant.name}**: ${diagStep.summaryVi})*`
        : '';
    const liveNoteEn =
      diagStep && diagStep.canView !== false
        ? `\n\n*(Current status on **${diagnostic!.tenant.name}**: ${diagStep.summaryEn})*`
        : '';

    const rawCandidates = locale === 'vi' ? stepVariants.vi : stepVariants.en;
    const decorated = rawCandidates.map((c) => `${c}${locale === 'vi' ? liveNoteVi : liveNoteEn}`);

    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId,
      reply: ensureNonRepetitiveReply(decorated, priorAssistantMessages, locale),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 6. Full 7-step roadmap guide question
  if (act === 'roadmap_guide') {
    const guide = buildWarmRoadmapGuide({
      locale,
      diagnostic,
      canCreateTenant,
      canEditAny,
      priorAssistantMessages,
    });
    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: guide.reply,
      missingQuestions: [],
      suggestedQuickReplies: guide.quickReplies,
      extractedRequirements,
      topic,
    };
  }

  // Read-only guard: never propose or interrogate for auto-setup if user has zero write permissions
  if (isReadOnly) {
    const roVi = [
      'Tài khoản hiện tại của bạn đang ở chế độ **Chỉ xem (Read-Only)** trên tenant này nên mình sẽ không tạo bản đề xuất thay đổi cấu hình vượt quyền — tuy nhiên bạn cần mình giải thích cách hoạt động của bất kỳ bước nào trong 7 bước AI Support thì cứ hỏi thoải mái nhé!',
      'Do tài khoản của bạn đang được phân quyền **Chỉ xem (Read-Only)**, hệ thống giữ nguyên an toàn mọi cài đặt hiện có. Bạn muốn mình hướng dẫn chi tiết phần nào để tiện trao đổi lại với quản trị viên không?',
    ];
    const roEn = [
      'Your account currently has **Read-Only** access on this tenant, so I cannot generate or apply configuration changes — however, I am happy to explain any of the 7 AI Support setup areas in detail!',
      'Because your role on this tenant is **Read-Only**, live settings remain locked. Let me know if you would like a clear walkthrough of any setup step!',
    ];
    return {
      act,
      intent: 'guide',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(locale === 'vi' ? roVi : roEn, priorAssistantMessages, locale),
      missingQuestions: [],
      suggestedQuickReplies: buildContextualQuickReplies(),
      extractedRequirements,
      topic,
    };
  }

  // 7. Affirmation to proceed ("ok", "ừ", "làm đi", "lên kế hoạch luôn đi", "dùng mặc định")
  // OR rich concrete details provided OR second+ discovery turn where user already answered a follow-up
  const concreteSignals = countConcreteRequirementSignals(extractedRequirements, topic);
  const priorDiscoveryCount = countPriorDiscoveryPrompts(messages);

  const hasRichMultiFieldContext =
    targetMode === 'update_tenant' && activeTenantName
      ? concreteSignals >= 3 ||
        (concreteSignals >= 2 &&
          Boolean(
            extractedRequirements.faqSummaryOrPolicies ||
              extractedRequirements.websiteOrigin ||
              extractedRequirements.brandName ||
              extractedRequirements.primaryColor,
          ))
      : Boolean(
          extractedRequirements.brandName &&
            concreteSignals >= 2 &&
            (extractedRequirements.industry ||
              topic ||
              extractedRequirements.faqSummaryOrPolicies ||
              extractedRequirements.websiteOrigin ||
              extractedRequirements.primaryColor ||
              extractedRequirements.tone),
        );

  const hasProgressedAfterDiscovery =
    priorDiscoveryCount >= 1 &&
    (concreteSignals >= 2 ||
      Boolean(
        extractedRequirements.brandName ||
          extractedRequirements.faqSummaryOrPolicies ||
          extractedRequirements.websiteOrigin ||
          extractedRequirements.primaryColor ||
          extractedRequirements.tone,
      ));

  const shouldProposeNow =
    hasBaseProposal ||
    act === 'affirmation_proceed' ||
    hasRichMultiFieldContext ||
    hasProgressedAfterDiscovery;

  if (shouldProposeNow) {
    const targetDisplayName =
      extractedRequirements.brandName ||
      activeTenantName ||
      (topic ? capitalizeFirst(locale === 'vi' ? topic.shortLabelVi : topic.shortLabelEn) : null) ||
      (locale === 'vi' ? 'dự án của bạn' : 'your workspace');

    const readyIntroVi = [
      `Tuyệt vời, mình lên ngay bản nháp cấu hình cho **${targetDisplayName}** để bạn xem và duyệt bên dưới nhé!`,
      `Ok bạn ơi, mình bắt tay phác thảo ngay phương án trọn gói cho **${targetDisplayName}** ở thẻ bên dưới nha!`,
    ];
    const readyIntroEn = [
      `Awesome — putting together a complete setup draft for **${targetDisplayName}** right below for your review!`,
      `Got it! I have prepared a tailored preview plan for **${targetDisplayName}** right below.`,
    ];

    return {
      act,
      intent: 'propose_setup',
      shouldProposeNow: true,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? readyIntroVi : readyIntroEn,
        priorAssistantMessages,
        locale,
        targetDisplayName,
      ),
      missingQuestions: [],
      suggestedQuickReplies:
        locale === 'vi'
          ? ['Đổi màu sang xanh dương #2563eb', 'Yêu cầu khách nhập email trước khi chat']
          : ['Switch primary color to #2563eb', 'Require customer email intake before chat'],
      extractedRequirements,
      topic,
    };
  }

  // 8. Warm, human-consultant discovery conversation (ZERO numbered checklists!)
  const hasKnownTopicOrIndustry = Boolean(topic || extractedRequirements.industry);
  const missingQuestions = buildMissingHintList(
    locale,
    extractedRequirements,
    Boolean(activeTenantName),
    hasKnownTopicOrIndustry,
  );

  // Case 8A: User shared their specific domain/topic (e.g. "tôi đang có web boardgame, và muốn setup")!
  if (topic) {
    const [sc1Vi, sc2Vi, sc3Vi] = topic.customerScenariosVi;
    const [sc1En, sc2En, sc3En] = topic.customerScenariosEn;
    const brandNoteVi = extractedRequirements.brandName
      ? `cho **${extractedRequirements.brandName}** (${topic.shortLabelVi})`
      : `cho **${topic.shortLabelVi}** của bạn`;
    const brandNoteEn = extractedRequirements.brandName
      ? `for **${extractedRequirements.brandName}** (${topic.shortLabelEn})`
      : `for your **${topic.shortLabelEn}**`;

    const domainDiscoveryVi = [
      [
        `Ồ làm **${topic.shortLabelVi}** hay quá bạn ơi! 🙌 Với mảng này, khách ghé vào thường sẽ hỏi nhiều nhất những tình huống rất thực tế như: ${sc1Vi}; ${sc2Vi}; hoặc ${sc3Vi}.`,
        '',
        extractedRequirements.brandName
          ? `Bạn muốn dặn thêm **quy định ship / đổi trả cơ bản** (hoặc tông màu khung chat bạn thích) để mình đưa thẳng vào bài FAQ ${brandNoteVi}, hay để mình **lên luôn một bản mẫu hoàn chỉnh** ngay bây giờ cho bạn xem thử trước?`
          : `Bạn muốn nhắn thêm cho mình **tên thương hiệu/shop** cùng **chính sách ship hoặc đổi trả cơ bản** để mình đưa vào tài liệu cho thật sát, hay muốn mình **dựng luôn bản mẫu trợ lý AI** ${brandNoteVi} ngay bây giờ để bạn xem trực quan trước?`,
      ].join('\n'),
      [
        `Nghe tới **${topic.shortLabelVi}** là mình hình dung ra ngay mấy câu khách hay nhắn hỏi nhất rồi — từ chuyện ${sc1Vi} cho tới ${sc3Vi}.`,
        '',
        `Để đỡ mất thời gian của bạn, mình có thể **phác thảo luôn bản cấu hình mẫu** hợp gu ${topic.shortLabelVi} để bạn duyệt thử ngay (chỉ cần nhắn **"ok"** hoặc bấm nút bên dưới), hoặc nếu đã có sẵn **tên shop** và vài dòng quy định riêng thì bạn chia sẻ nhẹ để mình gài vào luôn nhé!`,
      ].join('\n'),
      [
        `Mình nắm được ý tưởng **${topic.shortLabelVi}** của bạn rồi nhé! Thay vì bắt bạn ngồi liệt kê đủ thứ, bạn xem mình tạo trước một bản nháp sẵn sàng xử lý các ca như *${sc1Vi}* luôn nha — hay bạn muốn chọn tông màu với tên gọi riêng cho trợ lý trước?`,
      ].join('\n'),
    ];

    const domainDiscoveryEn = [
      [
        `Oh, setting up support ${brandNoteEn} sounds awesome! 🙌 Visitors there usually reach out with practical questions like ${sc1En}, ${sc2En}, and ${sc3En}.`,
        '',
        extractedRequirements.brandName
          ? `Would you like to share a quick note on your **shipping or return policy** (or preferred widget color) first, or should I **draft a complete starter setup** ${brandNoteEn} right now so you can review and tweak it?`
          : `Would you like to drop in your **brand/shop name** and any basic **shipping or return rule** first, or let me **spin up a ready-to-review setup plan** ${brandNoteEn} right away?`,
      ].join('\n'),
      [
        `Got it — for a **${topic.shortLabelEn}**, customers love getting fast answers around ${sc1En} as well as ${sc3En}.`,
        '',
        `To keep things effortless, just say **"ok"** (or tap below) and I'll generate a tailored preview plan right now, or share your shop name and one policy detail if you want them baked in from the start!`,
      ].join('\n'),
      [
        `Love the **${topic.shortLabelEn}** focus! Rather than handing you a long form, I can draft a tailored configuration right away with sensible defaults — just reply **"draft it"** whenever you're ready, or tell me your brand name and tone preference first.`,
      ].join('\n'),
    ];

    return {
      act,
      intent: 'gather_requirements',
      shouldProposeNow: false,
      focusedStepId: null,
      reply: ensureNonRepetitiveReply(
        locale === 'vi' ? domainDiscoveryVi : domainDiscoveryEn,
        priorAssistantMessages,
        locale,
        locale === 'vi' ? topic.shortLabelVi : topic.shortLabelEn,
      ),
      missingQuestions,
      suggestedQuickReplies: [
        locale === 'vi' ? topic.draftChipVi : topic.draftChipEn,
        locale === 'vi' ? topic.detailExampleChipVi : topic.detailExampleChipEn,
        locale === 'vi'
          ? 'Chưa có website đâu, cứ lên bản mẫu mặc định trước nhé'
          : 'No website yet — draft smart defaults first',
      ],
      extractedRequirements,
      topic,
    };
  }

  // Case 8B: Generic setup request or open vague turn where we don't know their domain yet
  // Progressive, empathetic human conversation across multiple turns (never repeats!)
  const tenantContextVi = activeTenantName ? ` cho **${activeTenantName}**` : '';
  const tenantContextEn = activeTenantName ? ` for **${activeTenantName}**` : '';

  const genericDiscoveryVi = [
    [
      `Mình rất sẵn lòng phụ bạn dựng trọn bộ trợ lý AI${tenantContextVi} nhé! 😊 Để lời chào và kho câu trả lời mẫu nghe tự nhiên, đúng chất riêng của bên bạn nhất (thay vì câu chữ chung chung), bạn kể nhẹ cho mình nghe **bên mình đang bán sản phẩm hay làm dịch vụ gì** và **tên thương hiệu** là gì nha?`,
      '',
      'Nếu có sẵn quy định đổi trả hay phí ship thì bạn nhắn kèm luôn, còn chưa nghĩ ra ngay thì chỉ cần gõ **"lên bản mẫu mặc định"** là mình tạo sẵn một phương án chuẩn để bạn xem trước liền!',
    ].join('\n'),
    [
      `Bạn cứ chia sẻ thoải mái một câu ngắn thôi cũng được nha — ví dụ như *"mình mở quán cà phê acoustic"*, *"web bán boardgame"*, hay *"shop thời trang local brand, đổi trả 7 ngày"*. Có chút ngữ cảnh đó là mình thiết kế câu chữ cho con AI sát thực tế lắm!`,
      '',
      `Còn nếu bạn muốn xem thử giao diện và bản kế hoạch trông như thế nào ngay lập tức thì nhắn **"ok làm bản mẫu đi"**, mình bày ra màn hình liền cho bạn duyệt nhé.`,
    ].join('\n'),
    [
      `Mình hiểu đôi khi ngồi nghĩ thông tin từ đầu hơi mất công! Hay mình làm ngược lại cho nhàn nhé: để mình **tạo trước một bản nháp tiêu chuẩn an toàn**${tenantContextVi} (chưa áp dụng thật vào hệ thống đâu), rồi bạn nhìn vào bản nháp đó muốn đổi tên, màu sắc hay câu hỏi nào chỉ việc bảo mình sửa lại thôi. Bạn thấy sao, mình lên bản nháp luôn nha?`,
    ].join('\n'),
    [
      `Bất cứ lúc nào bạn muốn xem bản xem trước (hoàn toàn miễn phí rủi ro vì phải bấm xác nhận mới chạy thật), chỉ cần nhắn gọn **"ok"** hoặc chọn một gợi ý bên dưới là mình chuẩn bị xong ngay cho bạn nhé!`,
    ].join('\n'),
    [
      `Mình vẫn ở đây chờ ý của bạn nha! Dù bạn chỉ có mỗi ý tưởng sơ bộ trong đầu hay muốn thử nghiệm nhanh bằng cấu hình mẫu${tenantContextVi}, gõ **"triển luôn"** là mình soạn sẵn thẻ kế hoạch chi tiết để bạn thong thả kiểm tra từng mục.`,
    ].join('\n'),
  ];

  const genericDiscoveryEn = [
    [
      `I'd love to help set up your AI Support assistant${tenantContextEn}! 😊 So the greeting and starter FAQs sound genuinely tailored to your customers rather than generic boilerplate, what kind of **products, services, or website** are you running (and what **brand name** should it use)?`,
      '',
      'Feel free to toss in any basic return or shipping rule in the same message — or just say **"use defaults"** if you want me to draft a clean starter plan right away!',
    ].join('\n'),
    [
      `Even a super casual one-liner works great — like *"an acoustic coffee shop"*, *"a boardgame website"*, or *"sneaker store with 7-day exchanges"*. That little bit of context lets me write scenarios your visitors actually ask about!`,
      '',
      `Or if you'd rather see a concrete draft first and tweak later, just reply **"ok draft it"** and I'll put one together immediately.`,
    ].join('\n'),
    [
      `Sometimes starting from a blank page is annoying — want to flip it around? I can **spin up a safe, ready-to-review starter plan**${tenantContextEn} right now (nothing goes live without your approval), and once you see it, you can tell me any name, color, or policy tweaks in plain English. Sound good?`,
    ].join('\n'),
    [
      `Whenever you'd like to preview a full draft risk-free (zero changes apply until you click Approve), just reply **"go ahead"** or tap one of the starter chips below!`,
    ].join('\n'),
    [
      `Still right here whenever you're ready! Whether you want to share a rough idea of your project or jump straight into a default preview${tenantContextEn}, say **"let's do it"** and I'll lay out the plan for you.`,
    ].join('\n'),
  ];

  return {
    act,
    intent: 'gather_requirements',
    shouldProposeNow: false,
    focusedStepId: null,
    reply: ensureNonRepetitiveReply(
      locale === 'vi' ? genericDiscoveryVi : genericDiscoveryEn,
      priorAssistantMessages,
      locale,
      activeTenantName ?? undefined,
    ),
    missingQuestions,
    suggestedQuickReplies: buildContextualQuickReplies(),
    extractedRequirements,
    topic,
  };
}

/**
 * Builds a warm, natural teammate introduction to accompany a `pending_consent` proposal card.
 * Preserves the Consent Card reference ("Chờ xác nhận triển khai" / "Consent Required") naturally
 * while highlighting the user's specific business/domain and never repeating prior replies.
 */
export function buildHumanProposalIntro(
  params: HumanProposalIntroParams,
): { reply: string; suggestedQuickReplies: string[] } {
  const { locale, proposal, priorMessages = [], isRefinement = false, topic: explicitTopic } = params;

  const priorAssistantMessages = priorMessages
    .filter((m) => m.role === 'assistant' && m.content.trim().length > 0)
    .map((m) => m.content);

  const resolvedTopic =
    explicitTopic ??
    resolveDomainGuidanceFromIndustry(proposal.requirements.industry, locale);

  const permittedCount = proposal.steps.filter((s) => s.canApply).length;
  const industryLabel = proposal.requirements.industry;
  const colorLabel = proposal.requirements.primaryColor || '#2563eb';

  const quickReplies =
    locale === 'vi'
      ? [
          colorLabel === '#2563eb'
            ? 'Đổi tông màu sang xanh ngọc #0d9488'
            : 'Đổi màu sang xanh dương #2563eb',
          proposal.requirements.requireContactIntake
            ? 'Cho khách chat ngay không cần nhập email'
            : 'Yêu cầu khách nhập email trước khi chat',
          ...(resolvedTopic && !proposal.requirements.faqSummaryOrPolicies
            ? [resolvedTopic.detailExampleChipVi]
            : []),
        ]
      : [
          colorLabel === '#2563eb'
            ? 'Switch primary color to teal #0d9488'
            : 'Switch primary color to #2563eb',
          proposal.requirements.requireContactIntake
            ? 'Allow instant chat without email intake'
            : 'Require customer email intake before chat',
          ...(resolvedTopic && !proposal.requirements.faqSummaryOrPolicies
            ? [resolvedTopic.detailExampleChipEn]
            : []),
        ];

  if (locale === 'vi') {
    const domainTouchVi = resolvedTopic
      ? ` (đã lồng sẵn ngữ cảnh tư vấn **${resolvedTopic.industryVi}** như *${resolvedTopic.customerScenariosVi[0]}*)`
      : industryLabel
        ? ` (mảng **${industryLabel}**)`
        : '';

    const candidatesVi = isRefinement
      ? [
          [
            `Mình vừa chỉnh lại bản nháp cho **${proposal.tenantName}** (\`${proposal.tenantSlug}\`) theo đúng ý bạn rồi đây! ✨`,
            '',
            `Bạn kiểm tra lại ${permittedCount}/7 hạng mục trong thẻ **Chờ xác nhận triển khai** ngay bên dưới nhé — mình vẫn chưa tự ý lưu gì vào hệ thống đâu. Nếu còn muốn đổi màu sắc, lời chào hay quy định nào nữa cứ nhắn mình sửa tiếp, còn thấy ưng ý rồi thì bấm **Đồng ý & Tự động triển khai** là xong nha!`,
          ].join('\n'),
          [
            `Đã cập nhật xong phương án mới cho **${proposal.tenantName}** rồi nhé! Toàn bộ thay đổi đều nằm gọn ở thẻ **Chờ xác nhận triển khai** bên dưới (an toàn 100%, chờ bạn duyệt mới chạy). Bạn ngó qua xem vừa ý chưa nha!`,
          ].join('\n'),
        ]
      : [
          [
            `Xong rồi nè! 🎉 Mình vừa phác thảo trọn gói phương án thiết lập (${permittedCount}/7 bước trong quyền của bạn) cho **${proposal.tenantName}** (\`${proposal.tenantSlug}\`)${domainTouchVi}.`,
            '',
            'Bạn yên tâm là **mình chưa tự ý thay đổi bất kỳ cài đặt nào** trên hệ thống cả. Bạn lướt xem thẻ **Chờ xác nhận triển khai** bên dưới nhé — muốn bỏ tích bước nào hay bảo mình chỉnh lại tên gọi, màu sắc (`' +
              colorLabel +
              '`), chính sách đổi trả đều thoải mái. Khi nào ưng bụng rồi bạn bấm **Đồng ý & Tự động triển khai** để hệ thống cài đặt luôn nha!',
          ].join('\n'),
          [
            `Mình đã chuẩn bị xong bản nháp cấu hình AI Support (${permittedCount}/7 hạng mục) dành riêng cho **${proposal.tenantName}**${domainTouchVi} ở thẻ **Chờ xác nhận triển khai** ngay bên dưới!`,
            '',
            'Mọi thứ hiện mới chỉ là bản xem trước để bạn kiểm tra thôi. Chỗ nào muốn thêm bớt câu chữ hay đổi tông màu bạn cứ nhắn tự nhiên cho mình, còn nếu thấy hợp lý rồi thì bấm duyệt để triển khai tự động nhé!',
          ].join('\n'),
        ];

    return {
      reply: ensureNonRepetitiveReply(
        candidatesVi,
        priorAssistantMessages,
        'vi',
        proposal.tenantName,
      ),
      suggestedQuickReplies: quickReplies.slice(0, 3),
    };
  }

  const domainTouchEn = resolvedTopic
    ? ` (already tailored around **${resolvedTopic.industryEn}**, including scenarios like *${resolvedTopic.customerScenariosEn[0]}*)`
    : industryLabel
      ? ` (**${industryLabel}**)`
      : '';

  const candidatesEn = isRefinement
    ? [
        [
          `All updated! ✨ I adjusted the setup draft for **${proposal.tenantName}** (\`${proposal.tenantSlug}\`) right away.`,
          '',
          `Take a look at the ${permittedCount}/7 steps in the **Consent Required** card below — **nothing has been changed on your live setup yet**. Tell me if you'd like any more tweaks, or click **Approve & Auto-Deploy** whenever it looks good!`,
        ].join('\n'),
        [
          `I've refreshed the preview plan for **${proposal.tenantName}** with your latest changes in the **Consent Required** card below (still staged safely until you approve). Let me know if anything else needs fine-tuning!`,
        ].join('\n'),
      ]
    : [
        [
          `All set! 🎉 I put together a tailored setup draft (${permittedCount}/7 permitted steps) for **${proposal.tenantName}** (\`${proposal.tenantSlug}\`)${domainTouchEn}.`,
          '',
          `Rest assured, **no live settings have been modified yet**. Have a look through the **Consent Required** card below — you can uncheck any step you want to skip, ask me in plain English to tweak colors (\`${colorLabel}\`), tone, or policies, and click **Approve & Auto-Deploy** once you're happy with it!`,
        ].join('\n'),
        [
          `Here is your ready-to-review AI Support draft (${permittedCount}/7 steps) for **${proposal.tenantName}**${domainTouchEn}, waiting in the **Consent Required** card below!`,
          '',
          'Everything is safely staged as a preview right now. Let me know if you want to adjust any detail, or approve it below to deploy automatically!',
        ].join('\n'),
      ];

  return {
    reply: ensureNonRepetitiveReply(
      candidatesEn,
      priorAssistantMessages,
      'en',
      proposal.tenantName,
    ),
    suggestedQuickReplies: quickReplies.slice(0, 3),
  };
}
