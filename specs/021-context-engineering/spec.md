# Feature Specification: Lắp ráp ngữ cảnh có ngân sách token (Context Engineering)

**Feature Branch**: `claude/beautiful-goldberg-6uxvyu`

**Feature Directory**: `specs/021-context-engineering`

**Created**: 2026-11-17

**Status**: Draft

**Input**: User description: "Context Engineering cho gateway đa ứng dụng, đa người dùng: thống nhất 5 thành phần Conversation Storage, Context Manager, Conversation Summarizer, RAG Retrieval, Token Budget Manager thành một pipeline lắp ráp ngữ cảnh có ngân sách token; không mặc định gửi toàn bộ lịch sử vô hạn."

## Bối cảnh: hiện trạng đã rà soát (2026-11-17)

Đề xuất 5 thành phần là đúng hướng, nhưng gateway **đã có sẵn 4/5 thành phần ở dạng rời rạc**. Phần còn thiếu là bộ quản lý ngân sách chung và một thứ tự lắp ráp thống nhất. Vì vậy spec này **không xây lại** các thành phần đã có mà nối chúng vào một ngân sách chung.

| Thành phần | Đã có | Khoảng trống cần lấp |
|---|---|---|
| Conversation Storage | Hội thoại lưu phía server theo client key + end user (`X-Conversation-Id`), có TTL, dọn tự động; hội thoại Playground lưu riêng | Không cần thay đổi lớn; chỉ cần cung cấp lượt hội thoại cho bộ lắp ráp theo ngân sách token |
| Context Manager | Cửa sổ trượt: lấy N tin mới nhất trong giới hạn **số tin** và **số ký tự** (mặc định 20 tin / 12.000 ký tự), luôn bắt đầu bằng lượt của người dùng | Giới hạn tính bằng ký tự, không phải token; không biết model đích có cửa sổ bao nhiêu; không có thứ tự ưu tiên chung giữa lịch sử, tóm tắt, tri thức |
| Conversation Summarizer | Tóm tắt cuốn chiếu chạy nền sau mỗi lượt, gộp các lượt rơi khỏi cửa sổ, gọi model qua chính key đó | Kích hoạt theo số tin/ký tự chứ không theo áp lực ngân sách; độ dài tóm tắt không nằm trong ngân sách chung |
| RAG Retrieval | Tri thức theo client key (tìm theo từ khóa) và truy hồi lai có ngữ nghĩa + trích dẫn (spec 018) | Giới hạn bằng ký tự riêng (mặc định 3.000), không phối hợp với lịch sử; có thể chèn đoạn trùng nội dung với lịch sử |
| Token Budget Manager | Router loại các model có cửa sổ ngữ cảnh nhỏ hơn ước lượng đầu vào; bộ nén có chế độ cắt theo số token mục tiêu (toàn cục, không theo model) | **Chưa có**: mỗi thành phần tự giới hạn riêng, tổng cộng có thể vượt cửa sổ model; không có trần chi phí đầu vào theo key; khi chuyển sang model dự phòng nhỏ hơn thì yêu cầu bị loại thay vì được thu gọn |

Nhận định về nguyên tắc "không mặc định gửi toàn bộ lịch sử vô hạn":
- Với hội thoại lưu phía server, gateway **đã** không gửi vô hạn (có cửa sổ trượt). Spec này đổi đơn vị đo sang token và gắn vào ngân sách theo model.
- Với ứng dụng **tự gửi toàn bộ lịch sử** (kiểu OpenAI chuẩn, không dùng `X-Conversation-Id`), gateway hiện chuyển nguyên văn. Việc tự ý cắt lịch sử của client sẽ phá tương thích giao thức `/v1` (Hiến pháp, nguyên tắc V), nên phần này **chỉ bật khi quản trị viên chọn**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mỗi yêu cầu được lắp ráp trong một ngân sách token chung (Priority: P1)

Quản trị viên bật "chính sách ngữ cảnh" cho một client key mà ứng dụng chat của họ dùng hội thoại lưu phía server. Từ đó, mỗi yêu cầu được lắp từ các phần theo thứ tự ưu tiên cố định (chỉ dẫn hệ thống, tin nhắn mới của người dùng, tóm tắt, tri thức liên quan, lịch sử gần nhất) sao cho tổng không vượt ngân sách của key và không vượt cửa sổ ngữ cảnh của model thực sự phục vụ. Hội thoại dài bao nhiêu thì số token gửi đi mỗi lượt vẫn chững lại quanh ngân sách, không tăng mãi.

