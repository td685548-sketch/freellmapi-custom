# Feature Specification: Nâng cấp toàn diện nền tảng AI (AI Platform Upgrade)

**Feature Branch**: `claude/beautiful-goldberg-6uxvyu`
**Feature Directory**: `specs/018-ai-platform-upgrade`
**Created**: 2026-11-13
**Status**: Draft
**Input**: Nâng cấp toàn diện nền tảng AI của gateway để lấp các khoảng trống đã rà soát trong code hiện tại ở 7 trụ cột: System prompt, RAG, Phân quyền, Prompt caching, MCP, Guardrails, Orchestrator. Tuân thủ nguyên tắc Zero-Conflict, giữ tương thích ngược cho các endpoint công khai và triển khai single-user; mọi tính năng mới mặc định tắt.

## Bối cảnh: hiện trạng đã rà soát (2026-11-13)

| Trụ cột | Đã có | Khoảng trống cần lấp |
|---|---|---|
| System prompt | Prompt ép phía server theo client key, áp dụng trên 4 giao thức chat; prompt riêng theo support tenant | Không có lịch sử phiên bản, biến mẫu, xem trước, khôi phục |
| RAG | Tri thức theo client key (chia đoạn, xếp hạng từ khóa); kho tri thức support lọc theo role | Không có tìm kiếm ngữ nghĩa; không có trích dẫn nguồn cho người gọi |
| Phân quyền | RBAC chi tiết tới từng thao tác, quota theo người dùng, audit log | Các trụ cột mới chưa có quyền riêng |
| Prompt caching | Cache câu trả lời khớp chính xác; nhận diện điểm đánh dấu cache để bộ nén không phá prefix; báo số token đã cache | Điểm đánh dấu cache không được chuyển tới nhà cung cấp; không tự đặt điểm đánh dấu; không báo mức tiết kiệm |
| MCP | Gateway đóng vai MCP server | Không kết nối được MCP server bên ngoài làm công cụ |
| Guardrails | Kiểm tra đầu vào theo client key và theo support tenant; che dữ liệu nhạy cảm; proxy kiểm duyệt | Không có chính sách kiểm tra đầu ra; không có kiểm tra bằng mô hình |
| Orchestrator | Tự chọn model, chuỗi dự phòng, Fusion, Combos, pipeline một lượt của support | Không có điều phối đa bước, đa agent, chuyển giao giữa agent |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nền tảng chung: tắt mặc định, phân quyền và nhật ký (Priority: P1)

Chủ hệ thống nâng cấp lên bản mới và mọi thứ vận hành y như trước. Từng trụ cột mới chỉ hoạt động khi quản trị viên chủ động bật. Mỗi trụ cột có nhóm quyền riêng để giao cho thành viên, và mọi thay đổi cấu hình đều để lại dấu vết.

**Why this priority**: Đây là điều kiện để triển khai dần 6 trụ cột còn lại mà không gây rủi ro cho bản cài đang chạy.
**Independent Test**: Nâng cấp một bản cài có dữ liệu thật; so sánh câu trả lời và hành vi của các endpoint công khai trước và sau; giao từng quyền mới cho một thành viên thử và xác minh họ chỉ làm được đúng phần được giao.

**Acceptance Scenarios**:
1. **Given** bản cài hiện hữu vừa nâng cấp và chưa bật gì, **When** gửi cùng một yêu cầu chat như trước, **Then** yêu cầu gửi tới nhà cung cấp và câu trả lời trả về không khác bản cũ.
2. **Given** thành viên chỉ có quyền xem một trụ cột, **When** họ thử sửa cấu hình trụ cột đó hoặc mở trụ cột khác, **Then** bị từ chối với thông báo rõ quyền còn thiếu.
3. **Given** quản trị viên bật, tắt hoặc sửa cấu hình bất kỳ trụ cột nào, **When** xem nhật ký kiểm toán, **Then** thấy ai làm, lúc nào, đổi gì, và không có bí mật nào trong nhật ký.
4. **Given** triển khai single-user không có tài khoản thành viên, **When** chủ hệ thống mở dashboard, **Then** dùng được toàn bộ trụ cột mà không cần cấu hình phân quyền.
5. **Given** bản sao lưu tạo trước khi nâng cấp, **When** khôi phục vào bản mới, **Then** hệ thống khởi động bình thường với mọi trụ cột mới ở trạng thái tắt.

---

### User Story 2 - Kết nối công cụ bên ngoài qua MCP (Priority: P1)

Quản trị viên đăng ký một máy chủ công cụ MCP bên ngoài, xem danh sách công cụ nó cung cấp, chọn những công cụ được phép và gắn chúng cho một client key hoặc một support tenant. Từ đó mô hình có thể gọi các công cụ ấy khi trả lời.

**Why this priority**: Hiện gateway chỉ gọi được webhook và truy vấn dữ liệu tự cấu hình; MCP mở ra cả hệ sinh thái công cụ có sẵn và là nền cho orchestrator.
**Independent Test**: Dựng một máy chủ MCP giả lập có một công cụ đọc và một công cụ ghi; đăng ký, gắn cho một client key, gửi câu hỏi cần công cụ và xác minh lời gọi, kết quả và nhật ký.

