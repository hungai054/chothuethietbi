import { vndInWords } from '../finance/words';

export interface ContractStore { name: string; address?: string; phone?: string; taxCode?: string; representative?: string }
export interface ContractCustomer {
  type: 'PERSON' | 'COMPANY'; name: string; phone: string; email?: string | null; address?: string | null;
  companyName?: string | null; taxCode?: string | null; representative?: string | null;
  /** Chỉ 4 số cuối: hợp đồng không in số giấy tờ đầy đủ */
  idDocument?: { label: string; last4: string } | null;
}
export interface ContractItem { name: string; qty: number; units: string[]; lineTotal: number }

export interface ContractInput {
  number: string; date: Date; timeZone: string; store: ContractStore; customer: ContractCustomer;
  booking: { code: string; start: Date; end: Date }; items: ContractItem[];
  rentTotal: number; depositRequired: number; terms?: string[];
  /** Tiêu đề do cửa hàng đặt (mặc định "HỢP ĐỒNG CHO THUÊ THIẾT BỊ") */
  title?: string;
  /** Trường tùy chỉnh được chèn vào hợp đồng */
  extras?: { label: string; value: string }[];
}

export interface ContractContent {
  v: 1;
  title: string; number: string; dateText: string; store: ContractStore; customer: ContractCustomer;
  booking: { code: string; startText: string; endText: string }; items: ContractItem[];
  money: { rentTotal: number; rentWords: string; depositRequired: number; depositWords: string | null };
  terms: string[];
  extras?: { label: string; value: string }[];
}

export const DEFAULT_CONTRACT_PATTERN = 'HD-{year}-{seq:5}';

export const DEFAULT_TERMS: readonly string[] = [
  'Bên B nhận thiết bị trong tình trạng đã được hai bên kiểm tra và ghi nhận trong biên bản giao nhận; chịu trách nhiệm bảo quản thiết bị trong suốt thời gian thuê.',
  'Bên B trả thiết bị đúng hạn, đầy đủ phụ kiện. Trả trễ quá thời gian ân hạn, Bên B chịu phí trễ hạn theo bảng phí của Bên A.',
  'Thiết bị hư hỏng do lỗi của Bên B được bồi thường theo chi phí sửa chữa thực tế; thiết bị mất hoặc hỏng không sửa được bồi thường theo giá trị bồi thường đã niêm yết.',
  'Tiền đặt cọc (và tài sản thế chấp nếu có) được giữ đến khi Bên A kiểm tra thiết bị khi nhận lại; khấu trừ các khoản phát sinh (nếu có) rồi hoàn phần còn lại cho Bên B.',
  'Bên B không được cho thuê lại, cầm cố hoặc chuyển giao thiết bị cho bên thứ ba khi chưa có sự đồng ý bằng văn bản của Bên A.',
  'Việc gia hạn thời gian thuê phải được Bên A đồng ý trước khi hết hạn và có thể phát sinh thêm tiền thuê theo bảng giá.',
  'Tranh chấp phát sinh được hai bên thương lượng giải quyết; nếu không đạt thỏa thuận thì đưa ra cơ quan có thẩm quyền theo quy định pháp luật Việt Nam.',
  'Bên A thu thập và xử lý dữ liệu cá nhân của Bên B (họ tên, liên hệ, giấy tờ tùy thân) chỉ cho mục đích thực hiện hợp đồng, theo Nghị định 13/2023/NĐ-CP và chính sách quyền riêng tư của Bên A.',
];

const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
const fmtDay = (d: Date, tz: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);

/** Dựng nội dung hợp đồng thành dữ liệu có cấu trúc (lưu nguyên bản chụp khi lập hợp đồng; PDF và màn hình cùng dựng từ đây). */
export function buildContractContent(i: ContractInput): ContractContent {
  return {
    v: 1,
    title: i.title ?? 'HỢP ĐỒNG CHO THUÊ THIẾT BỊ',
    number: i.number,
    dateText: fmtDay(i.date, i.timeZone),
    store: i.store,
    customer: i.customer,
    booking: { code: i.booking.code, startText: fmtDate(i.booking.start, i.timeZone), endText: fmtDate(i.booking.end, i.timeZone) },
    items: i.items,
    money: {
      rentTotal: i.rentTotal, rentWords: vndInWords(i.rentTotal),
      depositRequired: i.depositRequired, depositWords: i.depositRequired > 0 ? vndInWords(i.depositRequired) : null,
    },
    terms: [...(i.terms ?? DEFAULT_TERMS)],
    ...(i.extras && i.extras.length ? { extras: i.extras } : {}),
  };
}