**Why this priority**: Đây là thành phần còn thiếu và là điều kiện để 4 thành phần còn lại phối hợp được. Không có nó, các giới hạn riêng lẻ cộng lại vẫn có thể vượt cửa sổ model hoặc đốt quota của tài khoản miễn phí.

**Independent Test**: Tạo một key bật chính sách với ngân sách 4.000 token, phát lại một hội thoại 300 lượt; kiểm tra mọi yêu cầu gửi đi đều nằm trong ngân sách, tin nhắn mới và chỉ dẫn hệ thống luôn còn nguyên, và không yêu cầu nào bị nhà cung cấp từ chối vì quá dài.

**Acceptance Scenarios**:

1. **Given** một key bật chính sách với ngân sách đầu vào 4.000 token, **When** hội thoại vượt quá ngân sách, **Then** các lượt cũ nhất bị bỏ trước, tin nhắn mới và chỉ dẫn hệ thống không bị cắt, và tổng đầu vào ước lượng ≤ 4.000 token.
2. **Given** model được chọn có cửa sổ 8.000 token và key dành 1.000 token cho câu trả lời, **When** ngân sách của key là 32.000 token, **Then** ngân sách hiệu lực của yêu cầu là phần nhỏ hơn giữa ngân sách key và (cửa sổ model − phần dành cho câu trả lời − biên an toàn).
3. **Given** model chính lỗi và chuỗi dự phòng chuyển sang một model có cửa sổ nhỏ hơn, **When** ngữ cảnh đã lắp vượt cửa sổ của model dự phòng, **Then** ngữ cảnh được thu gọn lại cho model dự phòng theo cùng thứ tự ưu tiên thay vì loại model đó hoặc gửi đi một yêu cầu quá dài.
4. **Given** riêng chỉ dẫn hệ thống cộng tin nhắn mới đã vượt ngân sách hiệu lực, **When** yêu cầu đến, **Then** gateway từ chối với mã lỗi rõ ràng nêu số token ước lượng và ngân sách, không âm thầm cắt tin nhắn của người dùng.
5. **Given** một key **không** bật chính sách, **When** nâng cấp lên bản mới, **Then** yêu cầu gửi tới nhà cung cấp giống hệt trước nâng cấp.

---

### User Story 2 - Thấy được ngữ cảnh đã được lắp như thế nào (Priority: P1)

Nhà phát triển ứng dụng và quản trị viên cần biết vì sao model "quên" một chi tiết. Mỗi phản hồi cho biết ngân sách hiệu lực, số token của từng phần (chỉ dẫn, tóm tắt, tri thức, lịch sử, tin nhắn mới) và số lượt/đoạn đã bị bỏ. Trên dashboard, quản trị viên có thể xem trước ngữ cảnh mà một hội thoại cụ thể sẽ được gửi đi ở lượt tiếp theo, và xem thống kê theo key.

**Why this priority**: Cắt ngữ cảnh là thao tác làm mất thông tin; không minh bạch thì người dùng sẽ coi đó là lỗi. Đây cũng là cách duy nhất để chỉnh ngân sách có căn cứ.

**Independent Test**: Gửi một yêu cầu qua key bật chính sách, đọc thông tin phân bổ trong phản hồi và trong nhật ký yêu cầu; mở màn hình xem trước của cùng hội thoại và đối chiếu các con số.

**Acceptance Scenarios**:

1. **Given** key bật chính sách, **When** một yêu cầu hoàn tất, **Then** phản hồi kèm thông tin phân bổ (ngân sách hiệu lực, token theo từng phần, số lượt lịch sử và số đoạn tri thức đã dùng/bị bỏ) mà không làm thay đổi thân phản hồi theo giao thức chuẩn.
2. **Given** quản trị viên có quyền xem hội thoại của key, **When** mở xem trước một hội thoại, **Then** thấy danh sách các phần sẽ được gửi, thứ tự, số token từng phần và những gì bị bỏ, mà không phát sinh lời gọi tới nhà cung cấp.
3. **Given** nhật ký yêu cầu, **When** xem chi tiết một yêu cầu, **Then** thấy số liệu phân bổ nhưng không thấy nội dung tin nhắn trừ khi chế độ lưu nội dung hiện có đã được bật.
4. **Given** một quản trị viên không có quyền xem hội thoại của key, **When** gọi xem trước, **Then** bị từ chối.

