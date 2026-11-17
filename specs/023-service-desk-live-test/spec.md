# Feature Specification: Thử nghiệm trực tiếp Widget người dùng cuối theo Tenant trong Service Desk Studio

**Feature Branch**: `feat/023-service-desk-live-test`

**Feature Directory**: `specs/023-service-desk-live-test`

**Created**: 2026-11-18

**Status**: Hoàn thành — xem [specs/README.md](../README.md)

**Input**: User description: "Ở trang Service Desk Studio (/thruline/support-desk), không chỉ tùy biến giao diện mà còn có thể test trực tiếp theo từng tenant được chọn về AI, các tính năng, RAG, phân quyền,... tất cả các tính năng mà người dùng cuối có thể thấy và chat với AI như nào thì ở đây y hệt như thế."

## Bối cảnh: hiện trạng đã rà soát (2026-11-18)

Người quản trị hiện phải mở nhiều màn hình rời rạc hoặc tự nhúng widget lên một trang web bên ngoài mới kiểm thử được trọn vẹn trải nghiệm thực tế của người dùng cuối.

| Thành phần hiện có | Thực trạng | Khoảng trống cần lấp |
|---|---|---|
| Khung xem trước ở Service Desk Studio (`/thruline/support-desk`) | Chỉ hiển thị bản xem trước giao diện tĩnh và chặn toàn bộ kết nối xử lý; ô nhập tin nhắn, nút gửi, khảo sát trước chat và câu hỏi gợi ý đều bị khóa, không phản hồi. | Chưa có chế độ bật thử nghiệm trực tiếp để người vận hành tương tác thật với AI, khảo sát, RAG, phân quyền và vòng đời hỗ trợ ngay tại màn hình tùy biến widget. |
| Trình mô phỏng cũ ở trang AI Support | Chỉ là khung chat thử nghiệm đơn giản cho phần trả lời và gọi công cụ; không mang diện mạo widget thật, không có khảo sát trước chat, không mô phỏng quy trình khách vãng lai, không có nút chuyển nhân viên hỗ trợ, cập nhật phản hồi nhân viên hay biểu mẫu đánh giá hài lòng (CSAT). | Không phản ánh đúng những gì người dùng cuối thực sự nhìn thấy và thao tác trên widget nhúng theo cấu hình đầy đủ của từng Tenant. |
| Các màn hình chính sách (Knowledge & Evidence, Support Ops, Support Governance, Output Controls) | Mỗi màn hình chỉ thử nghiệm đơn lẻ từng mảnh tính năng (tìm kiếm tri thức, đánh giá tường lửa, che dữ liệu, kiểm tra đầu ra) tách rời khỏi luồng chat thực tế của widget. | Cần hợp nhất toàn bộ hành vi của các chính sách đó vào đúng trải nghiệm trò chuyện trong widget thử nghiệm của từng Tenant tại Service Desk Studio. |

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trải nghiệm tương tác Widget thật theo từng Tenant ngay trong Studio (Priority: P1)

Người vận hành mở trang **Service Desk Studio** (`/thruline/support-desk`), chọn một **Tenant** cụ thể, tùy biến giao diện cùng các câu hỏi gợi ý và khảo sát trước chat ở cột cấu hình, rồi bật chế độ **Thử nghiệm trực tiếp** ở khung xem trước bên cạnh. Ngay tại đó, họ trải nghiệm chính xác toàn bộ giao diện và luồng tương tác mà người dùng cuối thấy khi widget hoạt động trên trang web thật: đóng/mở nút khởi chạy, xem lời chào, bấm câu hỏi gợi ý để gửi tin nhắn thật, điền hoặc bỏ qua biểu mẫu **Khảo sát trước chat (Intake)** theo quy định của Tenant và trò chuyện nhiều lượt với AI theo đúng mô hình, chỉ dẫn hệ thống và chính sách hội thoại của Tenant đó.

**Why this priority**: Đây là nhu cầu cốt lõi nhất của tính năng: biến khung xem trước tĩnh hiện tại thành môi trường trải nghiệm người dùng cuối thật theo từng Tenant mà vẫn bảo toàn chế độ xem tĩnh mặc định để không tự phát sinh lượt dùng AI ngoài ý muốn.

**Independent Test**: Chọn một Tenant có bật widget, câu hỏi gợi ý và khảo sát trước chat; chuyển khung xem trước sang chế độ Thử nghiệm trực tiếp, điền khảo sát, bấm một câu hỏi gợi ý và chat nhiều lượt, sau đó đổi sang Tenant thứ hai để xác nhận giao diện và phiên trò chuyện chuyển sạch sang Tenant mới.

**Acceptance Scenarios**:

