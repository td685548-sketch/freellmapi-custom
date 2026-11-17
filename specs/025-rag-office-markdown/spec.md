# Feature Specification: Tự động chuyển đổi tài liệu Word & Excel sang Markdown (.md) khi tải lên RAG

**Feature Branch**: `feat/025-rag-office-markdown`

**Feature Directory**: `specs/025-rag-office-markdown`

**Created**: 2026-11-18

**Status**: Hoàn thành — xem [specs/README.md](../README.md)

**Input**: User description: "Phần đưa tài liệu lên để rag có tính năng tự chuyển sang md với file world hay excel chưa. Triển khai nhé"

## Bối cảnh: hiện trạng trước triển khai (2026-11-18)

Trước tính năng này, cả ba khu vực nạp tài liệu tri thức (RAG) trong hệ thống đều chưa có khả năng tự chuyển đổi tệp Word hoặc Excel sang Markdown:

1. **Client Profile Knowledge Base (`KnowledgeCard`)**: Chỉ cho phép nhập/dán chữ thủ công qua ô nhập văn bản, chưa có nút tải tệp lên.
2. **Support Knowledge & Evidence Studio (`SupportKnowledgeStudio`)**: Chỉ hỗ trợ tải tệp `.txt`, `.md`, `.json` qua trình đọc văn bản thuần phía trình duyệt; tải tệp `.docx` hoặc `.xlsx` bị lỗi/ra ký tự nhị phân.
3. **Support Operations Center (`SupportEnterprise` -> tab Knowledge)**: Chỉ có biểu mẫu nhập/dán thủ công, chưa hỗ trợ tải tệp lên.

## User Scenarios & Testing

### User Story 1 - Tải tệp Word (.docx) và tự động chuyển sang Markdown (.md) cho RAG (Priority: P1)
Người quản trị tải lên tệp `.docx` ở bất kỳ màn hình nạp tri thức nào; hệ thống tự động trích xuất tiêu đề, định dạng đậm/nghiêng/gạch ngang/mã inline, liên kết an toàn (`http://`, `https://`, `mailto:`), danh sách có thứ tự/không thứ tự nhiều cấp, khối trích dẫn, khối mã, bảng GFM và chú thích cuối trang sang Markdown chuẩn `.md`, tự điền tiêu đề (nếu đang trống) và nội dung để xem lại rồi lưu vào kho RAG.

### User Story 2 - Tải tệp Excel (.xlsx, .csv, .tsv, XML/HTML spreadsheet) và tự động chuyển sang bảng Markdown (.md) (Priority: P1)
Người quản trị tải lên bảng tính `.xlsx` (nhiều sheet, bỏ qua sheet ẩn, hỗ trợ shared strings, ngày tháng, phần trăm, boolean, công thức) hoặc `.csv`/`.tsv`/SpreadsheetML 2003/HTML table; hệ thống chuyển từng sheet không rỗng thành tiêu đề `## <Tên sheet>` kèm bảng GFM Markdown hợp lệ phục vụ chia đoạn (chunking) và tìm kiếm RAG.

### User Story 3 - Kiểm soát an toàn lưu trữ, tệp cũ/mã hóa và đồng bộ ba màn hình RAG (Priority: P1)
Mọi điểm tải lên đều kiểm tra quyền chỉnh sửa hiện hành (`edit_client_profiles` cho Client Profile KB; `use_x_gateway` + `edit_x_settings` cho Support Studio/Ops), giới hạn dung lượng 10 MiB, chống zip-bomb (tối đa 2.000 mục, 16 MiB/XML, 32 MiB tổng giải nén, bỏ qua media nhúng), không đánh giá DTD/XXE, từ chối rõ ràng tệp có mật khẩu (`415 password_protected_document`) hoặc tệp nhị phân Office 97–2003 `.doc`/`.xls` (`415 legacy_office_binary`), và hỗ trợ đầy đủ song ngữ Anh/Việt.

## Functional Requirements
- **FR-001**: Cung cấp dịch vụ chuyển đổi thuần Node.js (`node:zlib`) không thêm thư viện ngoài cho `.docx`, `.xlsx`, `.csv`, `.tsv`, SpreadsheetML 2003, HTML table, `.md`, `.txt`.
- **FR-002**: Gắn endpoint `POST .../convert` tại cả ba router RAG (`profile-knowledge`, `support-evidence-router`, `support-enterprise-router`).
- **FR-003**: Tích hợp nút/ô tải tệp tự động chuyển sang Markdown vào `KnowledgeCard`, `SupportKnowledgeStudio`, và `SupportEnterprise`.
- **FR-004**: Bảo đảm xử lý đúng tên tệp UTF-8 (tiếng Việt có dấu), nội dung tiếng Việt có dấu, và bản dịch song ngữ Anh/Việt đầy đủ.