---

### User Story 3 - Tóm tắt kích hoạt theo áp lực ngân sách (Priority: P2)

Khi lịch sử không còn vừa phần ngân sách dành cho nó, các lượt rơi ra được gộp vào bản tóm tắt cuốn chiếu của hội thoại, để model vẫn nhớ tên, số liệu, mã đơn hàng và yêu cầu còn dang dở. Bản tóm tắt chiếm một phần ngân sách có giới hạn và luôn được ưu tiên hơn lịch sử cũ.

**Why this priority**: Không có tóm tắt, cửa sổ trượt làm hội thoại dài "mất trí nhớ". Tóm tắt đã có sẵn, chỉ cần đổi điều kiện kích hoạt và đưa vào ngân sách, nên đứng sau US1.

**Independent Test**: Phát lại một hội thoại dài có 20 sự kiện được nêu ở các lượt đầu; sau khi các lượt đó rơi khỏi cửa sổ, đặt câu hỏi về từng sự kiện và đếm số câu trả lời đúng.

**Acceptance Scenarios**:

1. **Given** key bật tóm tắt, **When** có lượt bị loại khỏi lịch sử vì ngân sách, **Then** lượt đó được gộp vào tóm tắt trong lần cập nhật tóm tắt kế tiếp và không bị gộp hai lần.
2. **Given** việc tạo tóm tắt thất bại hoặc quá thời gian, **When** lượt tiếp theo đến, **Then** yêu cầu vẫn được phục vụ bằng tóm tắt cũ (nếu có) cộng cửa sổ trượt, và lần sau sẽ thử gộp lại.
3. **Given** tóm tắt dài hơn phần ngân sách dành cho nó, **When** lắp ngữ cảnh, **Then** tóm tắt được rút gọn lại ở lần cập nhật kế tiếp; trong lúc chờ, phần vượt bị cắt ở ranh giới câu.
4. **Given** hai end user dùng chung một key, **When** mỗi người có hội thoại riêng, **Then** tóm tắt của người này không bao giờ xuất hiện trong ngữ cảnh của người kia.

---

### User Story 4 - Tri thức truy hồi được chia ngân sách cùng lịch sử (Priority: P2)

Khi key có kho tri thức, các đoạn liên quan nhất được đưa vào trong một phần ngân sách riêng, xếp theo độ liên quan, không trùng với nội dung đã có trong lịch sử hoặc tóm tắt, và bị bỏ hẳn nếu không đủ liên quan. Phần ngân sách tri thức không dùng hết thì nhường cho lịch sử.

**Why this priority**: RAG đã có; giá trị tăng thêm là không để tri thức và lịch sử chen lấn vượt cửa sổ, và không tốn token cho đoạn không liên quan.

**Independent Test**: Với một kho tri thức đã biết, gửi câu hỏi liên quan và không liên quan; kiểm tra số đoạn được chèn, thứ tự, tổng token so với phần ngân sách, và việc lịch sử được nhận phần dư.

**Acceptance Scenarios**:

1. **Given** phần ngân sách tri thức là 1.500 token, **When** có 6 đoạn liên quan tổng 3.000 token, **Then** chỉ các đoạn liên quan nhất vừa trong 1.500 token được chèn, mỗi đoạn được giữ nguyên vẹn (không cắt giữa đoạn).
2. **Given** câu hỏi không khớp đoạn nào vượt ngưỡng liên quan, **When** lắp ngữ cảnh, **Then** không chèn tri thức và toàn bộ phần ngân sách đó được nhường cho lịch sử.
3. **Given** một đoạn tri thức trùng gần như hoàn toàn với một lượt đã có trong lịch sử được gửi, **When** lắp ngữ cảnh, **Then** đoạn đó không được chèn lần nữa.
4. **Given** trích dẫn nguồn đang bật (spec 018), **When** tri thức bị bỏ vì ngân sách, **Then** trích dẫn chỉ liệt kê các đoạn thực sự đã gửi.

---

### User Story 5 - Bảo vệ ngân sách cho ứng dụng tự gửi toàn bộ lịch sử (Priority: P3)

