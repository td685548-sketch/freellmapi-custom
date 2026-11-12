# Feature Specification: End-to-End AI Support Runtime Integration

**Feature Branch**: `feat/9router-integration`
**Feature Directory**: `specs/017-ai-support-runtime-integration`
**Created**: 2026-11-12
**Status**: Ready for implementation; reviewer acceptance pending
**Input**: Hoàn thiện các tính năng còn thiếu để website đối tác dùng server này làm AI hỗ trợ thực tế. Viết spec và prompt cho bốn agent; reviewer chỉ review sau khi các agent hoàn tất và tạo PR khi đạt.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Một lượt chat tự áp dụng chính sách và tri thức (Priority: P1)

Website gửi một tin nhắn; hệ thống tự xác thực khách, kiểm tra nội dung và ngân sách, lấy tri thức đúng quyền cùng trí nhớ khách hàng, rồi trả lời có che dữ liệu nhạy cảm. Website không phải tự ghép nhiều lời gọi kiểm tra trước mỗi tin nhắn.

**Why this priority**: Các module riêng lẻ hiện chưa tạo thành trải nghiệm hỗ trợ an toàn xuyên suốt.
**Independent Test**: Gửi trực tiếp yêu cầu chat với nhà cung cấp AI giả lập; xác minh dữ liệu đi vào và ra khỏi nhà cung cấp, công cụ được gọi và ngân sách bị trừ.

**Acceptance Scenarios**:
1. **Given** tài liệu và trí nhớ thuộc nhiều khách/role, **When** khách A hỏi, **Then** chỉ dữ liệu tenant A và quyền của khách A được dùng làm ngữ cảnh.
2. **Given** nội dung bị cấm hoặc hết ngân sách, **When** gọi thẳng chat, **Then** yêu cầu bị từ chối trước mọi lời gọi AI hoặc công cụ.
3. **Given** kết quả công cụ hoặc câu trả lời chứa dữ liệu cần che, **When** role không được miễn, **Then** dữ liệu được che trước khi đưa vào AI, trả ra hoặc ghi lịch sử hỗ trợ.
4. **Given** website gửi thêm chỉ dẫn hệ thống, lịch sử giả, role giả hoặc model ngoài danh sách cho phép, **When** chat, **Then** dữ liệu không tin cậy không thay thế chính sách và lịch sử phía server.
5. **Given** hai yêu cầu đồng thời ở sát ngưỡng ngân sách, **When** xử lý, **Then** chỉ số lượt được phép được nhận; không trừ một lượt thành nhiều yêu cầu do vòng lặp công cụ.

### User Story 2 - Hội thoại liên tục và chuyển cho nhân viên (Priority: P1)

Khách tải lại website vẫn tiếp tục hội thoại của mình, có thể yêu cầu nhân viên và đánh giá hỗ trợ. Khách khác hoặc tenant khác không đọc hay nối tiếp được hội thoại đó.

**Why this priority**: Widget hiện giữ lịch sử trong trang và chưa nối đầy đủ với hộp thư vận hành.
**Independent Test**: Chat, tải lại widget, lấy lại hội thoại, chuyển nhân viên, nhận phản hồi và gửi đánh giá; thử truy cập từ khách/tenant khác.

**Acceptance Scenarios**:
1. Mỗi lượt được chấp nhận lưu một tin khách và tối đa một câu trả lời AI; phát lại cùng mã lượt không tạo bản sao hoặc gọi lại công cụ.
2. Hai lượt khác nhau vào cùng hội thoại đang xử lý không làm lịch sử đảo thứ tự; lượt sau nhận thông báo thử lại rõ ràng.
3. Khách vãng lai được cấp danh tính tạm riêng nếu tenant cho phép; không dùng một danh tính chung cho mọi khách.
4. Sau chuyển nhân viên, AI không tự chen câu trả lời cho đến khi hội thoại được tiếp tục phù hợp; widget hiển thị trạng thái và phản hồi nhân viên.
5. Lỗi AI được hiển thị trung thực; câu trả lời theo mẫu không được gắn nhãn là do mô hình sinh.

### User Story 3 - Hành động nhạy cảm có phê duyệt và sự kiện có theo dõi (Priority: P1)

Hoàn tiền, hủy đơn hoặc thao tác thay đổi dữ liệu phải chờ nhân viên có quyền phê duyệt. Website đối tác nhận được sự kiện trạng thái cùng khả năng nhận diện bản gửi lại.

**Why this priority**: Luồng phê duyệt riêng hiện không chặn mọi công cụ chat; việc gửi sự kiện cần chịu được lỗi mạng và khởi động lại.
**Independent Test**: AI yêu cầu công cụ ghi, xác minh chưa có HTTP trước phê duyệt; duyệt hai lần đồng thời chỉ có một lần thực thi; mô phỏng nhận webhook lỗi rồi phục hồi.

