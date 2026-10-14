# Tùy biến theo từng khách hàng

Nguyên tắc: **dùng tầng trên nếu làm được, chỉ xuống tầng dưới khi tầng trên không đủ.** Không bao giờ sửa lõi theo từng khách.

```
Khách cần X
 ├─ X là một con số / bật-tắt / chữ hiển thị / mức mặc định?   → Tầng 1: Cấu hình (tenant.settings)
 ├─ X là tính năng có sẵn nhưng chưa bật cho gói của khách?     → Tầng 2: Cờ tính năng / ghi đè theo tenant (cổng quản trị)
 ├─ X là thêm dữ liệu, đổi chữ, đổi mẫu, đổi quyền, đổi diện mạo? → Tầng 3: Không-code (bên dưới)
 └─ X là LOGIC nghiệp vụ riêng (tính giá, cọc, báo cáo, hook)?   → Tầng 4: Extension (Giai đoạn 11), trong extensions/<ma-khach-hang>/
```

## Tầng 3: tùy biến không cần code (Giai đoạn 10)

Tất cả nằm ở **Cài đặt** (`/settings`). Mục nào cần gói cao hơn sẽ hiện nhãn "Cần nâng cấp gói".

| Nhu cầu | Ở đâu | Gói | Lưu ở đâu |
|---|---|---|---|
| Thêm trường riêng (biển số xe, nơi sử dụng, người bảo lãnh, ảnh bằng lái…) cho thiết bị / khách / đơn thuê / hợp đồng | `/settings/custom-fields` | `custom_fields` | bảng `custom_field_def`; giá trị trong cột jsonb `custom_fields` của bản ghi |
| Sửa điều khoản hợp đồng, tiêu đề, phiếu thu, biên bản giao nhận; xem trước | `/settings/templates` | `contract` | `tenant.settings.templates` |
| Đổi tên gọi ("Thiết bị" → "Sản phẩm", "Đơn thuê" → "Booking") | `/settings/labels` | mọi gói | `tenant.settings.labels` |
| Logo, màu, favicon, tên hiển thị, chân trang, ẩn "Cung cấp bởi RentPro", tên người gửi email | `/settings/branding` | `white_label` | `tenant.settings.branding` + ảnh trong kho riêng tư |
| Thêm nhân viên, khóa tài khoản, đặt lại mật khẩu | `/settings/users` | mọi gói (có giới hạn số người dùng) | `app_user` |
| Vai trò tùy chỉnh với ma trận quyền | `/settings/roles` | `custom_roles` | `custom_role` (+ `app_user.custom_role_id`) |
| Tên miền riêng | `/settings/domains` | `custom_domain` | `tenant_domain` |
| Mẫu tin nhắn nhắc, kênh gửi | `/settings/notifications` | `notify.*` | `tenant.settings.notify` |

### Trường tùy chỉnh
- Kiểu: văn bản, số, ngày, chọn một, có/không, tệp (chỉ ảnh JPG/PNG/WebP, lưu riêng tư).
- Mỗi trường chọn được: **bắt buộc**, **hiện trong danh sách**, **tìm kiếm được** (văn bản/số/chọn), **chèn vào hợp đồng** (khách/đơn/hợp đồng; thiết bị thì không vì một đơn có nhiều thiết bị).
- Không đổi được mã và kiểu sau khi tạo; trường đã có dữ liệu chỉ **tắt**, không xóa. Tối đa 30 trường mỗi đối tượng.
- Trường bắt buộc được kiểm tra **trong cùng giao dịch** với lệnh tạo bản ghi (khách, thiết bị, đơn, hợp đồng). Giữ chỗ nhanh trên lịch không đủ thông tin sẽ báo lỗi và hướng dẫn dùng form đầy đủ.
- Trường tùy chỉnh của thiết bị có trong **xuất Excel**.

### Mẫu tài liệu
- Biến hệ thống: `{ten_cua_hang} {ten_khach} {ma_don} {so_hop_dong} {tong_tien} {tien_coc} {ngay_bat_dau} {ngay_ket_thuc}` và `{cf.<mã trường>}` cho trường tùy chỉnh.
- **Hợp đồng đã lập không đổi** khi sửa mẫu (nội dung được chụp lúc lập); mẫu mới chỉ áp dụng cho hợp đồng lập sau.

### Vai trò tùy chỉnh
- Quyền ghi tự kéo theo quyền xem. Quyền `billing.manage`, `roles.manage`, `data.delete` chỉ dành cho chủ cửa hàng.
- Hạ gói (mất `custom_roles`) thì người dùng tự về quyền mặc định của vai trò nền. Khóa tài khoản có hiệu lực ngay ở request kế tiếp.

### Tên miền riêng
1. Cửa hàng thêm tên miền; hệ thống sinh mã xác minh.
2. Cửa hàng tạo bản ghi **TXT** `_rentpro-verify.<tên miền>` = mã xác minh và **CNAME** về `CUSTOM_DOMAIN_TARGET` (mặc định `custom.<BASE_DOMAIN>`).
3. Bấm "Kiểm tra" → xác minh qua DNS. Sau đó `resolve_tenant` nhận tên miền này.
4. **Chứng chỉ HTTPS** do reverse proxy cấp tự động. Với Caddy:
   ```
   {
     on_demand_tls { ask http://web:3000/api/domain-check?key=<DOMAIN_CHECK_KEY> }
   }
   https:// { tls { on_demand } reverse_proxy web:3000 }
   ```
   Endpoint chỉ trả 200 cho tên miền đã xác minh.
- Chưa xác minh thì nhiều cửa hàng cùng khai báo một tên miền được; ai xác minh trước giữ tên miền.

## Biến môi trường liên quan
`BASE_DOMAIN`, `CUSTOM_DOMAIN_TARGET`, `DOMAIN_CHECK_KEY`.
