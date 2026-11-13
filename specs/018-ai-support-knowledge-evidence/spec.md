# Feature Specification: Knowledge Evidence & Answer Quality

**Feature Branch**: feat/9router-integration
**Feature Directory**: specs/018-ai-support-knowledge-evidence
**Created**: 2026-11-13
**Status**: Implemented and locally validated on synchronized main. Current PR/CI/publication state: review.md.
**Input**: Đề xuất bước tiếp theo để website đối tác dùng server làm AI hỗ trợ hoàn thiện hơn; viết spec và prompt cho bốn agent, reviewer chỉ review sau bàn giao.

**Integration update (review round3)**: main đã đổi URL sang Thruline sau khi spec được soạn. Áp dụng [integration-main.md](integration-main.md) cho prefix lịch sử trong bộ tài liệu; giữ nguyên functional/security requirements và ownership. Tình trạng acceptance hiện hành ở [review.md](review.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Quản lý và xuất bản nguồn tri thức (Priority: P1)

Quản trị viên nhập tài liệu dạng văn bản, Markdown hoặc danh sách FAQ từ nội dung/file hoặc địa chỉ xuất dữ liệu công khai. Nội dung mới là bản nháp; chỉ phiên bản được xuất bản mới được trợ lý sử dụng. Việc nhập lỗi không làm mất tài liệu đang phục vụ khách.

**Why this priority**: Thay đổi chính sách hỗ trợ phải có bước kiểm tra, phiên bản và quyền truy cập rõ ràng trước khi ảnh hưởng câu trả lời.
**Independent Test**: Trong tenant đã bật chế độ chỉ dùng tri thức, nhập bản đầu, xuất bản, nhập bản hai, kiểm tra khách vẫn dùng bản đầu; xuất bản bản hai rồi xác minh kết quả thay đổi.
**Acceptance Scenarios**:
1. **Given** nguồn chưa có bản xuất bản, **When** nhập nội dung hợp lệ, **Then** chỉ người quản lý thấy bản nháp; khách chưa truy xuất được.
2. **Given** bản đang phục vụ khách, **When** nhập lại cùng nội dung và metadata, **Then** không tạo thêm phiên bản trùng; lỗi mạng/định dạng không đổi bản đang phục vụ.
3. **Given** hai người đang sửa cùng nguồn, **When** người thứ hai lưu với phiên bản quản lý cũ, **Then** nhận xung đột thay vì ghi đè.
4. **Given** nguồn bị lưu trữ hoặc thu hồi quyền, **When** khách hỏi tiếp, **Then** nội dung đó không còn là nguồn trả lời.

### User Story 2 — Câu trả lời có nguồn và biết dừng khi thiếu dữ liệu (Priority: P1)

Doanh nghiệp có thể bật chế độ chỉ trả lời từ tri thức cho từng tenant. Khách nhận câu trả lời cùng các đoạn tham khảo được phép xem. Nếu không có tài liệu phù hợp hoặc trích dẫn không hợp lệ, trợ lý giải thích chưa đủ dữ liệu và cho phép liên hệ nhân viên.

**Why this priority**: Có kết nối AI chưa đủ để sử dụng chính sách hỗ trợ một cách kiểm chứng được.
**Independent Test**: Hỏi câu có nguồn, câu không có nguồn, cố dẫn tài liệu của role/tenant khác và thay nguồn trong lúc đang trả lời.
**Acceptance Scenarios**:
1. Nguồn tham khảo phải thuộc tập tài liệu thực sự được cung cấp cho lượt trả lời, đúng tenant/quyền và vẫn còn được xuất bản khi kết quả được lưu.
2. Không có nguồn phù hợp thì không gọi AI hay công cụ nghiệp vụ; một lượt được nhận vẫn lưu tin khách và thông báo chưa đủ dữ liệu để khách chuyển nhân viên được.
3. AI tạo citation giả, thiếu citation, hoặc dùng nguồn vừa bị thu hồi thì nội dung AI đó không được hiển thị, lưu vào lịch sử hay cache; chi phí AI đã phát sinh vẫn được ghi nhận.
4. Yêu cầu gửi lại cùng mã lượt không sinh thêm tin nhắn/chi phí. Nếu nguồn hoặc quyền đã thay đổi, yêu cầu cũ không làm tái xuất dữ liệu đã thu hồi và không tự gọi lại AI.
5. Chế độ hiện tại mặc định giữ nguyên. Chế độ chỉ dùng tri thức không tra CRM hoặc gọi công cụ nghiệp vụ; không thay đổi luồng phê duyệt, quyền hoặc quota của chế độ hiện tại.

### User Story 3 — Kiểm thử chất lượng truy xuất theo role (Priority: P2)

Quản trị viên tạo bộ câu hỏi cùng các nguồn kỳ vọng, nguồn bị cấm và trường hợp phải thông báo thiếu dữ liệu. Báo cáo giúp phát hiện thay đổi tài liệu làm mất khả năng trả lời hoặc vi phạm phân quyền trước khi triển khai.

**Why this priority**: Thêm nguồn không được làm hỏng các tình huống hỗ trợ đã hoạt động.
**Independent Test**: Chạy bộ câu hỏi có kết quả đã biết, thay một nguồn, chạy lại và so sánh ca đạt/không đạt.
**Acceptance Scenarios**:
1. Mỗi kết quả gắn với phiên bản cấu hình và tập nguồn tại thời điểm chạy; báo cáo cũ không bị trình bày như kết quả của nguồn mới.
2. Điểm số biểu thị truy xuất/citation, không tự gọi là độ đúng sự thật hoặc độ tự tin của AI.
3. Chạy đánh giá không gọi nhà cung cấp AI, công cụ nghiệp vụ hoặc endpoint lấy nguồn mới; không trừ quota chat.
4. Báo cáo không chứa nguồn/đoạn văn bị cấm đối với role của ca kiểm thử, kể cả trong trường hợp thất bại.

### User Story 4 — Knowledge Studio và nguồn tham khảo trên website (Priority: P2)

Quản trị viên có một giao diện quản lý nguồn, xem thử truy xuất, cấu hình chế độ trả lời và đọc đánh giá. Khách website xem được nguồn tham khảo an toàn ngay trong widget, kể cả sau khi tải lại hội thoại.

**Why this priority**: Cần một quy trình vận hành có thể dùng được, không chỉ các endpoint rời nhau.
**Independent Test**: Thực hiện đầy đủ thao tác trong cả EN/VI, đổi tenant khi đang tải, tải lại widget và thử tài khoản không có quyền quản lý.
**Acceptance Scenarios**:
1. Người không có quyền quản lý không thấy nội dung nguồn hoặc kết quả đánh giá của tenant.
2. Đổi tenant/phiên không hiển thị dữ liệu hay kết quả lưu của tenant/phiên cũ.
3. Citation chỉ hiển thị tiêu đề, vị trí và đoạn trích đã được cấp quyền; nội dung độc hại không chạy như mã hoặc HTML.
4. Thông báo chưa đủ dữ liệu, lỗi AI, lỗi mạng và chuyển nhân viên được phân biệt rõ; không hiển thị lỗi AI như một câu trả lời có nguồn.

### Edge Cases

- UTF-8 lỗi, dữ liệu quá lớn, tài liệu rỗng, FAQ sai schema; URL có credential/query, redirect, DNS nội bộ hoặc metadata; nhập bị ngắt/timeout.
- Draft mới không ảnh hưởng nguồn đang live; xuất bản đồng thời; thu hồi quyền/xóa legacy doc trong lúc AI đang trả lời.
- Trùng nội dung, thay quyền nhưng không đổi nội dung, nguồn của tenant khác, bản cũ hoặc citation do khách tự gửi.
- Quota sát ngưỡng, phát lại mã lượt, nguồn thay đổi giữa hai lần phát lại, provider lỗi sau khi đã tính usage.
- Tài liệu chứa chỉ dẫn giả, citation marker giả hoặc câu lệnh gọi công cụ.
- Câu hỏi tiếng Việt có/không dấu; nguồn quá ngắn/dài; không đủ chỗ chứa tất cả nguồn tham khảo.
- Chạy đánh giá khi nguồn vừa thay đổi; hết giới hạn tài nguyên; lịch sử cũ chưa có thông tin provenance.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Tạo và nhập nguồn từ text, Markdown, FAQ JSON; định dạng web khác và tệp nhị phân phải bị từ chối rõ ràng.
- **FR-002**: Bản nháp, phiên bản bất biến, xuất bản và lưu trữ phải tách biệt; nhập không tự xuất bản.
- **FR-003**: Nguồn phải có phạm vi tenant và role; tài liệu mới mặc định chỉ admin được sử dụng.
- **FR-004**: Việc xuất bản/thu hồi quyền có hiệu lực nguyên tử; sửa dựa trên phiên bản quản lý cũ phải bị từ chối.
- **FR-005**: Phải giới hạn kích thước/số lượng/thời gian nhập và chỉ truy cập đích mạng được phép; không giữ giao dịch dữ liệu trong lúc chờ mạng.
- **FR-006**: Nội dung nguồn mới phải được mã hóa khi lưu; không đưa nội dung thô, credential hoặc token vào log/lỗi.
- **FR-007**: Tìm nguồn phải áp dụng tenant, trạng thái xuất bản và quyền trước khi xếp hạng; có chuẩn hóa truy vấn tiếng Việt và giới hạn ngữ cảnh.
- **FR-008**: Chế độ có nguồn là tùy chọn và chỉ dùng tri thức; chế độ hiện tại giữ hành vi cũ, không âm thầm chuyển chế độ khi lỗi cấu hình.
- **FR-009**: Citation phải được kiểm tra theo nguồn thực sự đưa vào AI và nguồn/quyền hiện hành; citation hợp lệ không được trình bày như bằng chứng mọi phát biểu đúng.
- **FR-010**: Thiếu nguồn hoặc citation không hợp lệ phải tạo kết quả không phải AI rõ ràng; không lưu nội dung AI bị loại và không báo model đã chạy nếu chưa gọi model.
- **FR-011**: Lượt thiếu nguồn phải giữ được lịch sử/chuyển nhân viên/chống trùng; thu đúng một lượt và chỉ số token thực sự phát sinh theo cơ chế quota hiện tại.
- **FR-012**: Nguồn bị thay đổi/thu hồi không được sống lại qua cache hoặc phản hồi có provenance trong lịch sử; không tự tái sinh kết quả dưới mã lượt cũ.
- **FR-013**: Cho phép quản lý bộ đánh giá và chạy truy xuất có thể lặp lại, không gọi AI/công cụ và không sửa dữ liệu vận hành của khách.
- **FR-014**: Có giao diện quản lý EN/VI, phân quyền và cô lập tenant/phiên; widget hiển thị nguồn an toàn, bảo toàn các tính năng017.
- **FR-015**: Phải có kiểm thử HTTP/runtime thật cùng kiểm thử nhập lỗi, phiên bản, quyền, citation giả, phát lại, quota và giao diện; không dùng mock toàn bộ runtime để tuyên bố tích hợp xong.

### Key Entities

- Knowledge Source: nguồn do tenant quản lý, quyền sử dụng và phiên bản đang live.
- Source Revision: ảnh chụp tài liệu bất biến cùng các đoạn có vị trí xác định.
- Evidence Pack: tập đoạn thực sự được cung cấp cho một lượt, với định danh snapshot và giới hạn kích thước.
- Answer Evidence: citation đã kiểm tra hoặc lý do không đủ nguồn; liên kết tới lượt/tin nhắn.
- Evaluation Suite / Run: câu hỏi, kỳ vọng nguồn/quyền, snapshot và kết quả truy xuất.

## Success Criteria *(mandatory)*

- **SC-001**: 100% ca tài liệu nháp/lưu trữ/sai tenant/sai role không xuất hiện trong nguồn trả lời hoặc báo cáo công khai.
- **SC-002**: 100% citation giả, hết hiệu lực hoặc chưa được cung cấp cho AI bị loại; câu trả lời bị loại không xuất hiện trong dữ liệu được trả/lưu.
- **SC-003**: 20 lần phát lại một lượt không tạo thêm tin, lời gọi ngoài hoặc phí; thu hồi quyền chặn phát lại dữ liệu cũ.
- **SC-004**: Xuất bản hoặc nhập thất bại không tạo tập nguồn live nửa cũ nửa mới; draft không thay câu trả lời đang phục vụ.
- **SC-005**: Bộ dữ liệu kiểm thử công bố rõ có ít nhất24 ca EN/VI, bốn role, câu không có nguồn và ca sai tenant; mọi kỳ vọng quyền đều đạt trước PR.
- **SC-006**: Chế độ mặc định vượt qua toàn bộ kiểm thử hồi quy013–017; luồng cấu hình, xuất bản và xem citation dùng được ở cả EN/VI.

## Assumptions & Scope

- Lấy017 đã merge làm nền; các tính năng016 không thuộc đợt này. Không chạy016/018 đồng thời trên cùng checkout.
- Phiên bản đầu hỗ trợ định dạng văn bản xuất ra được; không crawl HTML, PDF/OCR, URL tự quét, embeddings hoặc vector database.
- Chế độ có nguồn chỉ xác minh provenance/citation; đánh giá tự động là retrieval quality, không đo factual entailment bằng AI judge.
- Nội dung lịch sử có provenance018 được tái kiểm tra; không giả tạo provenance hay tái phân loại lịch sử cũ017.
- Người dùng tự gửi bốn prompt cho bốn agent. Reviewer chỉ chuẩn bị tài liệu lúc này, review sau bàn giao và tạo PR khi đạt; không tự triển khai hoặc merge.
