import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E, type E2EState } from '../env';

export const state = (): E2EState => JSON.parse(readFileSync(E2E.stateFile, 'utf8')) as E2EState;

/** Signs in as one of the prepared users in a fresh browser context. */
export async function signIn(browser: Browser, who: keyof E2EState['users']): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(state().users[who].email);
  await page.getByLabel('Password').fill(E2E.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return { context, page };
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A small valid PNG whose bytes depend on the seed, so every test image is a different file. */
export function png(seed: number, size = 48): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = (seed * 37 + x * 3) % 256;
    row[2 + x * 3] = (seed * 91) % 256;
    row[3 + x * 3] = (seed * 53 + x) % 256;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
}

export const file = (name: string, buffer: Buffer, mimeType: string) => ({ name, mimeType, buffer });

/** Full-page screenshot kept in e2e/screenshots as a record of what the screens look like. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(E2E.screenshotDir, `${name}.png`), fullPage: true });
}

/** The folder card of one document type on the Documents tab. */
export function folder(page: Page, title: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: new RegExp(`^${title}`) }) });
}

export async function expectStage(page: Page, label: string): Promise<void> {
  await expect(page.locator('h1')).toContainText(label);
}
