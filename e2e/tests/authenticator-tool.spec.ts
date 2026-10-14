import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { generateTotpSecret, totpAt } from '@rentpro/core';

const URL_TOOL = pathToFileURL(resolve(import.meta.dirname, '../../tools/authenticator.html')).href;

/** Mã hiện trên trang phải bằng mã hệ thống tính ở thời điểm đó (cho phép lệch một chu kỳ nếu đúng lúc đổi mã). */
async function shownCode(page: import('@playwright/test').Page, i = 0) {
  return (await page.getByTestId(`code-${i}`).innerText()).replace(/\s/g, '');
}
const valid = (s: string, shown: string) => [Date.now() - 1000, Date.now(), Date.now() + 1000].some((t) => totpAt(s, t) === shown);

test('trang lấy mã độc lập: thêm khóa, hiện đúng mã, giữ lại sau khi tải lại, xóa được', async ({ page }) => {
  await page.goto(URL_TOOL);
  await expect(page.getByText('Chưa có tài khoản nào')).toBeVisible();

  const secret = generateTotpSecret();
  await page.getByLabel(/Khóa/).fill(secret.toLowerCase().replace(/(.{4})/g, '$1 '));
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByTestId('code-0')).toHaveText(/^\d{3} \d{3}$/);
  expect(valid(secret, await shownCode(page))).toBe(true);
  await expect(page.getByText(/Đổi mã sau \d+ giây/)).toBeVisible();

  await page.reload(); // lưu trong trình duyệt
  expect(valid(secret, await shownCode(page))).toBe(true);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Xóa' }).click();
  await expect(page.getByText('Chưa có tài khoản nào')).toBeVisible();
});

test('trang lấy mã độc lập: báo lỗi tiếng Việt khi khóa sai hoặc trùng; nhận đường dẫn otpauth', async ({ page }) => {
  await page.goto(URL_TOOL);
  await page.getByLabel(/Khóa/).fill('khong hop le!');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('chỉ gồm chữ A-Z');

  const secret = generateTotpSecret();
  await page.getByLabel(/Khóa/).fill(`otpauth://totp/RentPro%20Admin:admin%40rentpro.local?secret=${secret}&issuer=RentPro%20Admin`);
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  expect(valid(secret, await shownCode(page))).toBe(true);

  await page.getByLabel(/Khóa/).fill(secret);
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('đã được thêm');
});