1. **Given** người vận hành vừa mở Service Desk Studio cho một Tenant, **When** trang hoàn tất tải ở trạng thái mặc định, **Then** khung bên phải hiển thị ở chế độ **Xem trước thiết kế** tĩnh, không tự khởi tạo phiên người dùng cuối và không phát sinh lượt gọi AI hay tiêu tốn hạn mức.
2. **Given** người vận hành bật chế độ **Thử nghiệm trực tiếp** cho Tenant đang chọn, **When** khung widget khởi chạy, **Then** nó hiển thị đúng màu sắc, chủ đề sáng/tối, kiểu tiêu đề, ảnh đại diện, chấm trạng thái, nút khởi chạy, kích thước, phông chữ, lời chào, câu hỏi gợi ý và biểu mẫu khảo sát trước chat của Tenant đó; người vận hành có thể đóng/mở khung chat, bấm câu hỏi gợi ý để gửi tin nhắn ngay hoặc nhập tin nhắn trò chuyện nhiều lượt với AI.
3. **Given** Tenant cấu hình khảo sát trước chat ở trạng thái **Bắt buộc**, **When** người vận hành chưa hoàn thành các trường bắt buộc trong widget thử nghiệm, **Then** ô chat bị chặn và yêu cầu nộp khảo sát hợp lệ trước; nếu nhập sai định dạng (như email hoặc số) thì hiển thị lỗi ngay tại từng trường giống hệt trải nghiệm người dùng cuối, và sau khi nộp thành công mới mở khóa hội thoại.
4. **Given** người vận hành chỉnh sửa màu sắc, câu hỏi gợi ý hoặc trường khảo sát ở cột bên trái nhưng chưa lưu, **When** họ đang ở chế độ Thử nghiệm trực tiếp, **Then** giao diện hiển thị thông báo rõ ràng rằng bản nháp cấu hình chưa được lưu và cung cấp nút lưu kèm áp dụng ngay để phiên thử nghiệm cập nhật đồng bộ với cấu hình hiệu lực trên hệ thống (bao gồm yêu cầu điền lại khảo sát nếu cấu trúc khảo sát vừa thay đổi).
5. **Given** người vận hành đang có một hội thoại thử nghiệm hoạt động ở Tenant A, **When** họ chuyển bộ chọn sang Tenant B, **Then** mọi yêu cầu đang xử lý của Tenant A bị hủy bỏ ngay lập tức, khung thử nghiệm không còn giữ bất kỳ tin nhắn, biên lai khảo sát hay trạng thái nào của Tenant A và khởi tạo sạch theo cấu hình của Tenant B.

---

### User Story 2 - Đóng vai người dùng cuối và kiểm chứng phân quyền toàn diện (Priority: P1)

Trước hoặc trong khi trò chuyện ở chế độ Thử nghiệm trực tiếp, người vận hành có thể chọn tư cách người dùng cuối để kiểm thử phân quyền của Tenant đang chọn: đóng vai **Khách vãng lai chưa đăng nhập** hoặc **Người dùng đã xác thực** thuộc từng vai trò được Tenant cấu hình (`guest`, `customer`, `staff`, `admin` hoặc vai trò tùy chỉnh), kèm mã người dùng, tên hiển thị, email và các quyền bổ sung (hoặc chọn nhanh các nhân vật mẫu có sẵn như Khách vãng lai, Khách hàng 1, Khách hàng 2, Nhân viên, Quản trị viên). Mọi hành vi kiểm soát truy cập dữ liệu, công cụ nghiệp vụ và giới hạn khách vãng lai diễn ra y hệt người dùng cuối thật mà không để lộ khóa ký bí mật của đối tác ra giao diện người vận hành.

**Why this priority**: Kiểm thử đa tenant sẽ vô nghĩa nếu không đối chiếu được khác biệt giữa các vai trò và giữa các người dùng khác nhau trên cùng một Tenant; phân quyền sai sẽ dẫn đến rò rỉ dữ liệu khách hàng hoặc công cụ nội bộ.

**Independent Test**: Trên cùng một Tenant có dữ liệu đơn hàng/khách hàng và công cụ gắn theo vai trò, chạy lần lượt các câu hỏi giống nhau dưới vai trò Khách vãng lai, Khách hàng A, Khách hàng B và Quản trị viên để xác nhận phạm vi dữ liệu và công cụ được phép sử dụng thay đổi đúng theo vai trò và mã người dùng.

**Acceptance Scenarios**:

1. **Given** Tenant **tắt** quyền truy cập của khách vãng lai, **When** người vận hành chọn tư cách Khách vãng lai chưa đăng nhập trong chế độ Thử nghiệm trực tiếp, **Then** widget hiển thị đúng trạng thái yêu cầu xác thực và khóa ô nhập tin nhắn giống hệt người dùng cuối truy cập từ bên ngoài.
2. **Given** Tenant **bật** quyền khách vãng lai và người vận hành chọn tư cách Khách vãng lai, **When** họ gửi tin nhắn, **Then** phiên khách vãng lai thật được cấp phát có thời hạn, chỉ sử dụng được các công cụ và dữ liệu công khai dành cho vai trò khách vãng lai và không xem được dữ liệu riêng tư của khách hàng đã đăng nhập.
3. **Given** người vận hành chọn tư cách Khách hàng đã xác thực với mã người dùng A và hỏi thông tin đơn hàng hoặc hồ sơ cá nhân, **When** AI truy xuất công cụ hoặc nguồn dữ liệu có khóa sở hữu theo từng dòng, **Then** kết quả chỉ trả về bản ghi thuộc về người dùng A, ẩn hoàn toàn các cột/trường bị cấm và tự động từ chối hoặc không trả dữ liệu thuộc về người dùng B.
4. **Given** người vận hành chuyển tư cách sang Nhân viên hoặc Quản trị viên (hoặc bổ sung quyền đặc thù), **When** họ đặt câu hỏi kiểm tra phạm vi rộng hơn hoặc dùng công cụ nội bộ, **Then** AI được phép sử dụng đúng tập công cụ và dữ liệu mở rộng tương ứng với vai trò đó, đồng thời toàn bộ quy trình đóng vai diễn ra an toàn mà không hiển thị hay gửi khóa ký bí mật của đối tác ra giao diện phía người dùng.
5. **Given** người vận hành đổi sang nhân vật khác hoặc bấm nút **Làm mới phiên thử nghiệm**, **When** thao tác hoàn tất, **Then** cuộc hội thoại cũ và biên lai khảo sát của nhân vật trước được dọn sạch khỏi khung thử nghiệm để nhân vật mới bắt đầu một phiên độc lập hoàn toàn.

---

### User Story 3 - Kiểm thử Tri thức RAG, Trích dẫn nguồn và Kiểm soát an toàn như người dùng cuối (Priority: P1)

Khi trò chuyện trong widget thử nghiệm, người vận hành kiểm chứng được toàn bộ hành vi của hệ thống **Tri thức & Bằng chứng (RAG)**, **Tường lửa đầu vào**, **Che dữ liệu nhạy cảm**, **Hạn mức theo vai trò**, **Trí nhớ khách hàng (CRM)** và **Kiểm soát đầu ra** đúng như những gì người dùng cuối nhận được trên thực tế.

**Why this priority**: Đây là các lớp bảo vệ trung tâm đảm bảo AI trả lời đúng tài liệu được cấp phép, không bịa thông tin, không lộ bí mật hoặc nội dung cấm, và phản ánh trung thực mọi cấu hình từ Knowledge & Evidence, Support Governance và Output Controls.

**Independent Test**: Cấu hình một Tenant có tài liệu công khai và tài liệu nội bộ, bật chế độ trích dẫn bắt buộc, bật che thông tin cá nhân, bật chặn một chủ đề đầu vào và một từ cấm đầu ra; trò chuyện qua widget thử nghiệm để kiểm tra thẻ nguồn trích dẫn, thông báo hệ thống khi thiếu nguồn/thu hồi nguồn, và các tình huống bị chặn hoặc che thông tin.

**Acceptance Scenarios**:

1. **Given** Tenant bật truy hồi tri thức (RAG) và có các tài liệu gắn quyền xem theo vai trò, **When** người vận hành hỏi dưới vai trò Khách hàng hoặc Khách vãng lai, **Then** AI chỉ sử dụng và hiển thị thẻ trích dẫn kèm đoạn trích từ các tài liệu được phép cho vai trò đó; tài liệu chỉ dành cho Nhân viên/Quản trị viên không bao giờ xuất hiện trong câu trả lời hoặc phần trích dẫn.
2. **Given** câu hỏi không khớp tài liệu đủ ngưỡng tin cậy hoặc câu trả lời không xác minh được nguồn trích dẫn hợp lệ theo chính sách của Tenant, **When** lượt trả lời hoàn tất, **Then** widget hiển thị đúng hộp **Thông báo hệ thống** phi-AI giải thích thiếu nguồn phù hợp hoặc không xác minh được nguồn thay vì để AI tự suy diễn.
3. **Given** một tài liệu tri thức vừa bị chỉnh sửa hoặc thu hồi ngay trước hoặc trong lúc phiên thử nghiệm đang mở, **When** nguồn dữ liệu thay đổi giữa lượt hỏi hoặc phiên được tải/cập nhật lại, **Then** widget hiển thị thông báo nguồn đã thay đổi kèm nút thử lại yêu cầu mới, hoặc tự động thu gọn/thay thế câu trả lời cũ đã viện dẫn nguồn bị thu hồi bằng thông báo nguồn không còn khả dụng giống hệt widget thực tế.
4. **Given** Tenant bật tường lửa đầu vào, chính sách che dữ liệu cá nhân (email, số điện thoại, thẻ thanh toán, khóa bí mật), hạn mức sử dụng theo vai trò hoặc ngữ cảnh CRM theo mã khách hàng, **When** người vận hành gửi câu lệnh vi phạm quy tắc, chứa thông tin nhạy cảm, vượt hạn mức của vai trò đang chọn hoặc hỏi thông tin cá nhân hóa của khách hàng mẫu, **Then** hệ thống áp dụng đầy đủ cơ chế chặn/tính hạn mức/che dữ liệu/nạp hồ sơ CRM và hiển thị thông báo tương ứng trên widget (ngoại trừ các vai trò được cấu hình miễn trừ).
5. **Given** Tenant bật kiểm soát đầu ra (chế độ chặn hoặc che thông tin/từ cấm), **When** phản hồi AI chứa từ cấm, chuỗi nhạy cảm hoặc vượt giới hạn độ dài, **Then** nội dung hiển thị cuối cùng trong widget đã được che hoặc chặn đúng theo cấu hình đầu ra đang hiệu lực của Tenant.