**Acceptance Scenarios**:
1. **Given** địa chỉ máy chủ hợp lệ, **When** quản trị viên đăng ký và bấm kiểm tra, **Then** thấy trạng thái kết nối và danh sách công cụ kèm mô tả, tham số.
2. **Given** máy chủ có 10 công cụ nhưng chỉ 2 được đưa vào danh sách cho phép, **When** mô hình trả lời cho client key đó, **Then** chỉ 2 công cụ ấy được giới thiệu cho mô hình và gọi được.
3. **Given** địa chỉ trỏ tới mạng nội bộ, địa chỉ vòng lặp hoặc chuyển hướng tới đó, **When** đăng ký hoặc gọi, **Then** bị từ chối và ghi sự kiện bảo mật.
4. **Given** công cụ trả kết quả quá lớn, chạy quá thời hạn, hoặc máy chủ mất kết nối, **When** đang trong một lượt chat, **Then** lượt chat vẫn kết thúc với thông tin lỗi công cụ rõ ràng, không treo.
5. **Given** công cụ được đánh dấu thay đổi dữ liệu, **When** mô hình yêu cầu gọi, **Then** lời gọi chờ người có quyền duyệt trước khi thực thi.
6. **Given** máy chủ đổi danh sách hoặc mô tả công cụ sau khi đã duyệt, **When** đồng bộ lại, **Then** công cụ mới hoặc đã đổi không tự động được phép cho tới khi quản trị viên xem lại.
7. **Given** thông tin xác thực của máy chủ MCP đã lưu, **When** xem cấu hình, nhật ký hoặc bản xuất, **Then** không nơi nào hiển thị bí mật dạng rõ.

---

### User Story 3 - Kiểm soát nội dung đầu ra (Priority: P1)

Quản trị viên đặt chính sách cho câu trả lời của mô hình: chủ đề cấm, không để lộ chỉ dẫn hệ thống, che dữ liệu nhạy cảm, và tùy chọn nhờ một dịch vụ kiểm duyệt hoặc một mô hình đánh giá. Chính sách áp dụng cho cả câu trả lời phát trực tiếp.

**Why this priority**: Hiện chỉ có kiểm tra đầu vào; một câu trả lời vi phạm vẫn tới được người dùng cuối.
**Independent Test**: Dùng nhà cung cấp giả lập trả về nội dung vi phạm ở cả hai kiểu trả lời (một lần và phát trực tiếp); xác minh hành vi ở ba chế độ tắt, ghi nhận, chặn.

**Acceptance Scenarios**:
1. **Given** chế độ ghi nhận, **When** câu trả lời vi phạm, **Then** người gọi vẫn nhận nguyên câu trả lời và một sự kiện vi phạm được ghi lại.
2. **Given** chế độ chặn và trả lời một lần, **When** câu trả lời vi phạm, **Then** người gọi nhận thông báo thay thế đã cấu hình cùng mã lý do, không nhận nội dung vi phạm.
3. **Given** chế độ chặn và phát trực tiếp, **When** vi phạm xuất hiện giữa chừng, **Then** phần vi phạm không được gửi tới người gọi và luồng kết thúc đúng định dạng giao thức đang dùng.
4. **Given** client key có chỉ dẫn hệ thống, **When** câu trả lời chép lại một phần đáng kể chỉ dẫn đó, **Then** được coi là rò rỉ và xử lý theo chế độ.
5. **Given** dịch vụ kiểm duyệt hoặc mô hình đánh giá không phản hồi, **When** đang kiểm tra, **Then** hệ thống làm theo lựa chọn đã cấu hình (cho qua hoặc chặn) và ghi nhận sự cố.
6. **Given** vai trò được miễn kiểm tra, **When** họ nhận câu trả lời, **Then** chính sách không áp dụng và việc miễn được ghi nhận.

---

### User Story 4 - Tri thức tìm theo ngữ nghĩa, có trích dẫn (Priority: P1)

Người quản lý tri thức bật tìm kiếm ngữ nghĩa cho một bộ tài liệu. Câu hỏi diễn đạt khác chữ với tài liệu vẫn tìm được đoạn đúng, và câu trả lời cho biết đã dựa trên tài liệu nào.

**Why this priority**: Tìm theo từ khóa bỏ sót câu hỏi diễn đạt khác; đây là than phiền chính về chất lượng trả lời từ tri thức.
**Independent Test**: Nạp bộ tài liệu mẫu và bộ câu hỏi diễn đạt lại; so tỷ lệ tìm đúng đoạn giữa chế độ từ khóa và chế độ kết hợp; kiểm tra thông tin nguồn trả về.

**Acceptance Scenarios**:
1. **Given** tìm kiếm ngữ nghĩa đã bật và tài liệu đã lập chỉ mục, **When** hỏi bằng từ đồng nghĩa hoặc ngôn ngữ khác với tài liệu, **Then** đoạn liên quan được đưa vào ngữ cảnh.
2. **Given** không có nhà cung cấp embedding khả dụng hoặc lập chỉ mục chưa xong, **When** có câu hỏi, **Then** hệ thống tự dùng tìm theo từ khóa như hiện tại và yêu cầu không lỗi.
3. **Given** tài liệu được sửa hoặc xóa, **When** hỏi lại, **Then** kết quả phản ánh nội dung mới và không còn đoạn của tài liệu đã xóa.
4. **Given** bật trích dẫn, **When** câu trả lời dùng tri thức, **Then** người gọi nhận được danh sách nguồn (tên tài liệu, đoạn) theo cách không phá vỡ định dạng giao thức.
5. **Given** tài liệu giới hạn theo role hoặc theo tenant, **When** người không đủ quyền hỏi, **Then** đoạn của tài liệu đó không xuất hiện trong ngữ cảnh lẫn trích dẫn.
6. **Given** đổi mô hình embedding, **When** lưu cấu hình, **Then** hệ thống lập chỉ mục lại ở nền, hiển thị tiến độ, và trong lúc đó vẫn trả lời được.
7. **Given** quản trị viên mở công cụ thử truy vấn, **When** nhập một câu hỏi, **Then** thấy các đoạn tìm được, điểm số và phương thức tìm ra từng đoạn.

---

### User Story 5 - Tận dụng cache prompt của nhà cung cấp (Priority: P2)

Người vận hành bật chuyển tiếp cache prompt. Các yêu cầu lặp lại phần đầu dài (chỉ dẫn hệ thống, tri thức, định nghĩa công cụ) được nhà cung cấp tính giá rẻ hơn và trả lời nhanh hơn. Dashboard cho thấy đã tiết kiệm được bao nhiêu.