Một số ứng dụng gửi cả lịch sử trong mỗi yêu cầu (giao thức OpenAI/Anthropic/Gemini chuẩn). Quản trị viên có thể chọn cho key đó một trong ba chế độ: giữ nguyên (mặc định), chỉ thu gọn khi vượt cửa sổ model, hoặc luôn áp ngân sách của key. Khi thu gọn, gateway giữ nguyên chỉ dẫn hệ thống, tin nhắn cuối và chuỗi gọi công cụ đang dở.

**Why this priority**: Giảm chi phí và lỗi "context length exceeded" cho ứng dụng không dùng hội thoại phía server, nhưng thay đổi ngữ nghĩa giao thức nên chỉ là tùy chọn và đứng sau.

**Independent Test**: Gửi cùng một yêu cầu 200 tin qua ba key với ba chế độ; xác nhận chế độ mặc định chuyển nguyên văn, hai chế độ còn lại thu gọn đúng quy tắc và báo cáo phân bổ như US2.

**Acceptance Scenarios**:

1. **Given** key ở chế độ "giữ nguyên", **When** client gửi 200 tin, **Then** yêu cầu được chuyển nguyên văn như hiện nay (model nhỏ vẫn bị router loại như trước).
2. **Given** key ở chế độ "thu gọn khi vượt cửa sổ", **When** lịch sử vượt cửa sổ của mọi model khả dụng, **Then** các tin cũ nhất bị bỏ cho tới khi vừa, thay vì trả lỗi không có model phù hợp.
3. **Given** lịch sử chứa một lời gọi công cụ và kết quả của nó, **When** thu gọn, **Then** lời gọi và kết quả luôn bị bỏ hoặc giữ cùng nhau, không bao giờ tách rời.
4. **Given** key ở chế độ "luôn áp ngân sách" và bật tóm tắt, **When** thu gọn, **Then** không tạo tóm tắt cho lịch sử do client gửi (gateway không có danh tính hội thoại bền vững để lưu tóm tắt) và phản hồi ghi rõ số tin đã bỏ.

---

### Edge Cases

- Cửa sổ ngữ cảnh của model chưa biết: dùng ngân sách của key; nếu key cũng không đặt thì dùng mức mặc định thận trọng do quản trị viên cấu hình toàn hệ thống.
- Tin nhắn có ảnh hoặc tệp đính kèm: mỗi phần không phải văn bản được tính theo một mức token ước lượng cố định cấu hình được; không bao giờ cắt giữa một phần đính kèm.
- Ngôn ngữ có tỷ lệ token/ký tự cao (tiếng Việt, tiếng Trung, tiếng Nhật): ước lượng phải không đánh giá thấp quá biên an toàn với các ngôn ngữ này.
- Chỉ dẫn hệ thống bắt buộc của key (prompt ép phía server, spec 018) và đoạn chuyển giao khi đổi model (context handoff) được tính vào ngân sách, thuộc nhóm không được cắt.
- Lượt đầu tiên rơi vào ranh giới cắt là lượt trả lời của trợ lý: lịch sử gửi đi vẫn phải bắt đầu bằng một lượt của người dùng (giữ quy tắc hiện có).
- Bộ nén (compression) đang bật cho key: thu gọn theo ngân sách chạy trước, bộ nén chạy sau trên ngữ cảnh đã thu gọn; ngân sách không tính lại theo kết quả nén.
- Cache prompt của nhà cung cấp: việc bỏ lượt cũ không được làm đổi phần đầu ngữ cảnh ở **mỗi** lượt; lịch sử được bỏ theo khối để phần đầu ổn định qua nhiều lượt liên tiếp.
- Hai yêu cầu đồng thời cùng một hội thoại: mỗi yêu cầu lắp theo dữ liệu đã lưu tại thời điểm nó đến; không yêu cầu nào thấy tóm tắt viết dở.
- Hội thoại bị xóa hoặc hết hạn giữa chừng: yêu cầu được phục vụ như hội thoại mới, không lỗi.
- Ngân sách đặt quá nhỏ so với phần bắt buộc: hệ thống từ chối lưu cấu hình nếu ngân sách nhỏ hơn mức tối thiểu cho phép.

## Requirements *(mandatory)*

### Functional Requirements

#### A. Chính sách ngữ cảnh và tương thích ngược

