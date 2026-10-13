-- Cổng quản trị: TOTP, phiên hỗ trợ (đăng nhập thay), role nền tảng.

-- Role cho cổng quản trị: BYPASSRLS vì phải thao tác xuyên tenant. Chỉ apps/admin dùng.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rentpro_admin') THEN
    CREATE ROLE rentpro_admin LOGIN PASSWORD 'rentpro_admin' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER TABLE platform_user
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE tenant ADD COLUMN notes text, ADD COLUMN account_manager_id uuid REFERENCES platform_user(id);

-- Mỗi lần nhân viên nền tảng đăng nhập thay. Tenant xem được lịch sử (chỉ đọc).
CREATE TABLE support_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  platform_user_id uuid NOT NULL REFERENCES platform_user(id),
  platform_user_email text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX ON support_access (tenant_id, created_at);

ALTER TABLE support_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON support_access FOR SELECT USING (tenant_id = app_tenant_id());
GRANT SELECT ON support_access TO rentpro_app;

-- Admin được toàn quyền trên mọi bảng (hiện tại và về sau do role chạy migration tạo ra).
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rentpro_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO rentpro_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO rentpro_admin;