---

### User Story 4 - Kiểm thử trọn vòng đời: Duyệt hành động, Chuyển nhân viên, Copilot và Đánh giá CSAT (Priority: P2)

Từ chính trang Service Desk Studio, người vận hành có thể kiểm thử trọn vẹn vòng đời hỗ trợ nâng cao như ngoài đời thật: xem trạng thái hành động chờ phê duyệt ngay trong widget khi AI gọi công cụ cần duyệt, bấm nút chuyển gặp nhân viên hỗ trợ, chuyển qua lại với tab **Copilot** hoặc **Hàng đợi & SLA** trên cùng trang để xử lý tiếp với tư cách nhân viên và đóng yêu cầu, rồi quay lại widget để thấy phản hồi của nhân viên và tự chấm điểm hài lòng **CSAT 1–5 sao**.

**Why this priority**: Giá trị đặc trưng của Service Desk Studio là khép kín quy trình giữa giao diện khách hàng và công cụ xử lý của nhân viên hỗ trợ; hoàn thành luồng này giúp người vận hành nghiệm thu toàn bộ vòng đời chỉ trên một trang mà không cần mở nhiều cửa sổ giả lập.

**Independent Test**: Trong chế độ Thử nghiệm trực tiếp, kích hoạt một công cụ cần phê duyệt rồi bấm nút chuyển nhân viên hỗ trợ; chuyển sang tab Copilot/Queues & SLA để thấy hội thoại và ticket vừa tạo, gửi câu trả lời nhân viên, đánh dấu giải quyết, quay lại widget để thấy tin nhắn nhân viên xuất hiện và chấm điểm CSAT.

**Acceptance Scenarios**:

1. **Given** Tenant có công cụ nghiệp vụ ở chế độ yêu cầu phê duyệt trước khi thực thi, **When** người dùng giả lập gửi yêu cầu kích hoạt công cụ đó qua widget thử nghiệm, **Then** widget hiển thị thẻ **Hành động đang chờ phê duyệt** với đúng tên công cụ, đồng thời yêu cầu chờ duyệt thật xuất hiện trong hàng đợi phê duyệt của Tenant.
2. **Given** cuộc trò chuyện thử nghiệm đang diễn ra trong widget, **When** người vận hành bấm nút **Gặp nhân viên hỗ trợ** trên thanh tiêu đề widget, **Then** widget hiển thị biểu ngữ thông báo đã chuyển cho nhân viên hỗ trợ, khóa ô nhập tin nhắn của khách hàng, đồng thời tạo hội thoại chuyển cấp và yêu cầu hỗ trợ thật được định tuyến vào đúng phòng ban và đồng hồ SLA của Tenant.
3. **Given** người vận hành đã chuyển hội thoại thử nghiệm cho nhân viên và chuyển sang tab **Copilot** hoặc **Hàng đợi & SLA** trên cùng trang Service Desk Studio rồi quay lại tab **Widget & Intake**, **When** họ ở tab Copilot/Hàng đợi, **Then** họ chọn được đúng hội thoại/ticket thử nghiệm vừa tạo để dùng Copilot gợi ý bản nháp, gửi câu trả lời thật của nhân viên hoặc chuyển trạng thái đã giải quyết/đóng; khi quay lại chế độ Thử nghiệm trực tiếp của Tenant đó, phiên thử nghiệm vẫn được giữ nguyên trạng thái và hiển thị đầy đủ tin nhắn của nhân viên (kèm tên người gửi và màu bong bóng nhân viên).
4. **Given** hội thoại thử nghiệm vừa được nhân viên đánh dấu là đã giải quyết hoặc đã đóng, **When** widget cập nhật trạng thái hội thoại, **Then** khối đánh giá **CSAT 1–5 sao** tự động hiển thị bên trong widget; khi người vận hành bấm chọn số sao, hệ thống ghi nhận điểm hài lòng thật cho Tenant và hiển thị lời cảm ơn trong widget.

---

