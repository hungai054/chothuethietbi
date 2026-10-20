# API công khai và webhook

Dành cho gói **Doanh nghiệp** (tính năng `api`). Tài liệu OpenAPI đầy đủ, luôn khớp mã: `GET /api/v1/openapi.json` (không cần khóa).

## Xác thực

Tạo khóa ở **Cài đặt → API và webhook**. Khóa dạng `rp_live_…` chỉ hiện **một lần**; hệ thống chỉ lưu băm SHA-256. Gửi trong mọi lời gọi:

```
Authorization: Bearer rp_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Mỗi khóa có **phạm vi** (chọn tối thiểu cần dùng) và có thể đặt ngày hết hạn; thu hồi có hiệu lực ngay. Khóa chạy với quyền hẹp: **không bao giờ** xem được giấy tờ tùy thân, tiền cọc/hoàn tiền hay cài đặt.

| Phạm vi | Cho phép |
|---|---|
| `inventory:read` | Xem mẫu thiết bị và từng thiết bị |
| `customers:read` / `customers:write` | Xem / tạo khách hàng (không gồm giấy tờ) |
| `bookings:read` / `bookings:write` | Xem / tạo đơn thuê |
| `availability:read` | Tra cứu số chiếc còn trống |

## Điểm cuối

| Phương thức | Đường dẫn | Phạm vi |
|---|---|---|
| GET | `/api/v1/equipment-models?q=` | `inventory:read` |
| GET | `/api/v1/equipment-units?status=&modelId=&page=&pageSize=` | `inventory:read` |
| GET / POST | `/api/v1/customers` | `customers:read` / `customers:write` |
| GET | `/api/v1/availability?start=&end=&modelId=` | `availability:read` |
| GET | `/api/v1/bookings?status=&customerId=&page=&pageSize=` | `bookings:read` |
| GET | `/api/v1/bookings/{id}` | `bookings:read` |
| POST | `/api/v1/bookings` | `bookings:write` |

Quy ước:

- Tiền là **số nguyên đồng**. Thời gian theo **ISO 8601 kèm múi giờ** (`2027-03-01T08:00:00+07:00`); chuỗi không có múi giờ bị từ chối.
- Danh sách phân trang: `page` (từ 1), `pageSize` (1–100, mặc định 25), trả `{ data, total }`.
- Lỗi luôn dạng `{ "error": { "code", "message" } }` với `message` tiếng Việt: `400` đầu vào sai, `401` thiếu/sai khóa, `403` thiếu phạm vi hoặc gói chưa có API hoặc cửa hàng ở chế độ chỉ đọc, `404`, `409` xung đột lịch, `413` nội dung quá lớn, `429` quá 120 lời gọi/phút (xem `Retry-After`).
- Đơn tạo qua API dùng đúng logic giao diện: kiểm tra lịch trống, tính giá theo bảng giá, giữ chỗ/xác nhận, ghi nhật ký và phát webhook. Trạng thái ban đầu `QUOTE` (mặc định, không giữ chỗ), `HOLD` hoặc `CONFIRMED`.

```bash
curl -s https://demo.example.vn/api/v1/availability \
  --get --data-urlencode 'start=2027-03-01T08:00:00+07:00' --data-urlencode 'end=2027-03-02T08:00:00+07:00' \
  -H "Authorization: Bearer $RENTPRO_KEY"

curl -s https://demo.example.vn/api/v1/bookings -H "Authorization: Bearer $RENTPRO_KEY" -H 'content-type: application/json' \
  -d '{"customerId":"<uuid>","start":"2027-03-01T08:00:00+07:00","end":"2027-03-02T08:00:00+07:00","status":"CONFIRMED","items":[{"modelId":"<uuid>","qty":1}]}'
```

## Webhook đi

Đăng ký địa chỉ **HTTPS** ở cùng trang cài đặt, chọn sự kiện: `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.delivered`, `booking.returned`, `payment.recorded`. Địa chỉ nội bộ/loopback bị chặn (chống SSRF).

Mỗi sự kiện là một `POST` JSON `{ id, type, createdAt, data }` với các header:

- `X-RentPro-Timestamp`: giây Unix.
- `X-RentPro-Signature`: `v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.

Kiểm tra chữ ký trên **nội dung thô** và từ chối nếu lệch quá 5 phút:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, timestamp, rawBody, header) {
  const want = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return Math.abs(Date.now() / 1000 - Number(timestamp)) < 300 && header.length === want.length && timingSafeEqual(Buffer.from(header), Buffer.from(want));
}
```

Trả mã `2xx` trong vài giây để xác nhận. Nếu không, hệ thống thử lại tối đa 6 lần (sau 1 phút, 5 phút, 30 phút, 2 giờ, 12 giờ). Nên xử lý theo `id` để chống trùng. Địa chỉ lỗi liên tiếp 30 lần sẽ tự tạm dừng; bật lại và gửi lại từng lần thất bại ở trang cài đặt. Có thể đổi bí mật ký bất cứ lúc nào (bí mật cũ ngừng hiệu lực ngay).
