import { renderDocText } from '@rentpro/core';

/** Dữ liệu mẫu cho xem trước mẫu hợp đồng. */
export const SAMPLE_VARS: Record<string, string> = {
  ten_cua_hang: 'Cửa hàng Mẫu', ten_khach: 'Nguyễn Văn A', ma_don: 'DT-XXXX-00001', so_hop_dong: 'HD-XXXX-00001',
  tong_tien: '500.000 đ', tien_coc: '1.000.000 đ', ngay_bat_dau: '01/01/2027', ngay_ket_thuc: '02/01/2027',
};

/** Thay biến trong điều khoản. Điều khoản không có biến giữ nguyên từng chữ (không đụng tới khoảng trắng của mẫu mặc định). */
export function renderContractTerms(terms: string[], vars: Record<string, string | undefined>): string[] {
  return terms.map((t) => (t.includes('{') ? renderDocText(t, vars) : t));
}
