'use server';
import { redirect } from 'next/navigation';
import { requireMarketingHost, shopUrl } from '@/lib/marketing';

/** "Vào cửa hàng": chuyển tới trang đăng nhập của địa chỉ cửa hàng (không kiểm tra tồn tại để không lộ danh sách cửa hàng). */
export async function enterShop(f: FormData) {
  await requireMarketingHost();
  const address = String(f.get('slug') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(address)) redirect('/gioi-thieu?error=' + encodeURIComponent('Địa chỉ cửa hàng không hợp lệ.'));
  redirect(`${await shopUrl(address)}/login`);
}
