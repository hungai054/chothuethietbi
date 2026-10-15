# Hướng dẫn sử dụng RentPro

Dành cho chủ cửa hàng và nhân viên. Mục nào không thấy trên menu nghĩa là tài khoản của bạn chưa có quyền hoặc gói dịch vụ chưa bao gồm; hỏi chủ cửa hàng. Tên gọi các mục (Thiết bị, Đơn thuê…) có thể được cửa hàng đổi ở **Cài đặt → Nhãn và thuật ngữ**.

## Đổi mật khẩu

- Bấm **Đổi mật khẩu** ở thanh đầu trang: nhập mật khẩu hiện tại, mật khẩu mới (ít nhất 10 ký tự, có chữ và số, khác mật khẩu cũ) và nhập lại. Nhập sai mật khẩu hiện tại 5 lần thì bị khóa chức năng này 15 phút.
- Khi chủ cửa hàng hoặc quản trị viên **đặt lại mật khẩu hộ bạn**, lần đăng nhập đầu bạn sẽ được đưa thẳng tới trang đổi mật khẩu và chưa dùng được phần còn lại cho đến khi đặt mật khẩu riêng.

## Phím tắt và tìm nhanh

- **Ctrl+K** (⌘+K trên Mac) ở bất kỳ trang nào: gõ tên trang để nhảy tới, hoặc gõ từ 2 ký tự để tìm đơn thuê, khách hàng, thiết bị (mã vạch, serial, tên) và mẫu thiết bị. ↑↓ chọn, Enter mở, Esc đóng. Chỉ hiện những gì bạn có quyền xem; số điện thoại khách chỉ hiện 4 số cuối.
- **Thông báo** (góc phải thanh đầu trang): cảnh báo quá hạn, công nợ, hạn mức tin nhắn, bảo trì đến hạn. Lọc "Chưa đọc", đánh dấu từng cái hoặc tất cả; trạng thái đọc riêng cho từng người.

## Vai trò mặc định

| Vai trò | Làm được |
|---|---|
| Chủ cửa hàng | Mọi thứ, kể cả thuê bao, xuất/xóa dữ liệu, xem số giấy tờ |
| Quản lý | Như chủ, trừ thanh toán thuê bao, xuất/xóa dữ liệu, vai trò tùy chỉnh |
| Nhân viên quầy | Khách, báo giá, đặt lịch, giao/nhận, thu tiền; không xem số giấy tờ |
| Kỹ thuật | Thiết bị, kiểm kê, bảo trì, xem đơn |

Gói cao hơn có thể thêm **vai trò tùy chỉnh** (Cài đặt → Vai trò tùy chỉnh) với ma trận quyền chi tiết.

## Quy trình một đơn thuê

1. **Khách hàng**: tạo khách (số điện thoại không trùng). Ảnh và số giấy tờ được mã hóa, mỗi lần xem đều ghi nhật ký. Khách có thể thuộc nhóm (giảm giá, bảng giá riêng) hoặc nằm trong danh sách đen.
2. **Tra cứu còn trống** (Đơn thuê → Tra cứu): chọn khoảng thời gian, xem số chiếc rảnh theo mẫu (đã tính thời gian đệm giữa hai lượt thuê).
3. **Tạo đơn**: chọn khách, thiết bị, thời gian. Giá tính tự động theo giờ/ngày/tuần/tháng của bảng giá, cộng giảm giá, phí giao hàng, VAT nếu có. Ba trạng thái ban đầu:
   - *Báo giá*: chỉ lưu giá, **không giữ chỗ**.
   - *Giữ chỗ*: giữ lịch trong thời gian cấu hình, hết hạn tự hủy.
   - *Xác nhận*: chốt lịch.
   Giá đã chốt lưu trong đơn; đổi bảng giá sau đó không làm đổi đơn cũ.
4. **Hợp đồng và cọc**: lập hợp đồng (điều khoản theo mẫu, ký tay trên màn hình), thu tiền cọc/tiền thuê (mỗi khoản có khóa chống bấm đúp, sai thì hủy kèm lý do, không sửa/xóa), in phiếu thu. Mã QR VietQR cho chuyển khoản.
5. **Giao thiết bị**: chọn đúng từng chiếc (quét mã vạch), chụp ảnh/biên bản, nhận tài sản thế chấp nếu có. Chiếc chuyển sang trạng thái đang thuê.
6. **Nhận về**: kiểm tra từng chiếc, ghi hư hỏng (tự tạo phiếu sửa chữa gắn đơn), tính phí trễ hạn, quyết toán (tiền thuê + phí − cọc), hoàn cọc. Số dư luôn tính lại từ sổ thu chi.
7. **Gia hạn / trả sớm / dời lịch**: tính lại từ giá đã chốt, kiểm tra xung đột lịch.