### User Story 5 - Quan sát chẩn đoán ngoài khung chat và kiểm thử giới hạn tên miền nhúng (Priority: P3)

Để giữ khung widget trung thực 100% với giao diện người dùng cuối nhìn thấy nhưng vẫn giúp người vận hành chẩn đoán nhanh nguyên nhân khi kết quả AI hoặc phân quyền khác kỳ vọng, trang Service Desk Studio cung cấp một ngăn thông tin quan sát **nằm bên ngoài khung widget** (có thể thu gọn/mở rộng) và tùy chọn kiểm thử quy tắc tên miền được phép nhúng.

**Why this priority**: Trong thực tế cấu hình đa tenant, người vận hành thường cần biết nhanh vì sao một công cụ bị ẩn, vì sao câu trả lời bị từ chối hoặc tên miền website khách hàng có được phép tải widget hay không mà không làm rối hay sai lệch khung hiển thị thật của widget.

**Independent Test**: Mở ngăn quan sát kiểm thử khi chat với một nhân vật cụ thể, kiểm tra các thông tin vai trò, mã hội thoại, công cụ được phép/đã gọi và trạng thái bằng chứng; nhập một tên miền không nằm trong danh sách cho phép của Tenant vào mục kiểm thử tên miền để xác nhận kết quả bị từ chối giống ngoài thực tế.

**Acceptance Scenarios**:

1. **Given** người vận hành bật chế độ Thử nghiệm trực tiếp và mở ngăn thông tin quan sát bên ngoài khung widget, **When** một lượt trò chuyện hoàn tất (hoặc bị chặn bởi chính sách), **Then** giao diện bên trong widget vẫn giữ nguyên bản như người dùng cuối thấy, còn ngăn quan sát bên ngoài hiển thị rõ: tư cách & vai trò hiệu lực, mô hình đã sử dụng, mã hội thoại đang chạy, danh sách công cụ được phép và công cụ đã gọi, trạng thái nguồn tri thức/bằng chứng, lý do chặn an toàn hoặc thiếu nguồn (nếu có), và liên kết chuyển nhanh tới hội thoại đó ở tab Copilot.
2. **Given** Tenant cấu hình danh sách tên miền được phép nhúng cụ thể (không cho phép mọi tên miền), **When** người vận hành thử nghiệm ở chế độ mặc định dành cho quản trị viên trong Studio, **Then** họ vẫn thử nghiệm trực tiếp bình thường mà không bị chặn bởi chính tên miền quản trị; khi họ chủ động nhập một tên miền giả lập để kiểm tra chính sách nhúng, kết quả phản ánh chính xác tên miền đó được phép hay bị từ chối như khi nhúng ngoài website thật.

---

### Edge Cases