**Why this priority**: Giảm chi phí và độ trễ rõ rệt cho client dùng prompt dài, nhưng không chặn các trụ cột khác.
**Independent Test**: Gửi hai yêu cầu liên tiếp cùng phần đầu qua nhà cung cấp giả lập có hỗ trợ cache; xác minh điểm đánh dấu tới nơi, số token cache được ghi nhận và báo cáo tiết kiệm.

**Acceptance Scenarios**:
1. **Given** người gọi tự đặt điểm đánh dấu cache và nhà cung cấp đích hỗ trợ, **When** chuyển tiếp bật, **Then** điểm đánh dấu tới nhà cung cấp đúng vị trí.
2. **Given** nhà cung cấp đích không hỗ trợ, **When** yêu cầu được định tuyến tới đó, **Then** điểm đánh dấu được bỏ sạch và yêu cầu không lỗi vì trường lạ.
3. **Given** bật tự đặt điểm đánh dấu, **When** yêu cầu có chỉ dẫn hệ thống phía server hoặc khối tri thức ổn định, **Then** hệ thống tự đánh dấu phần ổn định mà không vượt giới hạn của nhà cung cấp.
4. **Given** yêu cầu có phần đầu đã đánh dấu, **When** các bước nén, chèn tri thức hoặc chèn chỉ dẫn chạy, **Then** phần đầu đã đánh dấu không đổi từng ký tự giữa các yêu cầu.
5. **Given** nhà cung cấp trả số token đọc từ cache và ghi vào cache, **When** xem phân tích, **Then** thấy số token, tỷ lệ trúng và ước tính tiết kiệm theo client key, theo model và theo ngày.
6. **Given** chuỗi dự phòng chuyển sang nhà cung cấp khác giữa chừng, **When** thử lại, **Then** điểm đánh dấu được xử lý lại theo khả năng của nhà cung cấp mới.

---

### User Story 6 - Quản lý chỉ dẫn hệ thống có phiên bản (Priority: P2)

Người quản lý prompt sửa chỉ dẫn hệ thống của một client key hoặc tenant như một tài liệu có lịch sử: lưu nháp, xem trước với dữ liệu thử, phát hành, so sánh và quay lại bản cũ. Chỉ dẫn có thể chứa biến được thay khi chạy.

**Why this priority**: Giảm rủi ro khi đổi prompt trên môi trường thật; hiện một lần sửa là ghi đè và mất bản cũ.
**Independent Test**: Tạo ba phiên bản, phát hành bản hai, quay về bản một; xác minh yêu cầu chat dùng đúng bản đang phát hành ở từng thời điểm.

**Acceptance Scenarios**:
1. **Given** chỉ dẫn đang phát hành, **When** lưu một bản nháp mới, **Then** yêu cầu chat vẫn dùng bản đang phát hành cho tới khi bản nháp được phát hành.
2. **Given** nhiều phiên bản, **When** chọn hai bản, **Then** thấy khác biệt từng dòng, người sửa, thời điểm và ghi chú.
3. **Given** bản đang phát hành gây sự cố, **When** khôi phục bản trước, **Then** yêu cầu kế tiếp dùng bản được khôi phục và việc khôi phục tạo một mục lịch sử mới.
4. **Given** chỉ dẫn có biến (ví dụ ngày hiện tại, tên client, tên người dùng cuối), **When** xem trước với giá trị thử, **Then** thấy đúng văn bản mô hình sẽ nhận.
5. **Given** chỉ dẫn dùng biến không tồn tại hoặc sai cú pháp, **When** lưu, **Then** bị từ chối kèm vị trí lỗi; biến thiếu giá trị khi chạy được thay bằng giá trị mặc định đã khai báo.
6. **Given** giá trị biến đến từ người dùng cuối, **When** thay vào chỉ dẫn, **Then** giá trị được coi là dữ liệu và không thể chèn thêm chỉ dẫn hay biến khác.
7. **Given** client key đã có chỉ dẫn từ trước khi nâng cấp, **When** mở trang quản lý, **Then** chỉ dẫn cũ hiện là phiên bản 1 đang phát hành và hành vi chat không đổi.

---

### User Story 7 - Điều phối đa bước, đa agent (Priority: P3)

Quản trị viên định nghĩa một quy trình gồm các agent chuyên trách (mỗi agent có chỉ dẫn, model, bộ công cụ và nguồn tri thức riêng) cùng luật chuyển giao. Người gọi dùng quy trình như gọi một model. Hệ thống tự lập kế hoạch, gọi công cụ nhiều vòng, chuyển giao giữa các agent trong giới hạn đã đặt, và lưu lại vết từng bước.

**Why this priority**: Giá trị cao nhất nhưng phụ thuộc vào MCP, guardrails, tri thức và prompt có phiên bản; làm sau cùng.
**Independent Test**: Định nghĩa quy trình hai agent với nhà cung cấp và công cụ giả lập; chạy một yêu cầu cần chuyển giao và ba vòng công cụ; xác minh kết quả, vết chạy và các giới hạn.

**Acceptance Scenarios**:
1. **Given** quy trình đã phát hành, **When** người gọi chọn quy trình qua giao thức chat quen thuộc, **Then** nhận một câu trả lời cuối cùng đúng định dạng, kể cả khi phát trực tiếp.
2. **Given** giới hạn số bước, số token hoặc thời gian, **When** một lần chạy chạm giới hạn, **Then** nó dừng, trả kết quả tốt nhất hiện có kèm lý do dừng, và không tiêu thêm ngân sách.
3. **Given** agent A chuyển giao cho agent B, **When** B chạy, **Then** B chỉ dùng công cụ và tri thức được giao cho B, không thừa hưởng quyền của A.
4. **Given** một bước cần hành động nhạy cảm, **When** tới bước đó, **Then** lần chạy tạm dừng chờ duyệt; duyệt thì tiếp tục từ đúng bước đó, từ chối thì kết thúc có giải thích.
5. **Given** lần chạy đã xong hoặc đang chạy, **When** người có quyền mở vết chạy, **Then** thấy từng bước: agent nào, model nào, công cụ nào, đầu vào và đầu ra đã che dữ liệu nhạy cảm, thời lượng, token, lỗi.
6. **Given** agent gọi lặp cùng một công cụ với cùng tham số hoặc hai agent chuyển giao qua lại, **When** vượt ngưỡng lặp, **Then** hệ thống cắt vòng lặp và ghi lý do.
7. **Given** người gọi ngắt kết nối hoặc quản trị viên hủy lần chạy, **When** đang giữa chừng, **Then** các bước chưa bắt đầu không được thực thi.
8. **Given** một lần chạy, **When** tính hạn mức, **Then** toàn bộ token và số yêu cầu của mọi bước được tính cho đúng client key và người dùng cuối đã khởi tạo.

