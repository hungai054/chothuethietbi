-- Giai đoạn 12: thương mại. Thuê bao, hóa đơn, mã giảm giá, lịch sử (MRR/churn), thư đi của nền tảng, đăng ký tự phục vụ.
-- Bảng nền tảng ghi bằng role quản trị. Tenant chỉ ĐỌC subscription/invoice của chính mình (RLS tenant_read).

CREATE TABLE platform_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant ADD COLUMN locked_by_billing boolean NOT NULL DEFAULT false;

CREATE TABLE coupon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,30}$'),
  description text,
  percent_off int CHECK (percent_off BETWEEN 1 AND 100),
  amount_off bigint CHECK (amount_off > 0),
  plan_codes text[],
  valid_until timestamptz,
  max_redemptions int CHECK (max_redemptions > 0),
  redeemed int NOT NULL DEFAULT 0 CHECK (redeemed >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(percent_off, amount_off) = 1)
);

-- Trạng thái thuê bao hiện tại (mỗi tenant một dòng). period_end NULL = hợp đồng không thời hạn (ký ngoài).
CREATE TABLE subscription (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  plan_id uuid NOT NULL REFERENCES plan(id),
  cycle text NOT NULL CHECK (cycle IN ('MONTH','YEAR')),
  period_start timestamptz NOT NULL,
  period_end timestamptz,
  price_paid bigint NOT NULL DEFAULT 0 CHECK (price_paid >= 0),
  mrr bigint NOT NULL DEFAULT 0 CHECK (mrr >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_end > period_start)
);

-- Lịch sử thuê bao (chỉ thêm): nguồn cho báo cáo MRR, khách mới, khách rời bỏ, chuyển đổi dùng thử.
CREATE TABLE subscription_event (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('TRIAL_START','ACTIVATE','RENEW','UPGRADE','DOWNGRADE','MANUAL','READ_ONLY','SUSPEND','REACTIVATE')),
  plan_code text,
  cycle text,
  mrr bigint NOT NULL DEFAULT 0,
  amount bigint NOT NULL DEFAULT 0,
  period_end timestamptz,
  invoice_id uuid,
  data jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscription_event (tenant_id, at);
CREATE INDEX ON subscription_event (at);

CREATE TABLE invoice_counter (year int PRIMARY KEY, last_value int NOT NULL DEFAULT 0);
CREATE SEQUENCE invoice_order_seq START 100000;

CREATE TABLE invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('SUBSCRIPTION','UPGRADE')),
  plan_id uuid NOT NULL REFERENCES plan(id),
  cycle text NOT NULL CHECK (cycle IN ('MONTH','YEAR')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  subtotal bigint NOT NULL CHECK (subtotal >= 0),
  discount bigint NOT NULL DEFAULT 0 CHECK (discount >= 0),
  credit_used bigint NOT NULL DEFAULT 0 CHECK (credit_used >= 0),
  amount bigint NOT NULL CHECK (amount >= 0),
  coupon_id uuid REFERENCES coupon(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','VOID')),
  pay_code text NOT NULL UNIQUE,
  provider text CHECK (provider IN ('PAYOS','VIETQR','MANUAL')),
  provider_ref text,
  checkout_url text,
  order_code bigint UNIQUE,
  note text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  paid_at timestamptz,
  paid_by text,
  CHECK (amount = subtotal - discount - credit_used),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CHECK (period_end > period_start)
);
CREATE INDEX ON invoice (tenant_id, created_at);
CREATE INDEX ON invoice (status, created_at);

-- Khóa chống xử lý trùng một webhook/giao dịch của nhà cung cấp
CREATE TABLE billing_event (
  provider text NOT NULL,
  event_id text NOT NULL,
  invoice_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Mốc nhắc gia hạn đã gửi (7 ngày, 1 ngày, hết hạn), theo từng kỳ
CREATE TABLE renewal_reminder (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_end timestamptz NOT NULL,
  slot int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_end, slot)
);

-- Thư đi của nền tảng (xác thực email, nhắc gia hạn, hóa đơn). Worker gửi; không có SMTP thì ghi CONSOLE.
CREATE TABLE platform_email (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenant(id),
  kind text NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','CONSOLE')),
  attempts int NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX ON platform_email (status, created_at);
CREATE INDEX ON platform_email (to_email, created_at);

-- Đăng ký chờ xác thực email: chưa tạo tenant cho tới khi bấm liên kết.
CREATE TABLE signup_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  owner_name text NOT NULL,
  shop_name text NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  password_hash text NOT NULL,
  plan_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX ON signup_request (email, created_at);
CREATE INDEX ON signup_request (slug);

-- Tenant chỉ đọc thuê bao + hóa đơn của chính mình (để hiển thị trang Gói dịch vụ kể cả khi chỉ đọc).
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON subscription FOR SELECT USING (tenant_id = app_tenant_id());
GRANT SELECT ON subscription TO rentpro_app;

ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON invoice FOR SELECT USING (tenant_id = app_tenant_id());
GRANT SELECT ON invoice TO rentpro_app;

GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;

GRANT SELECT ON platform_setting TO rentpro_app;
