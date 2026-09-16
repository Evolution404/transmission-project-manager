import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const apiConfig = resolve(root, 'apps/api/wrangler.jsonc');
const databaseName = 'transmission-project-manager-local';
const username = 'e2e-admin';
const password = 'HeadlessOnly-2026!';
const bootstrapToken = 'headless-e2e-bootstrap-token';
const credentialPepper = 'headless-e2e-credential-pepper';

let stateRoot = '';
let baseUrl = '';
let server: ChildProcess | null = null;
let authenticatedState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('无法取得无头测试端口'));
        return;
      }
      const port = address.port;
      socket.close(() => resolvePort(port));
    });
  });
}

async function waitForReady(url: string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`隔离 UI 测试服务未就绪：${String(lastError ?? 'timeout')}`);
}

async function bootstrapThroughUi(page: Page) {
  await page.goto(baseUrl);
  await expect(page.getByRole('heading', { name: '初始化系统管理员' })).toBeVisible();
  await page.locator('[data-test="bootstrap-display-name"] input').fill('无头测试管理员');
  await page.locator('[data-test="login-username"] input').fill(username);
  await page.locator('[data-test="login-password"] input').fill(password);
  await page.locator('[data-test="bootstrap-confirm-password"] input').fill(password);
  await page.locator('[data-test="bootstrap-token"] input').fill(bootstrapToken);
  await page.locator('[data-test="login-submit"]').click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByText('无头测试管理员').first()).toBeVisible();
}

async function loginThroughUi(page: Page) {
  await page.goto(baseUrl);
  await expect(page.getByRole('heading', { name: '登录管理台' })).toBeVisible();
  await page.locator('[data-test="login-username"] input').fill(username);
  await page.locator('[data-test="login-password"] input').fill(password);
  await page.locator('[data-test="login-submit"]').click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
}

async function assertVisibleTextFloor(page: Page) {
  const offenders = await page.locator('main').evaluate((root) => {
    const results: string[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (!ownText) continue;
      const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
      if (fontSize < 12) results.push(`${fontSize}px <${element.tagName.toLowerCase()}.${element.className}>: ${ownText.slice(0, 60)}`);
      if (results.length >= 12) break;
    }
    return results;
  });
  expect(offenders, `${page.url()} 发现低于 12px 的可见业务文字：${offenders.join(' | ')}`).toEqual([]);
}

async function assertOverlayWithinViewport(page: Page, overlay: Locator, label: string) {
  await expect(overlay).toBeVisible();
  let latest: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null = null;
  try {
    await expect.poll(async () => {
      const box = await overlay.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) return false;
      latest = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      };
      return box.x >= -1
        && box.y >= -1
        && box.x + box.width <= viewport.width + 1
        && box.y + box.height <= viewport.height + 1;
    }).toBe(true);
  } catch (cause) {
    throw new Error(`${label} 未完全进入视口；最终几何=${JSON.stringify(latest)}`, { cause });
  }
}

async function assertMobileNavigationTargets(page: Page) {
  const heights = await page.locator('.mobile-bottom-nav > button').evaluateAll((buttons) => (
    buttons.map((button) => button.getBoundingClientRect().height)
  ));
  expect(heights).toHaveLength(5);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
}

async function assertSidebarActiveIndicator(page: Page, title: string, path: string) {
  await page.goto(`${baseUrl}${path}`);
  const item = page.locator(`.nav-item[title="${title}"]`);
  await expect(item).toHaveClass(/active/);
  const indicator = await item.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    const itemRect = element.getBoundingClientRect();
    const left = Number.parseFloat(style.left);
    const width = Number.parseFloat(style.width);
    return { content: style.content, left, width, itemWidth: itemRect.width };
  });
  expect(indicator.content).not.toBe('none');
  expect(indicator.left).toBeGreaterThanOrEqual(0);
  expect(indicator.left + indicator.width).toBeLessThanOrEqual(indicator.itemWidth);
}

async function assertRouteLayout(page: Page, path: string, mobile: boolean) {
  await page.goto(`${baseUrl}${path}`);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.content-wrap')).not.toBeEmpty();
  await assertNoHorizontalOverflow(page);
  await assertVisibleTextFloor(page);
  if (mobile) {
    await expect(page.locator('.app-sider')).toBeHidden();
    await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    await assertMobileNavigationTargets(page);
  } else {
    await expect(page.locator('.app-sider')).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  }
}