---

### Edge Cases

- Một yêu cầu bật đồng thời nhiều trụ cột: thứ tự áp dụng phải cố định và có tài liệu (kiểm tra đầu vào → chỉ dẫn hệ thống → tri thức → điểm đánh dấu cache → gọi model/công cụ → kiểm tra đầu ra).
- Kết quả công cụ MCP chứa văn bản giả làm chỉ dẫn ("bỏ qua mọi hướng dẫn trước đó"): phải được đóng gói như dữ liệu không tin cậy và vẫn chịu kiểm tra đầu ra.
- Tài liệu tri thức chứa nội dung giả làm chỉ dẫn: xử lý như trên.
- Cache câu trả lời khớp chính xác đang bật: câu trả lời lấy từ cache vẫn phải qua chính sách đầu ra hiện hành; yêu cầu có gọi công cụ hoặc chạy quy trình không được lưu vào cache này.
- Hai quản trị viên sửa cùng một chỉ dẫn, chính sách hoặc quy trình: người lưu sau được báo xung đột, không ghi đè âm thầm.
- Xóa máy chủ MCP, tài liệu hoặc agent đang được một quy trình dùng: bị chặn kèm danh sách nơi đang dùng, hoặc quy trình bị đánh dấu không hợp lệ và từ chối chạy với lỗi rõ ràng.
- Hệ thống khởi động lại giữa một lần chạy quy trình hoặc giữa lúc lập chỉ mục: lần chạy được đánh dấu gián đoạn (không tự chạy lại hành động có tác động bên ngoài); lập chỉ mục tự tiếp tục.
- Tài liệu rất lớn hoặc rất nhiều tài liệu: có giới hạn kích thước rõ ràng, thông báo khi vượt, lập chỉ mục không làm chậm lưu lượng chat.
- Phát trực tiếp với chính sách đầu ra cần xem cả câu: độ trễ thêm phải có giới hạn và được nêu trong giao diện cấu hình.
- Client gửi sẵn công cụ riêng trong yêu cầu đồng thời có công cụ MCP gắn cho client key: tên trùng phải được phân giải theo quy tắc xác định, công cụ của client vẫn trả về cho client tự thực thi.
- Hạn mức người dùng cuối hết giữa một lần chạy nhiều bước.
- Nhà cung cấp được chọn không hỗ trợ gọi công cụ trong khi client key có gắn công cụ.

## Requirements *(mandatory)*

### Functional Requirements

#### A. Nền tảng chung

- **FR-001**: Mỗi trụ cột mới MUST có công tắc riêng và mặc định tắt; khi tắt, hành vi của mọi endpoint công khai và dashboard MUST giống bản trước nâng cấp.
- **FR-002**: Hệ thống MUST cung cấp cho mỗi trụ cột ít nhất hai quyền tách biệt (xem, quản lý) và các quyền riêng cho thao tác nhạy cảm (duyệt hành động, xem vết chạy, xem nội dung vi phạm); chủ hệ thống và triển khai single-user MUST có đủ mọi quyền mà không cần cấu hình.
- **FR-003**: Thao tác chưa được ánh xạ sang quyền cụ thể MUST bị coi là cần quyền quản lý cấp cha, không được mở mặc định.
- **FR-004**: Mọi thao tác tạo, sửa, xóa, bật, tắt, phát hành, khôi phục, duyệt và từ chối MUST được ghi vào nhật ký kiểm toán với người thực hiện, thời điểm, đối tượng và tóm tắt thay đổi; nhật ký MUST NOT chứa bí mật.
- **FR-005**: Bí mật mới (thông tin xác thực máy chủ MCP và tương tự) MUST được mã hóa khi lưu, chỉ hiển thị dạng che, và MUST NOT xuất hiện trong log, vết chạy, bản xuất hay thông báo lỗi.
- **FR-006**: Cấu hình của các trụ cột mới MUST nằm trong phạm vi sao lưu và khôi phục; khôi phục bản sao lưu cũ MUST cho ra trạng thái hợp lệ với các trụ cột mới tắt.
- **FR-007**: Giao diện quản trị của mọi trụ cột MUST có tiếng Việt và tiếng Anh, tuân thủ ngôn ngữ đang chọn của dashboard.
- **FR-008**: Thứ tự áp dụng các trụ cột trong một yêu cầu MUST cố định, có tài liệu, và giống nhau trên cả bốn giao thức chat đang hỗ trợ.
- **FR-009**: Sự cố ở bất kỳ trụ cột tùy chọn nào (tri thức, cache prompt, kiểm duyệt ngoài) MUST suy giảm an toàn theo cấu hình và MUST NOT làm hỏng yêu cầu chat, trừ khi quản trị viên chọn chế độ chặn khi lỗi.

#### B. Chỉ dẫn hệ thống có phiên bản