**Acceptance Scenarios**:
1. Công cụ thay đổi dữ liệu mặc định phải chờ duyệt, kể cả khi người hỏi là admin; cấu hình rõ ràng mới phân loại được công cụ chỉ đọc.
2. Từ chối không thực thi. Duyệt lại hoặc duyệt đồng thời không chạy lại tác động bên ngoài. Công cụ không tồn tại/đã tắt không được báo thực thi thành công giả lập.
3. Nhân viên duyệt không làm thay đổi phạm vi dữ liệu của khách đã yêu cầu hành động; tham số khóa danh tính vẫn được cưỡng chế.
4. Sự kiện tạo/giải quyết ticket, duyệt/từ chối hành động, gửi CSAT và chặn nội dung được ghi bền vững cùng thay đổi nghiệp vụ, sau đó giao nhận độc lập với thời gian chat.
5. Mỗi bên nhận có lịch sử lần thử, thời điểm thử tiếp và trạng thái kết thúc; bên nhận có mã sự kiện ổn định để loại bản trùng.

### User Story 4 - Tích hợp website có thể tự kiểm chứng (Priority: P2)

Quản trị viên cấu hình chính sách runtime, lấy mã nhúng đúng địa chỉ server và chạy kiểm tra sẵn sàng. Widget cho phép tiếp tục hội thoại, chuyển nhân viên và đánh giá mà không lộ khóa bí mật.

**Why this priority**: Có module và nút thử riêng chưa chứng minh website bên ngoài dùng được toàn bộ luồng.
**Independent Test**: Dùng giao diện và widget với dữ liệu giả lập từ đầu đến cuối, đổi tenant trong lúc yêu cầu chưa xong, thử token hết hạn và server lỗi.

**Acceptance Scenarios**:
1. Mã nhúng chỉ chứa public key và địa chỉ server; token có danh tính đăng nhập do backend đối tác cấp, không chứa signing secret trong trình duyệt.
2. Lỗi hoặc thiếu cấu hình có nguyên nhân cụ thể; kiểm tra sẵn sàng không tự gọi AI hoặc gửi webhook thật.
3. Đổi tenant, đăng xuất hoặc đổi danh tính xóa trạng thái riêng tư đang hiển thị; dữ liệu cũ không xuất hiện trong workspace mới.
4. Giao diện có EN/VI; tải, lỗi, trạng thái chờ duyệt và chuyển nhân viên đều có phản hồi rõ ràng.

### Edge Cases

- Token hết hạn, secret xoay vòng, tenant bị tắt, origin không hợp lệ, header và body nhận diện mâu thuẫn.
- Mã lượt trùng nhưng nội dung khác; mã lượt trùng từ khách khác; quá trình bị dừng giữa lúc gọi công cụ.
- Thiếu model hoặc lỗi tất cả provider; vòng lặp công cụ vượt giới hạn; dữ liệu công cụ quá lớn hoặc không phải JSON.
- Quota hết hạn cửa sổ trong lúc đang sinh; lời gọi mô hình thất bại sau khi phát sinh chi phí; không có số liệu usage đáng tin.
- Khởi động lại trong lúc duyệt hành động: giữ trạng thái cần đối soát, không tự thử lại thao tác ghi chưa rõ kết quả.
- Webhook trả lỗi, timeout, chuyển hướng hoặc DNS trỏ địa chỉ nội bộ; subscription bị xóa sau khi sự kiện được ghi.
- Trình duyệt chặn lưu trữ, nhiều tab, token đổi khách, tải lại trang khi hội thoại đã được đóng.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Mọi chat và giả lập chat PHẢI đi qua cùng luồng xác thực, xác định model, firewall, quota, ngữ cảnh, thực thi công cụ, che dữ liệu và lưu kết quả.
- **FR-002**: Chỉ danh tính đã xác minh được quyết định user/role/quyền; tenant, origin và chủ sở hữu hội thoại PHẢI được kiểm tra trước đọc dữ liệu hoặc gây tác động.
- **FR-003**: Tin nhắn từ website PHẢI được xem là dữ liệu người dùng; không cho phép thay thế chính sách hệ thống hoặc lịch sử tin cậy.
- **FR-004**: Tri thức, trí nhớ, dữ liệu công cụ, lịch sử và phản hồi PHẢI tuân thủ giới hạn quyền cùng chính sách che dữ liệu.
- **FR-005**: Ngân sách PHẢI được giữ chỗ trước khi gọi AI, đối soát sau khi xử lý và không vượt ngưỡng khi có cạnh tranh; không tin số token do trình duyệt khai báo.
- **FR-006**: Hội thoại, lượt chat và tác động PHẢI có cơ chế chống xử lý trùng; không giữ khóa cơ sở dữ liệu trong khi chờ mạng.
- **FR-007**: Tất cả công cụ thay đổi dữ liệu PHẢI chờ phê duyệt theo mặc định. Quyết định và kết quả thực thi PHẢI tách biệt, ghi nhận lỗi trung thực và có dấu vết người duyệt.
- **FR-008**: Sự kiện nghiệp vụ PHẢI được ghi cùng thay đổi nghiệp vụ và gửi có chữ ký, giới hạn số lần thử, thời gian chờ, mã loại trùng và lịch sử từng bên nhận.
- **FR-009**: Mọi HTTP đến endpoint đối tác PHẢI kiểm soát đích mạng và chuyển hướng; không cho dữ liệu request công khai bật quyền truy cập mạng nội bộ.
- **FR-010**: Widget PHẢI nối được lịch sử, chuyển nhân viên và CSAT; phải dùng đúng địa chỉ server dù nhúng vào domain khác.
- **FR-011**: Giao diện quản trị PHẢI hiển thị tình trạng cấu hình và giao nhận, có phân quyền chỉnh sửa, EN/VI và cô lập trạng thái theo tenant/phiên.
- **FR-012**: Endpoint công khai cũ và trường phản hồi cũ PHẢI được giữ; thay đổi về dữ liệu không tin cậy được từ chối rõ ràng và có hướng dẫn nâng cấp.
- **FR-013**: Phải có kiểm thử chức năng, cạnh tranh, truy cập trái quyền, sự cố mạng và khởi động lại; không dùng lời khẳng định giả về đúng-một-lần với hệ thống đối tác không hỗ trợ loại trùng.

