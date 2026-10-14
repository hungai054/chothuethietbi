-- Giai đoạn 5: đặt lịch. Nguồn sự thật về lịch là unit_allocation (từng chiếc, có exclusion constraint)
-- và qty_allocation (hàng theo số lượng). unit.status chỉ phản ánh tình trạng vật lý hiện tại (đổi lúc giao/nhận ở Giai đoạn 6).

ALTER TABLE booking
  ADD COLUMN quote jsonb,
  ADD COLUMN pricing_input jsonb,           -- dữ liệu đầu vào tính giá (bảng giá tại thời điểm đặt) để gia hạn/trả sớm giữ nguyên giá đã chốt
  ADD COLUMN notes text,
  ADD COLUMN created_by uuid,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN extended_count int NOT NULL DEFAULT 0,
  ADD CONSTRAINT booking_hold_has_expiry CHECK (status <> 'HOLD' OR hold_expires_at IS NOT NULL),
  ADD CONSTRAINT booking_total_nonneg CHECK (total >= 0),
  ADD CONSTRAINT booking_cancel_has_reason CHECK (status <> 'CANCELLED' OR length(btrim(coalesce(cancel_reason, ''))) > 0);
CREATE INDEX ON booking (tenant_id, customer_id);
CREATE INDEX ON booking (tenant_id, starts_at);
CREATE INDEX ON booking (tenant_id, status, hold_expires_at) WHERE status = 'HOLD';

CREATE TABLE booking_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES equipment_model(id),
  unit_id uuid REFERENCES equipment_unit(id),       -- có giá trị khi khách chọn đích danh một chiếc
  qty int NOT NULL CHECK (qty > 0 AND qty <= 1000),
  line_total bigint NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  CHECK (unit_id IS NULL OR qty = 1)
);
CREATE INDEX ON booking_line (tenant_id, booking_id);
CREATE INDEX ON booking_line (tenant_id, model_id);

ALTER TABLE unit_allocation ADD COLUMN booking_line_id uuid REFERENCES booking_line(id) ON DELETE CASCADE;
CREATE INDEX ON unit_allocation (tenant_id, booking_id);

-- Hàng quản lý theo số lượng: kiểm tra tồn kho bằng cách khóa dòng mẫu rồi cộng các đơn chồng thời gian.
CREATE TABLE qty_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  booking_line_id uuid REFERENCES booking_line(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES equipment_model(id),
  qty int NOT NULL CHECK (qty > 0),
  period tstzrange NOT NULL CHECK (NOT isempty(period)),
  status text NOT NULL CHECK (status IN ('HOLD','CONFIRMED','ACTIVE','RELEASED'))
);
CREATE INDEX qty_allocation_period ON qty_allocation USING gist (tenant_id, model_id, period);
CREATE INDEX ON qty_allocation (tenant_id, booking_id);

CREATE TABLE booking_status_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  user_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON booking_status_log (tenant_id, booking_id, created_at);

-- Bộ đếm số chứng từ, tăng nguyên tử, reset theo năm
CREATE TABLE doc_counter (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL,
  year int NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind, year)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['booking_line','qty_allocation','booking_status_log','doc_counter']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rentpro_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON booking_status_log FROM rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