- **FR-010**: Người có quyền MUST tạo được bản nháp, phát hành, xem lịch sử, so sánh hai phiên bản và khôi phục phiên bản cũ của chỉ dẫn hệ thống cho client key và support tenant.
- **FR-011**: Tại mọi thời điểm MUST có đúng một phiên bản đang phát hành cho mỗi đối tượng; yêu cầu chat MUST chỉ dùng phiên bản đó.
- **FR-012**: Mỗi phiên bản MUST bất biến sau khi tạo, lưu người sửa, thời điểm và ghi chú; khôi phục MUST tạo mục lịch sử mới thay vì sửa lịch sử.
- **FR-013**: Chỉ dẫn MUST hỗ trợ biến từ một danh mục đã công bố (tối thiểu: ngày giờ hiện tại, tên client key, định danh và tên người dùng cuối, ngôn ngữ) cùng biến tùy chỉnh có giá trị mặc định.
- **FR-014**: Hệ thống MUST kiểm tra cú pháp và biến khi lưu, từ chối bản lỗi kèm vị trí; khi chạy, biến thiếu giá trị MUST dùng giá trị mặc định.
- **FR-015**: Giá trị biến đến từ người gọi MUST được coi là dữ liệu: giới hạn độ dài, không được diễn giải thành biến hay chỉ dẫn.
- **FR-016**: Người có quyền MUST xem trước được văn bản cuối cùng với giá trị thử và gửi thử một câu hỏi với bản nháp mà không ảnh hưởng lưu lượng thật.
- **FR-017**: Chỉ dẫn có sẵn trước nâng cấp MUST tự trở thành phiên bản 1 đang phát hành, không cần thao tác và không đổi hành vi.
- **FR-018**: Hệ thống MUST giữ tối thiểu 50 phiên bản gần nhất cho mỗi đối tượng và cho biết khi bản cũ bị dọn.

#### C. Tri thức ngữ nghĩa và trích dẫn

- **FR-020**: Người có quyền MUST chọn được phương thức tìm cho mỗi bộ tri thức: từ khóa (mặc định, như hiện tại), ngữ nghĩa, hoặc kết hợp.
- **FR-021**: Hệ thống MUST lập chỉ mục ngữ nghĩa ở nền khi tài liệu được thêm, sửa hoặc khi đổi mô hình embedding, hiển thị tiến độ và lỗi, và MUST NOT chặn yêu cầu chat trong lúc đó.
- **FR-022**: Khi không có embedding khả dụng, chỉ mục chưa sẵn sàng hoặc truy vấn embedding lỗi hay quá hạn, hệ thống MUST tự dùng tìm theo từ khóa và ghi nhận việc suy giảm.
- **FR-023**: Xóa hoặc sửa tài liệu MUST loại bỏ nội dung cũ khỏi mọi chỉ mục trước khi nội dung đó có thể xuất hiện trong câu trả lời kế tiếp.
- **FR-024**: Kết quả tìm kiếm MUST tôn trọng ranh giới sẵn có: theo client key, theo tenant và theo role được phép của tài liệu.
- **FR-025**: Người có quyền MUST cấu hình được số đoạn tối đa, ngân sách ký tự và ngưỡng liên quan tối thiểu; dưới ngưỡng thì không chèn gì.
- **FR-026**: Khi bật trích dẫn, người gọi MUST nhận được danh sách nguồn đã dùng (tên tài liệu, vị trí đoạn) qua một kênh không phá vỡ định dạng giao thức và bỏ qua được bởi client cũ.
- **FR-027**: Nội dung tri thức đưa vào ngữ cảnh MUST được đánh dấu là tài liệu tham khảo, không phải chỉ dẫn.
- **FR-028**: Hệ thống MUST có công cụ thử truy vấn cho quản trị viên, hiển thị các đoạn tìm được, điểm số và phương thức tìm ra.
- **FR-029**: Chi phí lập chỉ mục và truy vấn embedding MUST được ghi nhận và hiển thị tách khỏi lưu lượng chat.
- **FR-030**: Kho tri thức theo client key và kho tri thức support MUST cùng dùng được tìm kiếm ngữ nghĩa và trích dẫn.

#### D. Cache prompt phía nhà cung cấp

- **FR-035**: Khi bật, điểm đánh dấu cache do người gọi đặt MUST được chuyển tới nhà cung cấp có hỗ trợ, đúng vị trí; với nhà cung cấp không hỗ trợ MUST được loại bỏ hoàn toàn.
- **FR-036**: Hệ thống MUST duy trì danh mục khả năng cache theo nhà cung cấp/model, quản trị viên xem và ghi đè được.
- **FR-037**: Khi bật tự đánh dấu, hệ thống MUST đánh dấu các phần ổn định do server thêm (chỉ dẫn hệ thống, khối tri thức cố định, định nghĩa công cụ) trong giới hạn số điểm đánh dấu của nhà cung cấp, ưu tiên điểm của người gọi.
- **FR-038**: Mọi bước biến đổi yêu cầu (nén, chèn chỉ dẫn, chèn tri thức, gắn công cụ) MUST giữ phần đầu đã đánh dấu ổn định từng ký tự giữa các yêu cầu giống nhau; nội dung thay đổi theo từng yêu cầu MUST nằm sau điểm đánh dấu cuối.
- **FR-039**: Hệ thống MUST ghi nhận token đọc từ cache và token ghi vào cache cho mỗi yêu cầu khi nhà cung cấp báo, và trả lại cho người gọi theo quy ước của giao thức đang dùng.
- **FR-040**: Dashboard MUST hiển thị tỷ lệ trúng cache, token đã cache và ước tính tiết kiệm theo client key, model và ngày.
- **FR-041**: Khi định tuyến có nhiều lựa chọn tương đương, hệ thống SHOULD ưu tiên giữ cùng nhà cung cấp và cùng khóa cho các yêu cầu có cùng phần đầu đã đánh dấu trong thời hạn cache, và MUST NOT hy sinh tính sẵn sàng vì điều này.
- **FR-042**: Khi chuỗi dự phòng đổi nhà cung cấp, điểm đánh dấu MUST được xử lý lại theo khả năng của nhà cung cấp mới.

#### E. Kết nối MCP bên ngoài