### Key Entities

- **Runtime Policy**: Danh sách model được phép, ngân sách ngữ cảnh/đầu ra, phân loại an toàn của công cụ.
- **Chat Turn**: Tenant, khách, hội thoại, mã lượt, dấu vân tay đầu vào, trạng thái và phản hồi đã che dữ liệu.
- **Quota Reservation**: Ngân sách đang giữ, usage cuối cùng và trạng thái đối soát của một lượt.
- **Action Execution**: Trạng thái chờ/chạy/thành công/thất bại/cần đối soát, người duyệt và tác động bên ngoài.
- **Partner Event / Delivery**: Sự kiện bền vững, từng bên nhận, lần thử, chữ ký và kết quả giao nhận.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Toàn bộ kịch bản từ chối nội dung/quota/quyền đều không gọi mô hình hoặc công cụ ngoài ý muốn.
- **SC-002**: Với 20 yêu cầu cạnh tranh khi chỉ còn một lượt, đúng một lượt được nhận; phát lại một mã lượt 20 lần không gây thêm tác động.
- **SC-003**: Sau tải lại website, khách tiếp tục đúng hội thoại của mình; mọi ca khách/tenant khác truy cập bị từ chối.
- **SC-004**: Duyệt đồng thời một hành động không tạo hơn một yêu cầu thực thi; kết quả chưa rõ sau sự cố không bị tự chạy lại.
- **SC-005**: Bên nhận webhook lỗi tạm thời rồi phục hồi nhận được sự kiện đã ghi; sự kiện vẫn còn sau khởi động lại và không làm chat chờ các lần gửi lại.
- **SC-006**: Quản trị viên hoàn thành cấu hình và kiểm chứng tích hợp bằng một quy trình hướng dẫn; kiểm thử bao phủ cả EN/VI và các trạng thái lỗi chính.

## Assumptions

- Tái sử dụng các tính năng đã có ở spec 013–015; không viết lại các engine đã hoạt động.
- Spec 016 vẫn độc lập: branding nâng cao, form khảo sát, Copilot, macros và SLA phòng ban không thuộc đợt này.
- Đợt này dùng giao tiếp chat trả kết quả hoàn chỉnh; streaming, vector database mới, SDK đa ngôn ngữ, billing, SSO và đa kênh là backlog.
- Khách vãng lai nhận danh tính tạm duy nhất, quyền guest và giới hạn cấp phiên; backend đối tác chịu trách nhiệm cấp danh tính đăng nhập.
- Giữ cách deploy cục bộ/Docker hiện tại; không thêm dịch vụ nền ngoài ứng dụng và không thêm package.
- Reviewer không tự viết implementation hoặc gọi bốn agent trong đợt lập spec; bốn prompt được giao cho người dùng chạy. PR chỉ tạo sau review và kiểm tra đạt, không tự merge.