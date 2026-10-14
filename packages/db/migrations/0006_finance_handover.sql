-- Giai đoạn 6: hợp đồng, thanh toán/cọc, phí phát sinh, biên bản giao nhận.
-- Sổ cái tiền (payment, booking_fee) KHÔNG xóa và KHÔNG sửa số tiền: sai thì hủy (void) kèm lý do rồi nhập lại.

ALTER TABLE booking
  ADD COLUMN deposit_required bigint NOT NULL DEFAULT 0 CHECK (deposit_required >= 0),
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN returned_at timestamptz,
  ADD COLUMN closed_at timestamptz;

CREATE TABLE contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SIGNED','VOID')),
  content jsonb NOT NULL,                      -- bản chụp nội dung lúc lập, không đổi theo dữ liệu sau này
  sign_mode text CHECK (sign_mode IN ('ESIGN','PAPER')),
  customer_signature_path text,
  staff_signature_path text,
  signed_customer_name text,
  signed_at timestamptz,
  void_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CONSTRAINT contract_signed_has_time CHECK (status <> 'SIGNED' OR (signed_at IS NOT NULL AND sign_mode IS NOT NULL)),
  CONSTRAINT contract_void_has_reason CHECK (status <> 'VOID' OR length(btrim(coalesce(void_reason, ''))) > 0)
);
-- Mỗi đơn chỉ có một hợp đồng còn hiệu lực
CREATE UNIQUE INDEX contract_one_active_per_booking ON contract (tenant_id, booking_id) WHERE status <> 'VOID';

CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id),
  kind text NOT NULL CHECK (kind IN ('RENT','DEPOSIT','FEE','REFUND','WRITE_OFF')),
  method text NOT NULL CHECK (method IN ('CASH','BANK_TRANSFER','CARD','E_WALLET','OTHER')),
  amount bigint NOT NULL CHECK (amount > 0),
  reference text,
  note text,
  idempotency_key text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text,
  voided_by uuid,
  CONSTRAINT payment_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT payment_writeoff_has_note CHECK (kind <> 'WRITE_OFF' OR length(btrim(coalesce(note, ''))) > 0)
);
CREATE INDEX ON payment (tenant_id, booking_id);
CREATE INDEX ON payment (tenant_id, paid_at);
CREATE UNIQUE INDEX payment_idempotency ON payment (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE booking_fee (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id),
  kind text NOT NULL CHECK (kind IN ('LATE','DAMAGE','LOSS','OTHER')),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount bigint NOT NULL CHECK (amount > 0),
  unit_id uuid REFERENCES equipment_unit(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text,
  voided_by uuid,
  CONSTRAINT fee_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ON booking_fee (tenant_id, booking_id);

-- Tài sản thế chấp (CCCD gốc, xe máy, laptop…) giữ thay hoặc cùng tiền cọc
CREATE TABLE deposit_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  estimated_value bigint NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  storage_location text,
  photo_paths text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','RETURNED')),
  received_by uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  return_note text,
  returned_by uuid,
  CONSTRAINT asset_returned_pair CHECK ((status = 'RETURNED') = (returned_at IS NOT NULL))
);
CREATE INDEX ON deposit_asset (tenant_id, booking_id);
CREATE INDEX ON deposit_asset (tenant_id, status);

-- Biên bản giao/nhận: bất biến sau khi lập
CREATE TABLE handover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid NOT NULL REFERENCES booking(id),
  kind text NOT NULL CHECK (kind IN ('DELIVERY','RETURN')),
  performed_by uuid,
  performed_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  UNIQUE (booking_id, kind)
);
CREATE INDEX ON handover (tenant_id, booking_id);

CREATE TABLE handover_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  handover_id uuid NOT NULL REFERENCES handover(id) ON DELETE CASCADE,
  unit_id uuid REFERENCES equipment_unit(id),       -- hàng theo từng chiếc
  model_id uuid REFERENCES equipment_model(id),     -- hàng theo số lượng
  qty int NOT NULL DEFAULT 1 CHECK (qty >= 0),
  condition text NOT NULL CHECK (condition IN ('GOOD','FAIR','DAMAGED','MISSING')),
  accessories jsonb NOT NULL DEFAULT '[]',
  notes text,
  photo_paths text[] NOT NULL DEFAULT '{}',
  CHECK (unit_id IS NOT NULL OR model_id IS NOT NULL)
);
CREATE INDEX ON handover_item (tenant_id, handover_id);
CREATE INDEX ON handover_item (tenant_id, unit_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract','payment','booking_fee','deposit_asset','handover','handover_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Quyền của app role: sổ cái chỉ thêm và hủy (không xóa, không sửa số tiền); biên bản chỉ thêm
GRANT SELECT, INSERT, UPDATE ON contract TO rentpro_app;
GRANT SELECT, INSERT ON payment, booking_fee, handover, handover_item TO rentpro_app;
GRANT UPDATE (voided_at, void_reason, voided_by) ON payment TO rentpro_app;
GRANT UPDATE (voided_at, void_reason, voided_by) ON booking_fee TO rentpro_app;
GRANT SELECT, INSERT, UPDATE ON deposit_asset TO rentpro_app;
GRANT UPDATE (deposit_required, delivered_at, returned_at, closed_at) ON booking TO rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