- **Đổi Tenant hoặc đổi nhân vật khi AI đang trả lời**: Nếu người vận hành đổi Tenant, đổi nhân vật giả lập hoặc bấm Làm mới phiên ngay trong lúc yêu cầu chat hoặc nộp khảo sát đang chờ phản hồi, phản hồi đến muộn từ yêu cầu cũ phải bị hủy và loại bỏ hoàn toàn, không được ghi đè vào màn hình phiên mới.
- **Tenant bị vô hiệu hóa hoặc chưa có mô hình AI khả dụng**: Khi Tenant đang tắt hoặc chưa có tài khoản mô hình AI sẵn sàng, widget thử nghiệm hiển thị trạng thái lỗi rõ ràng như người dùng cuối gặp phải và không tự sửa trạng thái bật/tắt của Tenant.
- **Bản nháp cấu hình chưa lưu so với cấu hình đang hiệu lực**: Nếu người vận hành chỉnh sửa các trường khảo sát hoặc tắt/bật widget ở cột bên trái nhưng chưa lưu, chế độ Thử nghiệm trực tiếp vẫn phải cảnh báo rõ ràng cấu hình đang áp dụng trên máy chủ là bản đã lưu gần nhất (hoặc gợi ý lưu & đồng bộ ngay) để tránh hiểu nhầm.
- **Tài liệu tri thức bị sửa hoặc thu hồi giữa chừng**: Nếu tài liệu được viện dẫn trong hội thoại thử nghiệm bị thu hồi khi người vận hành đang mở phiên, widget phản ánh đúng cơ chế thu hồi/thay thế nội dung câu trả lời đó bằng thông báo hệ thống phi-AI giống người dùng cuối.
- **Phiên khách vãng lai hết hạn khi để trang mở lâu**: Khi phiên thử nghiệm của khách vãng lai hết hạn trong lúc người vận hành mở trang lâu rồi tiếp tục nhắn, widget xử lý gia hạn hoặc khởi tạo lại phiên an toàn giống hệt hành vi widget ngoài thực tế và thông báo rõ trên ngăn quan sát (nếu đang mở).
- **Chuyển qua lại giữa các tab trong cùng Tenant**: Khi chuyển từ tab `Widget & Intake` sang `Copilot`, `Queues & SLA` hoặc `Embed` rồi quay lại trong cùng một Tenant, phiên thử nghiệm đang chạy của Tenant đó không bị mất giữa chừng; chỉ khi đổi sang Tenant khác hoặc đóng/tải lại trang mới đặt lại theo quy tắc phiên.
- **Người dùng quản trị không đủ quyền chỉnh sửa Service Desk Studio**: Nếu tài khoản quản trị đang đăng nhập không có đủ quyền sử dụng và cấu hình Service Desk Studio, toàn bộ tính năng chỉnh sửa và thử nghiệm trực tiếp không được phép kích hoạt và không gửi bất kỳ truy vấn nhạy cảm nào.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Trang Service Desk Studio (`/thruline/support-desk`) MUST hỗ trợ hai chế độ tách biệt tại khung bên phải của tab cấu hình widget cho Tenant đang chọn: chế độ **Xem trước thiết kế** (mặc định khi mở trang, không tạo phiên và không tiêu tốn hạn mức) và chế độ **Thử nghiệm trực tiếp** (tương tác đầy đủ như widget thực tế).
- **FR-002**: Trong chế độ Thử nghiệm trực tiếp, mọi thành phần giao diện và tương tác người dùng cuối MUST hoạt động tương đương widget nhúng thực tế của Tenant đang chọn: hiển thị toàn bộ tùy biến thương hiệu (màu sắc, chủ đề, tiêu đề, tiêu đề phụ, ảnh đại diện, chấm trạng thái, vị trí, kiểu nút khởi chạy, bo góc, kích thước, phông chữ, lời chào, chân trang), nút đóng/mở widget, câu hỏi gợi ý bấm để gửi thật, biểu mẫu khảo sát trước chat, gửi/nhận tin nhắn nhiều lượt, nút thử lại khi lỗi hoặc khi ngữ cảnh tri thức thay đổi, nút chuyển nhân viên, tự động cập nhật tin nhắn phản hồi từ nhân viên hỗ trợ và đánh giá CSAT.
- **FR-003**: Hệ thống MUST cho phép người vận hành chọn tư cách người dùng cuối để thử nghiệm theo Tenant, gồm: chế độ **Khách vãng lai chưa đăng nhập** và chế độ **Người dùng đã xác thực** với vai trò tùy chọn từ danh sách vai trò của Tenant (`guest`, `customer`, `staff`, `admin` hoặc vai trò tùy chỉnh), mã người dùng, tên hiển thị, email, quyền bổ sung và các mẫu nhân vật chọn nhanh.
- **FR-004**: Việc khởi tạo tư cách người dùng đã xác thực cho người vận hành thử nghiệm MUST do phía máy chủ xác nhận dựa trên quyền quản trị hợp lệ của phiên đang đăng nhập; hệ thống MUST NOT tiết lộ khóa ký bí mật của Tenant ra giao diện người dùng hoặc cho phép trình duyệt tự giả mạo chữ ký tin cậy.
- **FR-005**: Khi người vận hành thử nghiệm ở tư cách Khách vãng lai chưa đăng nhập trên một Tenant đã tắt quyền khách vãng lai, widget thử nghiệm MUST bị từ chối và hiển thị thông báo yêu cầu xác thực đúng như môi trường thực tế.
- **FR-006**: Tất cả lượt trò chuyện và nộp khảo sát trong chế độ Thử nghiệm trực tiếp MUST đi qua đúng chuỗi xử lý vận hành thực tế của Tenant đang chọn (bao gồm kiểm tra bắt buộc khảo sát trước chat, xác thực đầu vào, áp dụng mô hình mặc định và giới hạn chính sách vận hành, phân quyền công cụ và giới hạn dữ liệu từng dòng theo mã người dùng/vai trò).
- **FR-007**: Hệ thống MUST đảm bảo phiên thử nghiệm tuân thủ đầy đủ các chính sách RAG và bằng chứng của Tenant: chỉ truy xuất tài liệu mà vai trò đang giả lập được phép xem, hiển thị thẻ trích dẫn và đoạn trích trong widget, hiển thị thông báo phi-AI khi thiếu nguồn hoặc trích dẫn không hợp lệ, hỗ trợ thử lại khi ngữ cảnh thay đổi và thu hồi/ẩn nội dung câu trả lời nếu nguồn đã bị thu hồi.
- **FR-008**: Hệ thống MUST áp dụng đầy đủ các chính sách an toàn và quản trị của Tenant lên phiên thử nghiệm giống như người dùng cuối thật: tường lửa đầu vào (chống tấn công câu lệnh, từ khóa cấm, chủ đề cấm, độ dài tối đa, vai trò miễn trừ), che thông tin cá nhân nhạy cảm (PII), hạn mức sử dụng theo vai trò, hồ sơ trí nhớ khách hàng (CRM) theo mã người dùng giả lập và chính sách kiểm soát đầu ra (quan sát, che hoặc chặn nội dung đầu ra).
- **FR-009**: Khi AI kích hoạt công cụ yêu cầu phê duyệt, widget thử nghiệm MUST hiển thị trạng thái hành động chờ phê duyệt giống người dùng cuối và tạo yêu cầu chờ duyệt thật để người vận hành kiểm chứng luồng duyệt.
- **FR-010**: Khi người vận hành bấm nút chuyển gặp nhân viên hỗ trợ trong widget thử nghiệm, hệ thống MUST tạo cuộc hội thoại chuyển cấp và yêu cầu hỗ trợ thật vào hàng đợi định tuyến & SLA của Tenant; khi nhân viên trả lời hoặc giải quyết/đóng từ tab Copilot hoặc Hàng đợi & SLA, widget thử nghiệm MUST cập nhật tin nhắn nhân viên và hiển thị khối chấm điểm CSAT 1–5 sao để gửi đánh giá thật.
- **FR-011**: Khi chuyển sang một Tenant khác, chuyển đổi nhân vật giả lập hoặc bấm nút Làm mới phiên thử nghiệm, hệ thống MUST hủy toàn bộ yêu cầu đang chờ, dọn sạch lịch sử hiển thị và trạng thái phiên/biên lai khảo sát cũ trước khi khởi tạo phiên mới để ngăn rò rỉ chéo giữa các Tenant hoặc giữa các nhân vật.
- **FR-012**: Khi có thay đổi trên biểu mẫu cấu hình widget hoặc khảo sát chưa được lưu, giao diện MUST hiển thị cảnh báo đồng bộ rõ ràng ở chế độ Thử nghiệm trực tiếp và cung cấp thao tác lưu để áp dụng ngay vào phiên thử nghiệm mà không tự ý ghi đè cấu hình đang chạy của khách hàng khi người vận hành chưa xác nhận lưu.
- **FR-013**: Hệ thống MUST giữ nguyên giao diện bên trong khung widget giống 100% trải nghiệm người dùng cuối và tách riêng phần thông tin quan sát kỹ thuật (vai trò/quyền hiệu lực, mô hình sử dụng, mã hội thoại, công cụ khả dụng và đã gọi, trạng thái nguồn RAG, lý do bị chặn/từ chối và lối tắt mở hội thoại ở tab Copilot) ra một ngăn đóng/mở bên ngoài khung widget.
- **FR-014**: Người vận hành được cấp quyền MUST chạy thử nghiệm trực tiếp được ngay cả khi Tenant chỉ cho phép danh sách tên miền website bên ngoài cụ thể, đồng thời có tùy chọn nhập tên miền giả lập để kiểm thử hành vi cho phép hoặc từ chối theo tên miền nhúng của Tenant đó.
- **FR-015**: Toàn bộ nhãn điều khiển, hướng dẫn, trạng thái lỗi và nội dung quan sát của tính năng MUST hỗ trợ đầy đủ song ngữ tiếng Việt và tiếng Anh theo ngôn ngữ giao diện đang chọn, và MUST giữ nguyên tính năng nhúng widget công khai trên các website đối tác hiện hành không thay đổi hành vi.