- **FR-045**: Người có quyền MUST đăng ký, sửa, tắt, xóa và kiểm tra kết nối máy chủ MCP bên ngoài qua giao thức truyền HTTP, kèm thông tin xác thực tùy chọn.
- **FR-046**: Hệ thống MUST khám phá công cụ của máy chủ, lưu bản chụp (tên, mô tả, tham số) và cho đồng bộ lại theo yêu cầu.
- **FR-047**: Mặc định không công cụ nào được phép; quản trị viên MUST chọn từng công cụ. Công cụ mới hoặc có mô tả/tham số thay đổi sau đồng bộ MUST quay về trạng thái chờ xem lại.
- **FR-048**: Công cụ được phép MUST gắn được cho từng client key, support tenant và agent của quy trình; nơi không gắn MUST NOT thấy công cụ.
- **FR-049**: Mỗi công cụ MUST được phân loại chỉ đọc hoặc thay đổi dữ liệu; mặc định là thay đổi dữ liệu. Công cụ thay đổi dữ liệu MUST chờ người có quyền duyệt trước khi thực thi.
- **FR-050**: Mọi kết nối ra MUST bị chặn nếu đích là địa chỉ nội bộ, vòng lặp, liên kết cục bộ hoặc dịch vụ siêu dữ liệu, kể cả sau chuyển hướng và phân giải tên; MUST có danh sách ngoại lệ do chủ hệ thống quản lý cho triển khai nội bộ.
- **FR-051**: Mỗi lời gọi công cụ MUST có giới hạn thời gian, kích thước kết quả và số lời gọi đồng thời; vượt giới hạn MUST trả lỗi công cụ có cấu trúc cho mô hình thay vì làm hỏng lượt chat.
- **FR-052**: Kết quả công cụ MUST được đóng gói như dữ liệu không tin cậy, qua che dữ liệu nhạy cảm hiện có trước khi tới mô hình, và không được diễn giải như chỉ dẫn hệ thống.
- **FR-053**: Với người gọi dùng giao thức chat thông thường, hệ thống MUST tự chạy vòng lặp gọi công cụ phía server cho các công cụ MCP và trả câu trả lời cuối; công cụ do chính người gọi khai báo MUST vẫn được trả về cho người gọi tự thực thi.
- **FR-054**: Tên công cụ từ nhiều máy chủ MUST được phân biệt để không trùng nhau và không trùng công cụ của người gọi.
- **FR-055**: Mỗi lời gọi công cụ MUST được ghi lại (máy chủ, công cụ, thời lượng, kết quả thành công/lỗi, người khởi tạo) với tham số và kết quả đã che.
- **FR-056**: Hệ thống MUST hiển thị tình trạng từng máy chủ (lần kết nối gần nhất, lỗi gần nhất) và tạm ngưng gọi máy chủ lỗi liên tục trong một khoảng rồi thử lại.
- **FR-057**: Vai trò MCP server hiện có của gateway MUST giữ nguyên hành vi.

#### F. Kiểm soát đầu ra

- **FR-060**: Người có quyền MUST cấu hình chính sách đầu ra theo client key và theo support tenant, với ba chế độ: tắt, ghi nhận, chặn.
- **FR-061**: Chính sách MUST hỗ trợ tối thiểu các bộ kiểm tra: chủ đề và từ khóa cấm, mẫu tùy chỉnh, rò rỉ chỉ dẫn hệ thống, dữ liệu nhạy cảm (dùng lại bộ che hiện có), độ dài tối đa.
- **FR-062**: Chính sách MUST cho phép tùy chọn kiểm tra bằng dịch vụ kiểm duyệt đã có trong gateway hoặc bằng một mô hình đánh giá do quản trị viên chọn, kèm tiêu chí bằng lời.
- **FR-063**: Ở chế độ chặn với câu trả lời một lần, người gọi MUST nhận thông báo thay thế có thể cấu hình và mã lý do, đúng định dạng giao thức.
- **FR-064**: Ở chế độ chặn với phát trực tiếp, nội dung vi phạm MUST NOT tới người gọi; hệ thống MUST giữ lại một cửa sổ nội dung đủ để phát hiện, với độ trễ thêm có giới hạn cấu hình được, và kết thúc luồng đúng định dạng.
- **FR-065**: Dữ liệu nhạy cảm trong đầu ra MUST có lựa chọn che tại chỗ thay vì chặn cả câu trả lời.
- **FR-066**: Khi bộ kiểm tra bên ngoài lỗi hoặc quá hạn, hệ thống MUST làm theo lựa chọn cấu hình (cho qua hoặc chặn) và ghi nhận.
- **FR-067**: Mỗi vi phạm MUST tạo một sự kiện (thời điểm, client key, người dùng cuối, bộ kiểm tra, hành động) xem được trong dashboard; trích đoạn nội dung vi phạm chỉ hiển thị cho người có quyền riêng và có thời hạn lưu.
- **FR-068**: Chính sách đầu ra MUST áp dụng cho câu trả lời lấy từ cache, câu trả lời của quy trình điều phối và câu trả lời sau khi gọi công cụ.
- **FR-069**: Vai trò được miễn MUST được cấu hình tường minh và việc miễn MUST được ghi nhận.
- **FR-070**: Kiểm tra đầu vào hiện có MUST tiếp tục hoạt động không đổi; giao diện SHOULD trình bày đầu vào và đầu ra trong cùng một nơi.
- **FR-071**: Hệ thống MUST có công cụ thử chính sách: dán một đoạn văn bản và thấy bộ kiểm tra nào kích hoạt.

#### G. Điều phối đa bước, đa agent

