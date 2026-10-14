-- Giai đoạn 7: nhật ký gửi thông báo, hộp thư trong app, nhật ký chạy tác vụ nền.
-- Tin nhắn là bằng chứng gửi đi: chỉ thêm và cập nhật trạng thái, không xóa.

CREATE TABLE notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid REFERENCES booking(id),
  customer_id uuid REFERENCES customer(id),
  event text NOT NULL,                              -- BEFORE_DUE, DUE, OVERDUE, DEBT, HOLD_EXPIRING, TEST
  channel text NOT NULL CHECK (channel IN ('zalo','sms','email')),
  recipient text NOT NULL,
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,
  provider text,
  provider_id text,
  scope text NOT NULL DEFAULT 'OWN' CHECK (scope IN ('OWN','SHARED','CONSOLE')),  -- SHARED = tài khoản chung, tính vào hạn mức gói
  idempotency_key text NOT NULL,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_sent_has_time CHECK (status <> 'SENT' OR sent_at IS NOT NULL),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ON notification_log (tenant_id, status, scheduled_for);
CREATE INDEX ON notification_log (tenant_id, booking_id);
CREATE INDEX ON notification_log (tenant_id, created_at DESC);
CREATE INDEX ON notification_log (tenant_id, scope, sent_at) WHERE status = 'SENT';

CREATE TABLE app_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  permission text,                                  -- chỉ người có quyền này thấy; NULL = mọi người dùng
  dedupe_key text NOT NULL,
  read_by uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ON app_notification (tenant_id, created_at DESC);

CREATE TABLE job_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON job_run (tenant_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_log','app_notification','job_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON notification_log, app_notification, job_run TO rentpro_app;
GRANT UPDATE (status, attempts, error, provider, provider_id, scope, scheduled_for, sent_at, updated_at, body, recipient) ON notification_log TO rentpro_app;
GRANT UPDATE (read_by) ON app_notification TO rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