- **FR-001**: Hệ thống MUST cho phép quản trị viên bật/tắt "chính sách ngữ cảnh" cho từng client key; mặc định **tắt** cho mọi key hiện có và key mới, trừ khi quản trị viên đặt mặc định khác ở cấp hệ thống.
- **FR-002**: Khi chính sách tắt, yêu cầu gửi tới nhà cung cấp MUST giống hệt hành vi trước nâng cấp (bao gồm cửa sổ trượt theo số tin/ký tự hiện có).
- **FR-003**: Chính sách MUST có ba mức đặt sẵn — Tiết kiệm, Cân bằng, Tối đa ngữ cảnh — và chế độ tùy chỉnh cho: ngân sách đầu vào tối đa (token), phần dành cho câu trả lời, biên an toàn, tỷ lệ phân bổ giữa tóm tắt / tri thức / lịch sử, bật/tắt tóm tắt, và chế độ xử lý lịch sử do client gửi.
- **FR-004**: Khi bật chính sách cho key đang dùng giới hạn số tin/ký tự, các giá trị cũ MUST được chuyển đổi sang giá trị token tương đương hiển thị cho quản trị viên xác nhận; giới hạn số tin tối đa vẫn được tôn trọng như một trần bổ sung.
- **FR-005**: Các endpoint công khai (`/v1/*`, `/livez`, `/readyz`, `/api/ping`) và triển khai single-user MUST tiếp tục hoạt động không cần cấu hình thêm.

#### B. Bộ quản lý ngân sách token (Token Budget Manager)

- **FR-006**: Với mỗi yêu cầu thuộc key bật chính sách, hệ thống MUST tính ngân sách hiệu lực = nhỏ nhất giữa (ngân sách đầu vào của key) và (cửa sổ ngữ cảnh của model đích − phần dành cho câu trả lời − biên an toàn).
- **FR-007**: Phần dành cho câu trả lời MUST lấy theo số token đầu ra mà client yêu cầu nếu có, nếu không thì theo cấu hình của key.
- **FR-008**: Hệ thống MUST ước lượng token cho từng phần ngữ cảnh theo cùng một phương pháp ở mọi giao thức chat (OpenAI, Anthropic, Responses, Gemini) và MUST đối chiếu với số token đầu vào nhà cung cấp báo về để theo dõi sai số.
- **FR-009**: Tổng token ước lượng của ngữ cảnh đã lắp MUST không vượt ngân sách hiệu lực.
- **FR-010**: Khi chuỗi dự phòng chuyển sang model có cửa sổ nhỏ hơn ngân sách đã dùng, hệ thống MUST lắp lại ngữ cảnh cho model đó theo cùng quy tắc ưu tiên trước khi gửi.
- **FR-011**: Khi phần bắt buộc (chỉ dẫn hệ thống, prompt ép của key, tin nhắn mới, chuỗi gọi công cụ đang dở) đã vượt ngân sách hiệu lực của mọi model khả dụng, hệ thống MUST từ chối yêu cầu với mã lỗi riêng, kèm số token ước lượng và ngân sách, theo định dạng lỗi của giao thức tương ứng.

#### C. Bộ lắp ráp ngữ cảnh (Context Manager)

- **FR-012**: Ngữ cảnh MUST được lắp theo thứ tự ưu tiên cố định; khi thiếu ngân sách, phần ưu tiên thấp hơn bị thu gọn trước: (1) phần bắt buộc — không bao giờ bị cắt; (2) tóm tắt hội thoại; (3) tri thức truy hồi; (4) lịch sử gần nhất, bỏ từ lượt cũ nhất.
- **FR-013**: Phần ngân sách không dùng hết của tóm tắt hoặc tri thức MUST được nhường cho lịch sử.
- **FR-014**: Lịch sử MUST được bỏ theo nguyên lượt (không cắt giữa tin nhắn), luôn bắt đầu bằng lượt của người dùng, và giữ nguyên cặp lời gọi công cụ – kết quả.
- **FR-015**: Lịch sử MUST được bỏ theo khối có kích thước cấu hình được, để phần đầu ngữ cảnh giữ ổn định qua nhiều lượt liên tiếp và không làm mất hiệu quả cache prompt của nhà cung cấp.
- **FR-016**: Vị trí đặt tóm tắt và tri thức trong yêu cầu MUST theo đúng quy ước hiện có của từng giao thức (sau chỉ dẫn của ứng dụng, trước lịch sử).

#### D. Tóm tắt hội thoại (Conversation Summarizer)