- **FR-075**: Người có quyền MUST định nghĩa được agent (tên, chỉ dẫn có phiên bản, model hoặc nhóm model, công cụ, nguồn tri thức, chính sách) và quy trình (agent khởi đầu, các agent tham gia, luật chuyển giao, giới hạn).
- **FR-076**: Quy trình MUST có bản nháp và bản phát hành; chỉ bản phát hành nhận lưu lượng thật; MUST chạy thử được bản nháp.
- **FR-077**: Quy trình đã phát hành MUST gọi được qua các giao thức chat hiện có như một model có tên riêng, và chỉ với client key được cấp quyền dùng quy trình đó.
- **FR-078**: Hệ thống MUST hỗ trợ tối thiểu hai kiểu điều phối: một agent với vòng lặp công cụ; và nhiều agent với chuyển giao do agent điều phối quyết định.
- **FR-079**: Mỗi lần chạy MUST chịu giới hạn cứng về số bước, số lời gọi công cụ, tổng token, thời gian và số lần chuyển giao; chạm giới hạn MUST dừng có kiểm soát, trả kết quả tốt nhất hiện có và lý do dừng.
- **FR-080**: Hệ thống MUST phát hiện và cắt vòng lặp (lặp cùng lời gọi công cụ, chuyển giao qua lại).
- **FR-081**: Mỗi agent MUST chỉ dùng được công cụ và tri thức gán cho chính nó; chuyển giao MUST NOT chuyển quyền.
- **FR-082**: Hành động nhạy cảm trong lần chạy MUST tạm dừng lần chạy chờ duyệt; duyệt MUST tiếp tục từ đúng bước, từ chối MUST kết thúc có giải thích; yêu cầu chờ duyệt MUST có thời hạn.
- **FR-083**: Hành động có tác động bên ngoài MUST NOT bị thực thi hai lần do thử lại, duyệt trùng hoặc khởi động lại.
- **FR-084**: Mỗi lần chạy MUST có vết chạy theo bước (agent, model, công cụ, đầu vào/đầu ra đã che, token, thời lượng, lỗi, quyết định chuyển giao), xem được khi đang chạy và sau khi xong, có thời hạn lưu cấu hình được.
- **FR-085**: Người có quyền MUST hủy được lần chạy đang diễn ra; người gọi ngắt kết nối MUST dừng các bước chưa bắt đầu.
- **FR-086**: Toàn bộ mức sử dụng của lần chạy MUST tính vào hạn mức và phân tích của client key và người dùng cuối khởi tạo; hết hạn mức giữa chừng MUST dừng có kiểm soát.
- **FR-087**: Khi phát trực tiếp, người gọi MUST nhận câu trả lời cuối theo luồng và SHOULD nhận tín hiệu tiến độ theo cách client cũ bỏ qua được.
- **FR-088**: Kiểm tra đầu vào áp dụng cho tin nhắn của người gọi; kiểm tra đầu ra áp dụng cho câu trả lời cuối; kết quả công cụ và tin nhắn giữa các agent MUST qua che dữ liệu nhạy cảm.
- **FR-089**: Lần chạy bị gián đoạn do khởi động lại MUST được đánh dấu gián đoạn và hiển thị rõ; hệ thống MUST NOT tự chạy lại bước có tác động bên ngoài.
- **FR-090**: Auto router, chuỗi dự phòng, Fusion, Combos và pipeline support hiện có MUST giữ nguyên hành vi; agent MUST dùng được chúng làm model.

### Key Entities *(include if feature involves data)*