async function validateKeyOverlays(browser: Browser, mobile: boolean) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    colorScheme: 'light',
    isMobile: mobile,
    hasTouch: mobile,
    storageState: authenticatedState,
  });
  try {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await expect(page.locator('.app-shell')).toBeVisible();

    await page.goto(`${baseUrl}/demands`);
    await page.locator('[data-test="open-manual-demand"]').click();
    await assertOverlayWithinViewport(page, page.getByRole('dialog').filter({ hasText: '新增需求' }), '新增需求');

    await page.goto(`${baseUrl}/projects`);
    await page.locator('[data-test="open-create-project"]').click();
    await assertOverlayWithinViewport(page, page.getByRole('dialog').filter({ hasText: '新建项目' }), '新建项目');

    await page.goto(`${baseUrl}/administration`);
    await page.getByRole('button', { name: '新增成员' }).click();
    await assertOverlayWithinViewport(page, page.getByRole('dialog').filter({ hasText: '新增成员' }), '新增成员');
  } finally {
    await context.close();
  }
}

async function validateAuthenticatedUi(browser: Browser, options: {
  name: string;
  width: number;
  height: number;
  colorScheme: 'light' | 'dark';
  mobile: boolean;
}) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: options.colorScheme,
    isMobile: options.mobile,
    hasTouch: options.mobile,
    storageState: authenticatedState,
  });
  try {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await expect(page.locator('.app-shell')).toBeVisible();
    const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-canvas').trim());
    expect(canvas).toBe(options.colorScheme === 'dark' ? '#0f131a' : '#f6f7f9');

    for (const path of ['/', '/demands', '/projects', '/tasks', '/finance', '/analysis', '/master-data', '/administration']) {
      await assertRouteLayout(page, path, options.mobile);
    }

    if (options.mobile) {
      await page.goto(`${baseUrl}/`);
      await page.getByRole('button', { name: '更多' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const settingsButton = page.locator('.mobile-more-grid > button').filter({ hasText: '设置' });
      await expect(settingsButton).toBeVisible();
      await settingsButton.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/administration$/);
    } else {
      await page.goto(`${baseUrl}/`);
      await page.locator('.nav-item[title="基础台账"]').click();
      await expect(page).toHaveURL(/\/master-data$/);
      await assertSidebarActiveIndicator(page, '基础台账', '/master-data');
      await assertSidebarActiveIndicator(page, '设置', '/administration');
    }
  } finally {
    await context.close();
  }
}

test.describe.serial('无头浏览器真实认证与响应式 UI', () => {
  test.beforeAll(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'tpm-headless-ui-'));
    const migration = spawnSync(wrangler, [
      'd1', 'migrations', 'apply', databaseName,
      '--local', '--persist-to', stateRoot,
      '--config', apiConfig,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
    if (migration.status !== 0) {
      throw new Error(`隔离 D1 初始化失败：\n${migration.stdout}\n${migration.stderr}`);
    }

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(wrangler, [
      'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
      '--persist-to', stateRoot, '--config', apiConfig,
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUTH_CREDENTIAL_PEPPER: credentialPepper,
        BOOTSTRAP_TOKEN: bootstrapToken,
      },
    });
    server.stdout?.resume();
    server.stderr?.resume();
    await waitForReady(baseUrl);
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => { server?.kill('SIGKILL'); resolveExit(); }, 3_000);
        server?.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
    }
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  });

  test('首次初始化通过页面输入测试账号、密码和令牌完成', async ({ page }) => {
    await bootstrapThroughUi(page);
  });

  test('新浏览器会话通过账号密码重新登录', async ({ page }) => {
    await loginThroughUi(page);
    await expect(page.locator('.identity-card')).toContainText(`@${username}`);
    authenticatedState = await page.context().storageState();
  });

  test('真实登录会话在业务深链整页刷新后保持当前路由', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      storageState: authenticatedState,
    });
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/master-data`);
      await expect(page.locator('.app-shell')).toBeVisible();
      await expect(page).toHaveURL(/\/master-data$/);
      await page.reload();
      await expect(page.locator('.app-shell')).toBeVisible();
      await expect(page).toHaveURL(/\/master-data$/);
      await expect(page.locator('.topbar-context')).toContainText('基础台账');
    } finally {
      await context.close();
    }
  });

  for (const options of [
    { name: 'desktop-light', width: 1440, height: 900, colorScheme: 'light' as const, mobile: false },
    { name: 'desktop-dark', width: 1440, height: 900, colorScheme: 'dark' as const, mobile: false },
    { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' as const, mobile: true },
    { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' as const, mobile: true },
  ]) {
    test(`${options.name} 通过真实登录后的布局和导航验收`, async ({ browser }) => {
      await validateAuthenticatedUi(browser, options);
    });
  }

  test('桌面关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, false);
  });

  test('手机关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, true);
  });
});