- **FR-017**: Khi tóm tắt bật, các lượt bị loại khỏi lịch sử vì ngân sách MUST được đưa vào hàng chờ gộp tóm tắt; điều kiện kích hoạt là áp lực ngân sách (token), không chỉ số tin.
- **FR-018**: Mỗi lượt MUST được gộp vào tóm tắt đúng một lần; hệ thống MUST ghi nhận tóm tắt đã bao phủ tới lượt nào.
- **FR-019**: Tóm tắt MUST giữ nguyên tên riêng, con số, mã định danh, ngày tháng và các yêu cầu còn dang dở; độ dài tóm tắt MUST không vượt phần ngân sách dành cho nó.
- **FR-020**: Việc tạo tóm tắt MUST không làm chậm hoặc làm hỏng yêu cầu của người dùng; khi thất bại, hệ thống dùng tóm tắt cũ cùng cửa sổ trượt và thử lại ở lần sau.
- **FR-021**: Chi phí lời gọi tạo tóm tắt MUST được tính vào hạn mức và thống kê của chính key đó (giữ cơ chế hiện có) và được đánh dấu là lời gọi nội bộ trong nhật ký.
- **FR-022**: Tóm tắt MUST được cô lập theo hội thoại và end user; không bao giờ dùng tóm tắt của hội thoại hoặc end user khác.

#### E. Tri thức truy hồi (RAG Retrieval)

- **FR-023**: Tri thức truy hồi MUST nằm trong phần ngân sách tri thức; đoạn được chọn theo độ liên quan giảm dần và chỉ khi vượt ngưỡng liên quan cấu hình được.
- **FR-024**: Mỗi đoạn tri thức MUST được giữ nguyên vẹn hoặc bỏ hẳn, không cắt giữa đoạn.
- **FR-025**: Đoạn tri thức trùng nội dung với lịch sử hoặc tóm tắt đang được gửi MUST không được chèn lại.
- **FR-026**: Trích dẫn nguồn (nếu bật) MUST chỉ liệt kê các đoạn thực sự đã gửi tới model.

#### F. Lịch sử do client gửi

- **FR-027**: Mỗi key MUST có chế độ xử lý lịch sử do client gửi: **Giữ nguyên** (mặc định), **Thu gọn khi vượt cửa sổ**, **Luôn áp ngân sách**.
- **FR-028**: Ở hai chế độ thu gọn, hệ thống MUST áp các quy tắc FR-012 đến FR-015 lên lịch sử do client gửi và MUST không tạo hay lưu tóm tắt cho lịch sử đó.

#### G. Quan sát, xem trước, phân quyền

- **FR-029**: Với mỗi yêu cầu thuộc key bật chính sách, phản hồi MUST kèm thông tin phân bổ (ngân sách hiệu lực, token từng phần, số lượt/đoạn đã dùng và đã bỏ, tóm tắt có được dùng không) qua kênh siêu dữ liệu không làm thay đổi thân phản hồi chuẩn.
- **FR-030**: Nhật ký yêu cầu MUST lưu số liệu phân bổ, không lưu nội dung ngoài phạm vi chế độ lưu nội dung hiện có.
- **FR-031**: Dashboard MUST cho phép xem trước ngữ cảnh lượt kế tiếp của một hội thoại đã lưu mà không gọi nhà cung cấp.
- **FR-032**: Dashboard MUST hiển thị thống kê theo key: token đầu vào trung bình mỗi yêu cầu, tỷ lệ yêu cầu bị thu gọn, token tiết kiệm so với gửi toàn bộ lịch sử, sai số ước lượng so với số nhà cung cấp báo về.
- **FR-033**: Thay đổi chính sách ngữ cảnh và thao tác xem trước MUST yêu cầu quyền riêng trong hệ thống phân quyền hiện có và MUST được ghi vào audit log (thay đổi cấu hình).

### Key Entities