- **Công tắc trụ cột**: trạng thái bật/tắt và cấu hình chung của từng trụ cột.
- **Phiên bản chỉ dẫn**: nội dung bất biến của chỉ dẫn hệ thống, thuộc một client key hoặc tenant; có số thứ tự, trạng thái (nháp, phát hành, lưu trữ), người sửa, ghi chú, danh sách biến.
- **Biến chỉ dẫn**: tên, nguồn giá trị (hệ thống, người gọi, tùy chỉnh), giá trị mặc định.
- **Chỉ mục ngữ nghĩa**: biểu diễn ngữ nghĩa của từng đoạn tài liệu, gắn với mô hình embedding đã dùng và trạng thái (chờ, xong, lỗi).
- **Cấu hình truy hồi**: phương thức tìm, số đoạn, ngưỡng, bật trích dẫn; thuộc một bộ tri thức.
- **Trích dẫn**: tham chiếu từ một câu trả lời tới tài liệu và đoạn đã dùng.
- **Khả năng cache của nhà cung cấp**: nhà cung cấp/model có hỗ trợ điểm đánh dấu không, giới hạn số điểm, thời hạn.
- **Thống kê cache prompt**: token đọc/ghi cache và ước tính tiết kiệm theo yêu cầu, tổng hợp theo ngày.
- **Máy chủ MCP**: tên, địa chỉ, thông tin xác thực (mã hóa), trạng thái, tình trạng kết nối.
- **Công cụ MCP**: bản chụp tên, mô tả, tham số; trạng thái duyệt; phân loại đọc/ghi; thuộc một máy chủ.
- **Gán công cụ**: liên kết công cụ với client key, tenant hoặc agent.
- **Lời gọi công cụ**: bản ghi một lần gọi với tham số và kết quả đã che.
- **Chính sách đầu ra**: chế độ, các bộ kiểm tra, thông báo thay thế, hành vi khi lỗi, vai trò miễn; thuộc client key hoặc tenant.
- **Sự kiện vi phạm**: một lần chính sách kích hoạt, hành động đã làm, trích đoạn có thời hạn.
- **Agent**: tên, chỉ dẫn, model, công cụ, tri thức, chính sách.
- **Quy trình**: tập agent, agent khởi đầu, luật chuyển giao, giới hạn, phiên bản nháp/phát hành, client key được dùng.
- **Lần chạy**: một lần thực thi quy trình; trạng thái (đang chạy, chờ duyệt, xong, dừng do giới hạn, hủy, lỗi, gián đoạn), mức sử dụng.
- **Bước chạy**: một hành động trong lần chạy (gọi model, gọi công cụ, chuyển giao, chờ duyệt) với dữ liệu đã che.
- **Yêu cầu duyệt**: hành động nhạy cảm chờ quyết định, người quyết định, thời hạn.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sau nâng cấp và trước khi bật bất kỳ trụ cột nào, 100% ca kiểm thử hồi quy của các endpoint công khai và dashboard hiện có vẫn đạt, và yêu cầu gửi tới nhà cung cấp giống hệt bản trước.
- **SC-002**: Khi mọi trụ cột tắt, thời gian xử lý thêm của gateway cho một yêu cầu chat tăng không quá 5% so với bản trước.
- **SC-003**: Quản trị viên đăng ký một máy chủ công cụ, chọn công cụ và gắn cho một client key trong dưới 5 phút mà không cần đọc tài liệu.
- **SC-004**: 100% ca thử kết nối tới địa chỉ nội bộ, vòng lặp, siêu dữ liệu (kể cả qua chuyển hướng và phân giải tên) bị chặn.
- **SC-005**: 0 bí mật xuất hiện trong log, vết chạy, nhật ký kiểm toán và bản xuất ở bộ kiểm thử rò rỉ.
- **SC-006**: Ở chế độ chặn, 100% câu trả lời vi phạm trong bộ kiểm thử (cả một lần lẫn phát trực tiếp) không tới người gọi; tỷ lệ chặn nhầm trên bộ câu trả lời hợp lệ dưới 2% với các bộ kiểm tra không dùng mô hình.
- **SC-007**: Chính sách đầu ra không dùng bộ kiểm tra bên ngoài làm chậm thời điểm nhận ký tự đầu tiên khi phát trực tiếp không quá 300 ms ở cấu hình mặc định.
- **SC-008**: Trên bộ câu hỏi diễn đạt lại, tỷ lệ tìm đúng đoạn trong 5 kết quả đầu của chế độ kết hợp cao hơn chế độ từ khóa ít nhất 25 điểm phần trăm.
- **SC-009**: Khi nhà cung cấp embedding ngừng hoạt động, 100% yêu cầu chat có tri thức vẫn được trả lời bằng tìm theo từ khóa.
- **SC-010**: Tài liệu mới 50 trang sẵn sàng cho tìm kiếm ngữ nghĩa trong dưới 2 phút; trong lúc lập chỉ mục, độ trễ chat không tăng quá 10%.
- **SC-011**: Với client có phần đầu ổn định dài và nhà cung cấp hỗ trợ cache, từ yêu cầu thứ hai trở đi ít nhất 70% token đầu vào được tính ở mức đã cache, và dashboard hiển thị con số này trong vòng 1 phút.
- **SC-012**: Quay về phiên bản chỉ dẫn trước mất dưới 30 giây và có hiệu lực ngay với yêu cầu kế tiếp.
- **SC-013**: 100% lần chạy quy trình dừng trong các giới hạn đã cấu hình; không lần chạy nào vượt giới hạn token quá một bước.
- **SC-014**: 0 hành động có tác động bên ngoài bị thực thi lặp trong các ca thử duyệt đồng thời, thử lại và khởi động lại.
- **SC-015**: Với một lần chạy bất kỳ, người có quyền tìm ra bước gây lỗi hoặc gây dừng từ vết chạy trong dưới 1 phút.
- **SC-016**: Mỗi quyền mới chỉ mở đúng các thao tác của nó trong 100% ca thử ma trận quyền; mọi thao tác thay đổi cấu hình đều có mục nhật ký tương ứng.
- **SC-017**: Toàn bộ chuỗi giao diện mới có bản tiếng Việt; không còn khóa dịch thiếu.

## Assumptions

- Phạm vi là một chương trình nâng cấp gồm 7 trụ cột, giao theo từng giai đoạn độc lập theo thứ tự ưu tiên của các user story; mỗi giai đoạn tự triển khai và kiểm thử được.
- Mọi tính năng mới là mã riêng của bản tùy biến này: tệp mới, migration mới, chỉ chạm tối thiểu vào các điểm móc của mã upstream; không sửa migration cũ.
- Tìm kiếm ngữ nghĩa dùng khả năng embedding mà gateway đã định tuyến được; lưu chỉ mục ngay trong cơ sở dữ liệu hiện có, không yêu cầu dịch vụ ngoài. Quy mô mục tiêu: tới khoảng 50.000 đoạn cho mỗi bộ tri thức.
- MCP client chỉ hỗ trợ truyền qua HTTP; không khởi chạy tiến trình cục bộ (để không chạy mã tùy ý trên máy chủ và phù hợp triển khai đám mây). Chỉ hỗ trợ nhóm tính năng công cụ của MCP; tài nguyên, prompt và lấy mẫu ngược nằm ngoài phạm vi.
- Xác thực tới máy chủ MCP dùng header tĩnh hoặc bearer token; luồng OAuth tương tác nằm ngoài phạm vi đợt này.
- Cache prompt phía nhà cung cấp chỉ áp dụng cho nhà cung cấp có cơ chế điểm đánh dấu tường minh; nhà cung cấp tự cache ngầm chỉ được ghi nhận số liệu.
- Cache câu trả lời khớp chính xác hiện có giữ nguyên; không bổ sung cache ngữ nghĩa cho câu trả lời.
- Điều phối chạy trong tiến trình hiện có và trong thời gian một yêu cầu, trừ khi chờ duyệt; lịch chạy định kỳ, quy trình kéo dài nhiều giờ và trình thiết kế kéo-thả nằm ngoài phạm vi.
- Luồng duyệt hành động nhạy cảm dùng lại cơ chế duyệt và chống thực thi trùng đã có của support runtime.
- Che dữ liệu nhạy cảm dùng lại bộ che hiện có; không bổ sung bộ nhận diện mới ngoài mẫu tùy chỉnh.
- Thời hạn lưu mặc định: vết chạy và lời gọi công cụ 30 ngày, trích đoạn vi phạm 7 ngày; quản trị viên chỉnh được.
- Người dùng mục tiêu là chủ hệ thống, quản trị viên và thành viên được phân quyền của dashboard; người dùng cuối chỉ thấy tác động qua câu trả lời.
- Ứng dụng desktop và CLI không cần giao diện mới trong đợt này nhưng phải tiếp tục hoạt động.
