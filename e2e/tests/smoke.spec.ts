import { test, expect } from '@playwright/test';

test('trang đăng nhập cửa hàng demo hiển thị tên cửa hàng', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Cửa hàng Demo' })).toBeVisible();
});

test('đăng nhập sai bị từ chối, đúng vào được trang chủ', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill('owner@demo.local');
  await page.getByPlaceholder('Mật khẩu').fill('sai-mat-khau-1');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByText('Email hoặc mật khẩu không đúng.')).toBeVisible();

  await page.getByPlaceholder('Mật khẩu').fill('Demo@12345678');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('OWNER')).toBeVisible();
});

test('host lạ không thấy dữ liệu cửa hàng', async ({ page }) => {
  await page.goto('http://khong-co.localhost:3000/login');
  await expect(page.getByText('Không tìm thấy cửa hàng')).toBeVisible();
});

test('đăng xuất quay về trang đăng nhập của đúng cửa hàng (không mất host)', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill('owner@demo.local');
  await page.getByPlaceholder('Mật khẩu').fill('Demo@12345678');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL('http://demo.localhost:3000/');
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL('http://demo.localhost:3000/login');
  await expect(page.getByRole('heading', { name: 'Cửa hàng Demo' })).toBeVisible();
});
