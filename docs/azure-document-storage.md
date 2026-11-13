# Azure document storage

## Tài nguyên đã cấp

| Cấu hình | Giá trị |
| --- | --- |
| Subscription | Azure for Students |
| Resource group | `rg-freellmapi-documents` |
| Storage account | `stfreellmdocs261114` |
| Vùng / loại | `southeastasia` / `StorageV2`, `Standard_LRS`, Hot |
| Container | `tenant-documents` (private) |
| Blob endpoint | `https://stfreellmdocs261114.blob.core.windows.net` |
| Xác thực | Microsoft Entra ID; Shared Key và anonymous access bị tắt |

Đã cấp `Storage Blob Data Contributor` cho tài khoản Azure CLI hiện tại, chỉ trên storage account mới. Azure tính phí lưu trữ và thao tác theo mức sử dụng; không có VM hay dịch vụ parser được tạo trong thay đổi này.

## Bật trong server

Thêm vào `.env` ở root dự án hoặc biến môi trường của server:

```dotenv
SUPPORT_DOCUMENT_STORAGE=azure
AZURE_STORAGE_ACCOUNT_NAME=stfreellmdocs261114
AZURE_STORAGE_CONTAINER_NAME=tenant-documents
```

Server đọc `.env` qua `server/src/env.ts`. Khởi động lại server sau khi đổi cấu hình. Mặc định không đặt `SUPPORT_DOCUMENT_STORAGE` sẽ giữ chế độ SQLite hiện tại; có thể tắt archive bằng `disabled`. Giá trị backend sai hoặc cấu hình Azure thiếu sẽ khiến import thất bại, không tự bỏ qua việc lưu.

Máy phát triển dùng `az login` trong cùng tài khoản chạy server. `DefaultAzureCredential` dùng phiên đăng nhập đó. Môi trường triển khai cần managed identity hoặc service principal riêng; phiên Azure CLI trên máy này không cấp quyền cho server khác. Với hosting hỗ trợ managed identity, bật identity, cấp role bằng lệnh dưới và cấu hình các biến trên tại hosting. Hosting ngoài Azure dùng workload identity federation hoặc service principal qua secret manager của hệ thống triển khai. Không đưa credential vào frontend, Git hoặc Docker image.

```powershell
$storageScope = az storage account show --resource-group rg-freellmapi-documents --name stfreellmdocs261114 --query id -o tsv
# Thay bằng object ID của managed identity / service principal chạy server.
az role assignment create --assignee-object-id <hosting-principal-object-id> --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Contributor' --scope $storageScope
```

Ứng dụng production vẫn cần `ENCRYPTION_KEY` hiện có của deployment. Sao lưu khóa riêng an toàn cùng quy trình sao lưu database. Không sinh khóa thay thế cho database đang hoạt động. Khi xoay khóa, giữ khóa cũ để mở archive lịch sử; công cụ xoay khóa database hiện tại không tự mã hóa lại Blob.

## Luồng lưu hiện tại

Khi nhập tài liệu qua Knowledge Library đã xác thực:

1. Server kiểm tra tenant, source, phiên bản và định dạng; chuẩn hóa nội dung. Source đã đủ số revision không được upload nội dung mới, nhưng vẫn chấp nhận nhập lại revision trùng.
2. Nếu bật Azure, ghi một envelope AES-256-GCM chứa `tenantId`, `sourceId` và tài liệu chuẩn hóa (metadata, nội dung, chunks).
3. Blob nằm tại `tenants/<tenantId>/knowledge/<sourceId>/<contentHash>.json`; dùng conditional create để không ghi đè bản đã tồn tại. Nội dung/tiêu đề không nằm trong Blob metadata.
4. Sau khi lưu Blob thành công, transaction SQLite kiểm tra lại phiên bản rồi lưu revision/chunks như trước. Lỗi Azure trả `503 document_storage_unavailable` và không commit revision mới.

Upload có giới hạn thời gian 10 giây và hỗ trợ hủy khi client ngắt kết nối. Import URL vẫn chịu deadline tổng của luồng hiện có. Tài liệu trùng nội dung được dùng lại; các tài liệu thuộc tenant/source khác nằm ở các prefix khác.

Database vẫn là nguồn dữ liệu chính cho quyền truy cập, bản xuất bản và RAG; Blob là bản lưu bổ sung. Không có endpoint public để đọc Blob, không bật CORS và không cấp SAS cho trình duyệt. Tài liệu đã có trước khi bật Azure chưa được backfill.

Định dạng nhập hiện tại vẫn là text, Markdown và FAQ JSON. Lưu file PDF/DOCX gốc, parse sang Markdown, OCR và vector hóa là các bước riêng chưa được thêm bởi thay đổi này.

## Vận hành và xóa dữ liệu

Nếu Blob thành công nhưng transaction bị conflict/hủy, có thể còn object không được revision nào tham chiếu. Không tự xóa trong request lỗi vì request đồng thời có thể đã dùng cùng object. Chưa áp dụng chính sách retention/lifecycle tự động. Archive source trong UI không xóa bản lưu; khi xóa dữ liệu tenant vĩnh viễn, người vận hành phải xóa đúng prefix tenant trong Blob đồng thời với dữ liệu database và bản sao lưu liên quan. Không thể phục hồi toàn bộ database chỉ từ archive này.

Không bật versioning hoặc soft delete trong cấu hình hiện tại. Quyết định retention/erasure toàn hệ thống cần áp dụng trước khi đưa dữ liệu production vào kho.

## Xác minh đã chạy

- 2026-11-14: nhập một tài liệu Markdown giả qua `importSupportEvidenceRevision` với database in-memory, tải object thật từ Azure, giải mã và đối chiếu nội dung/tenant thành công.
- GET ẩn danh của object bị từ chối (`409` khi account cấm public access).
- Đã xóa object kiểm thử; không sửa database hay tài liệu production.
- Các test adapter, import, store và HTTP chạy offline, không yêu cầu credential Azure.

```powershell
npm run build -w server
npm exec -w server -- vitest run src/__tests__/custom/x-support-document-storage.test.ts src/__tests__/custom/x-support-evidence-store.test.ts src/__tests__/custom/x-support-evidence-import.test.ts src/__tests__/custom/x-support-evidence-http.test.ts --pool=forks --fileParallelism=false
az storage account show -g rg-freellmapi-documents -n stfreellmdocs261114 --query '{public:allowBlobPublicAccess,sharedKey:allowSharedKeyAccess,tls:minimumTlsVersion,https:enableHttpsTrafficOnly}'
az storage blob list --account-name stfreellmdocs261114 --container-name tenant-documents --auth-mode login --query '[].name'
```

Cấu hình `.env` đã được đặt trong worktree `azure-document-storage` và được Git bỏ qua. Code chưa được triển khai lên hosting production.

Tham khảo: [passwordless Blob SDK](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs), [Azure CLI data authorization](https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-data-operations-cli).