### Key Entities

- **Phiên thử nghiệm Widget (Live Widget Test Session)**: Đại diện cho một phiên chạy thử nghiệm đang hoạt động gắn chặt với đúng một Tenant và một nhân vật giả lập tại một thời điểm; lưu giữ mã hội thoại hiện tại, trạng thái đã hoàn thành khảo sát trước chat hay chưa, trạng thái chuyển nhân viên và vòng đời độc lập với các phiên của Tenant hoặc nhân vật khác.
- **Nhân vật giả lập người dùng cuối (Simulated End-User Persona)**: Tập thuộc tính danh tính mà người vận hành chọn để đóng vai (chế độ khách vãng lai hoặc người dùng đã xác thực, vai trò, mã người dùng, tên hiển thị, email, quyền bổ sung), được xác thực tập trung bởi máy chủ theo quyền của người vận hành.
- **Trạng thái đồng bộ cấu hình thử nghiệm (Draft-vs-Saved Config State)**: Trạng thái so sánh giữa cấu hình bản nháp người vận hành đang chỉnh sửa trong Studio với cấu hình đã lưu và đang có hiệu lực cho widget thật của Tenant, nhằm đảm bảo người vận hành luôn biết phiên thử nghiệm đang chạy theo cấu hình nào.
- **Thông tin quan sát lượt thử nghiệm (Test Turn Diagnostic Summary)**: Dữ liệu tóm tắt ngoài khung widget giúp người vận hành theo dõi kết quả mỗi lượt thử nghiệm (mô hình thực tế phục vụ, công cụ được phép và đã thực thi, trạng thái nguồn trích dẫn RAG, hành động kiểm duyệt đầu vào/đầu ra, kết quả kiểm tra tên miền nhúng và liên kết mở hội thoại trong Copilot).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% tính năng người dùng cuối có thể nhìn thấy và tương tác trên widget thực tế (giao diện thương hiệu, khảo sát trước chat, câu hỏi gợi ý, chat AI nhiều lượt, công cụ có khóa dữ liệu theo người dùng, hành động chờ duyệt, trích dẫn RAG và thông báo thu hồi/thiếu nguồn, kiểm soát an toàn đầu vào/đầu ra, chuyển nhân viên, nhận phản hồi nhân viên và đánh giá CSAT) đều vận hành và kiểm thử được trực tiếp ngay trên trang Service Desk Studio cho từng Tenant.
- **SC-002**: 100% lượt mở trang Service Desk Studio ở chế độ mặc định giữ nguyên hành vi Xem trước thiết kế tĩnh và phát sinh đúng 0 yêu cầu tạo phiên hay 0 lượt gọi AI cho tới khi người vận hành chủ động bật chế độ Thử nghiệm trực tiếp.
- **SC-003**: Thời gian người vận hành chuyển đổi giữa các nhân vật giả lập hoặc làm mới hoàn toàn một phiên thử nghiệm mới cho Tenant đang chọn dưới 2 giây trong điều kiện mạng ổn định.
- **SC-004**: Trong bộ kiểm thử phân quyền và cô lập dữ liệu (đổi giữa ít nhất 2 Tenant khác nhau và 4 vai trò/người dùng khác nhau trên cùng Tenant), ghi nhận 0 trường hợp rò rỉ dữ liệu đơn hàng, lịch sử hội thoại, biên lai khảo sát, tài liệu tri thức nội bộ hoặc khóa ký bí mật đối tác sang Tenant hoặc vai trò không được phép.
- **SC-005**: Một người vận hành làm quen lần đầu có thể hoàn thành trọn vẹn một kịch bản nghiệm thu khép kín (chọn Tenant -> bật Thử nghiệm trực tiếp -> hoàn thành khảo sát -> hỏi câu có trích dẫn RAG -> bấm chuyển nhân viên -> trả lời qua tab Copilot -> quay lại widget chấm điểm CSAT) ngay trên cùng trang Service Desk Studio trong dưới 3 phút mà không cần tạo trang web nhúng bên ngoài.
- **SC-006**: Toàn bộ các luồng widget nhúng công khai hiện có, giao diện 4 tab hiện tại của Service Desk Studio và các tính năng AI Support, Knowledge & Evidence, Support Ops, Support Governance, Output Controls tiếp tục hoạt động bình thường với 0 hồi quy sau khi tích hợp tính năng mới.

