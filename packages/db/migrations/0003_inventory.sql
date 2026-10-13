-- Giai đoạn 3: tồn kho (mẫu, thiết bị, lịch sử trạng thái, bộ đếm mã vạch, kiểm kê).

ALTER TABLE category ADD COLUMN sort_order int NOT NULL DEFAULT 0;

ALTER TABLE equipment_model
  ADD COLUMN description text,
  ADD COLUMN specs jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN accessories jsonb NOT NULL DEFAULT '[]',          -- [{ "name": "Pin", "qty": 2 }]
  ADD COLUMN barcode_prefix text CHECK (barcode_prefix ~ '^[A-Z0-9]{1,8}$'),
  ADD COLUMN compensation_value bigint CHECK (compensation_value >= 0),
  ADD COLUMN maintenance_every_days int CHECK (maintenance_every_days > 0),
  ADD COLUMN maintenance_every_hours int CHECK (maintenance_every_hours > 0),
  ADD COLUMN maintenance_every_rentals int CHECK (maintenance_every_rentals > 0),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT equipment_model_qty_nonneg CHECK (stock_qty >= 0);

ALTER TABLE equipment_unit
  ADD COLUMN purchase_date date,
  ADD COLUMN compensation_value bigint CHECK (compensation_value >= 0),
  ADD COLUMN condition text NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('NEW','GOOD','FAIR','POOR')),
  ADD COLUMN location text,
  ADD COLUMN notes text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT equipment_unit_purchase_nonneg CHECK (purchase_price >= 0);

-- Serial duy nhất trong tenant khi có giá trị (bỏ qua bản ghi đã xóa mềm)
CREATE UNIQUE INDEX equipment_unit_serial_uq ON equipment_unit (tenant_id, model_id, serial)
  WHERE serial IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ON equipment_unit (tenant_id, branch_id, status);

-- Mỗi lần đổi trạng thái: ai, lúc nào, lý do
CREATE TABLE unit_status_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  unit_id uuid NOT NULL REFERENCES equipment_unit(id),
  from_status text,
  to_status text NOT NULL,
  user_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON unit_status_log (tenant_id, unit_id, created_at);

-- Bộ đếm mã vạch theo tiền tố, tăng nguyên tử
CREATE TABLE barcode_counter (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  prefix text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, prefix)
);

CREATE TABLE stocktake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  branch_id uuid REFERENCES branch(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX ON stocktake (tenant_id, status);

CREATE TABLE stocktake_scan (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  stocktake_id uuid NOT NULL REFERENCES stocktake(id),
  unit_id uuid NOT NULL REFERENCES equipment_unit(id),
  scanned_by uuid,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stocktake_id, unit_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_status_log','barcode_counter','stocktake','stocktake_scan']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rentpro_app', t);
  END LOOP;
END $$;

-- Nhật ký trạng thái chỉ thêm, không sửa/xóa
REVOKE UPDATE, DELETE ON unit_status_log FROM rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