- **Chính sách ngữ cảnh (Context Policy)**: thuộc một client key (có thể có mặc định cấp hệ thống). Thuộc tính: bật/tắt, mức đặt sẵn, ngân sách đầu vào tối đa, phần dành cho câu trả lời, biên an toàn, tỷ lệ phân bổ tóm tắt/tri thức/lịch sử, kích thước khối bỏ lịch sử, bật tóm tắt, chế độ lịch sử do client gửi.
- **Phần ngữ cảnh (Context Segment)**: một thành phần của yêu cầu đã lắp — loại (bắt buộc, tóm tắt, tri thức, lịch sử, tin mới), mức ưu tiên, số token ước lượng, nguồn gốc.
- **Báo cáo lắp ráp (Context Assembly Report)**: kết quả của một lần lắp — ngân sách hiệu lực, model đích, token theo từng loại phần, số lượt/đoạn bị bỏ, lý do; gắn với một yêu cầu trong nhật ký.
- **Hội thoại lưu phía server** *(đã có)*: thuộc key + end user; chứa các lượt, bản tóm tắt cuốn chiếu và mốc lượt mà tóm tắt đã bao phủ.
- **Đoạn tri thức** *(đã có)*: đoạn văn từ kho tri thức của key, có điểm liên quan với câu hỏi hiện tại.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Trong bộ kiểm thử phát lại hội thoại dài tới 500 lượt qua key bật chính sách, 0 yêu cầu bị nhà cung cấp từ chối vì vượt độ dài ngữ cảnh.
- **SC-002**: 100% yêu cầu thuộc key bật chính sách có tổng đầu vào ước lượng không vượt ngân sách hiệu lực; từ lượt 50 trở đi, token đầu vào mỗi lượt dao động trong ±10% quanh một mức ổn định thay vì tăng theo số lượt.
- **SC-003**: Với hội thoại trên 50 lượt, tổng token đầu vào giảm ít nhất 60% so với gửi toàn bộ lịch sử.
- **SC-004**: Khi bật tóm tắt, ít nhất 90% trong 20 sự kiện được nêu ở đầu hội thoại vẫn được trả lời đúng sau khi các lượt chứa chúng đã rơi khỏi lịch sử.
- **SC-005**: Ước lượng token nằm trong ±15% so với số token đầu vào nhà cung cấp báo về ở ít nhất 95% yêu cầu có báo cáo usage, kể cả hội thoại tiếng Việt.
- **SC-006**: Với key tắt chính sách, 100% yêu cầu trong bộ kiểm thử hồi quy gửi tới nhà cung cấp nội dung giống hệt trước nâng cấp.
- **SC-007**: Thời gian lắp ráp ngữ cảnh (không tính lời gọi tạo tóm tắt chạy nền) làm tăng độ trễ phản hồi không quá 50 ms ở bách phân vị 95 với hội thoại tới 1.000 tin đã lưu.
- **SC-008**: Quản trị viên tìm ra lý do một chi tiết bị "quên" (bị bỏ vì ngân sách, không vượt ngưỡng liên quan, hay chưa được gộp vào tóm tắt) trong vòng 2 phút bằng màn hình xem trước hoặc chi tiết nhật ký.

## Assumptions

- Mọi thành phần mới mặc định tắt; key hiện có giữ nguyên hành vi cho tới khi quản trị viên bật (Hiến pháp, nguyên tắc V).
- Lịch sử do client tự gửi mặc định được chuyển nguyên văn; thu gọn chỉ khi quản trị viên chọn, vì cắt lịch sử của client làm thay đổi ngữ nghĩa giao thức chuẩn.
- Giá trị gợi ý cho mức Cân bằng: ngân sách đầu vào 16.000 token, phần dành cho câu trả lời 1.024 token, biên an toàn 10%, phân bổ tóm tắt 15% / tri thức 25% / lịch sử phần còn lại. Mức Tiết kiệm và Tối đa ngữ cảnh được xác định trong bước lập kế hoạch.
- Ước lượng token dùng phương pháp gần đúng không phụ thuộc nhà cung cấp, có biên an toàn; không yêu cầu bộ đếm token chính xác của từng nhà cung cấp.
- Tái sử dụng kho hội thoại, cơ chế tóm tắt chạy nền, kho tri thức và truy hồi lai đã có; không thay đổi cấu trúc lưu trữ ngoài việc bổ sung bằng migration mới (Hiến pháp, nguyên tắc VI).
- Hội thoại Playground của dashboard (lưu toàn bộ transcript phía trình duyệt quản trị) nằm ngoài phạm vi; có thể áp dụng sau qua chế độ lịch sử do client gửi.
- Truy hồi trí nhớ dài hạn xuyên hội thoại (ghi nhớ người dùng qua nhiều phiên) nằm ngoài phạm vi spec này.
- Hệ thống phân quyền, audit log và nhật ký yêu cầu hiện có được dùng lại cho quyền và dấu vết mới.