---

## Assumptions

- **Chế độ mặc định an toàn**: Khi mới truy cập trang Service Desk Studio, chế độ mặc định luôn là **Xem trước thiết kế** tĩnh để bảo vệ hạn mức AI của Tenant, tránh tạo phiên rác trong dữ liệu vận hành và giữ tương thích hoàn toàn với trải nghiệm hiện tại.
- **Dữ liệu phát sinh trong Thử nghiệm trực tiếp là dữ liệu nghiệp vụ thật của Tenant**: Các hội thoại, biên lai khảo sát, yêu cầu hỗ trợ, hành động chờ duyệt và điểm CSAT tạo ra khi người vận hành thử nghiệm trực tiếp sẽ đi qua đúng hệ thống xử lý thật của Tenant đó để người vận hành kiểm chứng liên thông ngay tại tab Copilot, Hàng đợi & SLA và các màn hình quản trị khác, không tạo bản sao logic giả lập tách rời.
- **Giữ nguyên mô hình phân quyền quản trị**: Chỉ những tài khoản nội bộ đã có đủ quyền truy cập và cấu hình Service Desk Studio mới được sử dụng chế độ Thử nghiệm trực tiếp và đóng vai người dùng cuối; không đặt thêm phân quyền mới ngoài hệ thống hiện hành.
- **Không tự động lưu ngầm cấu hình đang chạy của khách hàng**: Mọi thay đổi giao diện hoặc khảo sát trên biểu mẫu Studio chỉ ảnh hưởng tới người dùng cuối thật và phiên Thử nghiệm trực tiếp sau khi người vận hành chủ động xác nhận lưu, để tránh làm gián đoạn widget đang nhúng ngoài website sản xuất.
- **Phạm vi tích hợp**: Chế độ Thử nghiệm trực tiếp được tích hợp ngay vào tab cấu hình Widget & Intake của trang Service Desk Studio (`/thruline/support-desk`) cho từng Tenant đang chọn; trình mô phỏng cũ tại AI Support và các công cụ thử nghiệm đơn lẻ tại các trang khác vẫn được giữ nguyên để không làm gián đoạn thói quen sử dụng hiện tại.
