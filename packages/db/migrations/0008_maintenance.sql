-- Giai đoạn 8: kế hoạch bảo trì định kỳ và phiếu bảo trì / sửa chữa.
-- Phiếu có khung giờ bảo trì thì CHIẾM LỊCH thiết bị qua unit_allocation (status MAINTENANCE, không thuộc đơn nào):
-- exclusion constraint của Giai đoạn 5 tự chặn trùng với đơn thuê đã đặt.

CREATE TABLE maintenance_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  model_id uuid NOT NULL REFERENCES equipment_model(id),
  unit_id uuid REFERENCES equipment_unit(id),              -- NULL = áp dụng cho mọi thiết bị của mẫu
  every_days int CHECK (every_days > 0),
  every_hours int CHECK (every_hours > 0),                  -- số giờ ĐÃ CHO THUÊ kể từ lần bảo trì trước
  every_rentals int CHECK (every_rentals > 0),              -- số lượt thuê kể từ lần bảo trì trước
  duration_hours int NOT NULL DEFAULT 4 CHECK (duration_hours BETWEEN 1 AND 720),
  checklist jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_plan_has_trigger CHECK (every_days IS NOT NULL OR every_hours IS NOT NULL OR every_rentals IS NOT NULL)
);
CREATE INDEX ON maintenance_plan (tenant_id, active);
CREATE INDEX ON maintenance_plan (tenant_id, model_id);

CREATE TABLE work_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  unit_id uuid NOT NULL REFERENCES equipment_unit(id),
  kind text NOT NULL CHECK (kind IN ('PERIODIC','REPAIR','INSPECTION','OTHER')),
  source text NOT NULL CHECK (source IN ('PLAN','DAMAGE','MANUAL')),
  plan_id uuid REFERENCES maintenance_plan(id),
  booking_id uuid REFERENCES booking(id),                   -- đơn thuê làm hỏng thiết bị (phiếu từ biên bản nhận)
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','DONE','UNREPAIRABLE','DISPOSED','CANCELLED')),
  technician_id uuid REFERENCES app_user(id),
  vendor text,                                              -- đơn vị sửa ngoài
  vendor_cost bigint NOT NULL DEFAULT 0 CHECK (vendor_cost >= 0),
  labor_cost bigint NOT NULL DEFAULT 0 CHECK (labor_cost >= 0),
  parts jsonb NOT NULL DEFAULT '[]',                        -- [{ name, qty, unitCost }]
  checklist jsonb NOT NULL DEFAULT '[]',                    -- [{ text, done }]
  cost_total bigint NOT NULL DEFAULT 0 CHECK (cost_total >= 0),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  due_date date,
  started_at timestamptz,
  finished_at timestamptz,
  close_note text,
  photos_before text[] NOT NULL DEFAULT '{}',
  photos_after text[] NOT NULL DEFAULT '{}',
  charged_fee_id uuid REFERENCES booking_fee(id),           -- khoản phí đã chuyển cho khách
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT work_order_window_pair CHECK ((scheduled_start IS NULL) = (scheduled_end IS NULL)),
  CONSTRAINT work_order_window_order CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start),
  CONSTRAINT work_order_done_has_time CHECK (status NOT IN ('DONE') OR finished_at IS NOT NULL),
  CONSTRAINT work_order_started_has_time CHECK (status = 'PENDING' OR status = 'CANCELLED' OR started_at IS NOT NULL),
  CONSTRAINT work_order_plan_source CHECK ((source = 'PLAN') = (plan_id IS NOT NULL))
);
CREATE INDEX ON work_order (tenant_id, status);
CREATE INDEX ON work_order (tenant_id, unit_id);
CREATE INDEX ON work_order (tenant_id, technician_id) WHERE status IN ('PENDING','IN_PROGRESS');
-- Mỗi (thiết bị, kế hoạch) chỉ có một phiếu định kỳ đang mở: hai lần quét đồng thời không tạo trùng.
CREATE UNIQUE INDEX work_order_one_open_per_plan ON work_order (tenant_id, unit_id, plan_id)
  WHERE plan_id IS NOT NULL AND status IN ('PENDING','IN_PROGRESS');

ALTER TABLE unit_allocation ADD COLUMN work_order_id uuid REFERENCES work_order(id);
CREATE INDEX ON unit_allocation (tenant_id, work_order_id) WHERE work_order_id IS NOT NULL;
-- Khung bảo trì không thuộc đơn nào; mọi khung còn lại phải thuộc một đơn
ALTER TABLE unit_allocation ADD CONSTRAINT unit_allocation_owner CHECK (
  (status = 'MAINTENANCE' AND booking_id IS NULL AND work_order_id IS NOT NULL) OR (status <> 'MAINTENANCE' AND booking_id IS NOT NULL) OR status = 'RELEASED');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_plan','work_order'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON maintenance_plan, work_order TO rentpro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