Màn hình **Hôm nay** liệt kê đơn cần giao, cần nhận, quá hạn. **Lịch (timeline)** cho phép kéo thả đơn (gói Chuyên nghiệp trở lên).

## Thiết bị và kho

- **Mẫu thiết bị** (có thể theo từng chiếc hoặc theo số lượng như cáp, pin) và **từng thiết bị** có mã vạch riêng (in tem hàng loạt), serial, giá mua, giá trị bồi thường.
- **Trạng thái**: Sẵn sàng → Đã đặt → Đang thuê → Đang kiểm tra / Bảo trì / Thanh lý / Mất; chuyển trạng thái theo quy tắc, có lý do và lịch sử.
- **Quét mã** tra cứu nhanh; **Kiểm kê** đối chiếu số thực tế; **Nhập Excel** nạp hàng loạt.

## Bảo trì và sửa chữa

Kế hoạch định kỳ theo ngày, số giờ hoặc số lượt thuê; đến hạn thì tự tạo phiếu và chiếm lịch của chiếc đó (chiếc đang bảo trì không còn xuất hiện trong thiết bị rảnh). Kỹ thuật viên cập nhật phiếu, đính ảnh trước/sau, ghi chi phí; quản lý có thể chuyển chi phí cho khách. Hoàn thành phiếu thì chiếc trở lại sẵn sàng; thanh lý thì ngừng cho thuê.

## Tin nhắn và nhắc nhở

Cài đặt → Tin nhắn và nhắc nhở: gửi qua **Email** (SMS và Zalo hiện đang tắt ở mọi gói). Chọn tài khoản của bạn hoặc kênh dùng chung (tính vào hạn mức tin hằng tháng), chỉnh mẫu tin, giờ nghỉ không gửi. Hệ thống tự nhắc nhận/trả, nhắc công nợ; mục **Tin nhắn** xem nhật ký gửi và gửi lại. Hãy bấm **Gửi thử** trước khi bật cho khách.

## Báo cáo

Tổng quan, Doanh thu, Công nợ, Sổ cọc, Hiệu suất thiết bị, ROI, Bảo trì, Khách hàng, Tồn kho; xuất Excel. Lưu ý hai con số khác nhau có chủ ý: **Doanh thu ghi nhận** (tiền thuê của đơn đã giao, theo ngày giao) và **Thực thu** (dòng tiền thực nhận). Báo cáo có tiền cần quyền xem tài chính.

## Cài đặt

Trung tâm cài đặt gom: tài chính và hợp đồng (tài khoản nhận tiền, quy tắc cọc, mẫu số), đặt lịch, tính giá (ân hạn, phí trễ, trả sớm), tin nhắn, mẫu tài liệu, nhãn, **trường tùy chỉnh**, **thương hiệu** (logo, màu, tên miền riêng), người dùng và vai trò, **Gói dịch vụ** (hạn dùng, mức sử dụng, hóa đơn, gia hạn, tải toàn bộ dữ liệu), **Nhật ký thao tác**, **API và webhook**, Extension. Chi tiết tùy biến: [CUSTOMIZATION.md](CUSTOMIZATION.md); tích hợp: [API.md](API.md).

### Nhật ký thao tác

Cài đặt → Nhật ký thao tác (chủ và quản lý): ai làm gì, lúc nào, trên đối tượng nào; lọc theo thao tác, đối tượng, người, ngày (theo múi giờ cửa hàng) và từ khóa. Chỉ chủ cửa hàng xuất được CSV, và mỗi lần xuất cũng được ghi lại. Nhật ký chỉ thêm, không sửa hay xóa được từ giao diện.

## Gói dịch vụ và chế độ chỉ đọc

Khi gói hết hạn, cửa hàng có thời gian ân hạn, sau đó chuyển sang **chỉ đọc** (vẫn xem và xuất dữ liệu, không tạo/sửa được) và cuối cùng bị khóa. Gia hạn ở Cài đặt → Gói dịch vụ (PayOS/VietQR); thanh toán xong cửa hàng mở lại ngay. Dữ liệu của bạn luôn tải về được.
