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
const username = 'e2e-admin-with-a-very-long-username-for-layout-audit-2026';
const password = 'HeadlessOnly-2026!';
const bootstrapToken = 'headless-e2e-bootstrap-token';
const credentialPepper = 'headless-e2e-credential-pepper';

let stateRoot = '';
let baseUrl = '';
let server: ChildProcess | null = null;
let authenticatedState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
let drawerFixture: { projectId: string; taskId: string; taskMaterialId: string } | undefined;

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
  await expect(page.getByText(username).first()).toBeVisible();
}

async function loginThroughUi(page: Page) {
  await page.goto(baseUrl);
  await expect(page.getByRole('heading', { name: '登录管理台' })).toBeVisible();
  await page.locator('[data-test="login-username"] input').fill(username);
  await page.locator('[data-test="login-password"] input').fill(password);
  await page.locator('[data-test="login-submit"]').click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function mutationThroughSession<T>(page: Page, path: string, key: string, body: unknown, expectedStatus: number) {
  const result = await page.evaluate(async ({ path: requestPath, key: idempotencyKey, body: requestBody }) => {
    const response = await fetch(requestPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(requestBody),
    });
    return { status: response.status, payload: await response.json() };
  }, { path, key, body });
  expect(result.status, `${path} 测试夹具创建失败：${JSON.stringify(result.payload)}`).toBe(expectedStatus);
  return result.payload as T;
}

async function createDrawerFixture(page: Page) {
  const created = await mutationThroughSession<{ data: { id: string; version: number; materialRequirements: Array<{ id: string }> } }>(
    page,
    '/api/reserve-projects',
    'e2e-drawer-project',
    {
      name: 'E2E 抽屉响应式验收项目',
      year: 2026,
      owner: 'E2E',
      demandIds: [],
      materials: [{
        materialId: null,
        model: 'E2E-MATERIAL',
        unit: '件',
        requiredQuantityScaled: 10000,
        unitPriceScaled: null,
        reserveCategoryId: null,
      }],
    },
    201,
  );
  const projectId = created.data.id;
  const projectMaterialId = created.data.materialRequirements[0]!.id;
  const confirmed = await mutationThroughSession<{ data: { version: number } }>(
    page,
    `/api/reserve-projects/${encodeURIComponent(projectId)}/confirm`,
    'e2e-drawer-confirm',
    { expectedVersion: created.data.version, reason: 'E2E 抽屉验收' },
    200,
  );
  const released = await mutationThroughSession<{ data: { projectVersion: number } }>(
    page,
    '/api/project-releases',
    'e2e-drawer-release',
    { projectId, expectedProjectVersion: confirmed.data.version, releaseDate: '2026-09-16', note: 'E2E 抽屉验收' },
    201,
  );
  const task = await mutationThroughSession<{ data: { id: string; materials: Array<{ id: string }> } }>(
    page,
    '/api/project-tasks',
    'e2e-drawer-task',
    {
      projectId,
      expectedProjectVersion: released.data.projectVersion,
      name: 'E2E 抽屉验收任务',
      description: null,
      scopeText: null,
      owner: 'E2E',
      plannedDate: null,
      plannedQuantityScaled: 10000,
      unit: '项',
      demandScopes: [],
      materials: [{ projectMaterialRequirementId: projectMaterialId, quantityScaled: 10000 }],
    },
    201,
  );
  return { projectId, taskId: task.data.id, taskMaterialId: task.data.materials[0]!.id };
}

async function assertNoHorizontalOverflow(page: Page) {
  const state = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.className),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        };
      })
      .filter((item) => item.right > viewportWidth + 1 || item.left < -1)
      .slice(0, 8);
    return {
      overflow: document.documentElement.scrollWidth > viewportWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth,
      offenders,
    };
  });
  expect(state.overflow, `${page.url()} 横向溢出：${JSON.stringify(state)}`).toBe(false);
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

async function assertNoVisibleLoadError(page: Page) {
  const errors = await page.locator([
    '.inline-error',
    '.detail-error',
    '.finance-error',
    '.classification-error',
    '.operation-error',
    '.error-recovery',
    '.n-alert.n-alert--error-type',
  ].join(', ')).evaluateAll((elements) => elements
    .map((element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      return {
        text: node.innerText.trim().slice(0, 180),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden',
      };
    })
    .filter((item) => item.visible));
  expect(errors, `${page.url()} 仍处于加载错误态：${JSON.stringify(errors)}`).toEqual([]);
}

async function assertOverlayWithinViewport(page: Page, overlay: Locator, label: string) {
  await expect(overlay).toBeVisible();
  let latest: {
    x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
    visualViewport?: { width: number; height: number; offsetLeft: number; offsetTop: number };
    style?: Record<string, string>; parent?: { x: number; y: number; width: number; height: number };
    container?: { x: number; y: number; width: number; height: number; position: string; left: string; right: string; top: string; bottom: string };
  } | null = null;
  try {
    await expect.poll(async () => {
      const box = await overlay.boundingBox();
      if (!box) return false;
      const diagnostics = await overlay.evaluate((element) => {
        const style = getComputedStyle(element);
        const parentRect = element.parentElement?.getBoundingClientRect();
        const container = element.closest<HTMLElement>('.n-drawer-container');
        const containerRect = container?.getBoundingClientRect();
        const containerStyle = container ? getComputedStyle(container) : null;
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          visualViewport: window.visualViewport ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          } : undefined,
          style: {
            left: style.left,
            right: style.right,
            top: style.top,
            bottom: style.bottom,
            transform: style.transform,
            marginLeft: style.marginLeft,
            marginRight: style.marginRight,
            position: style.position,
            boxSizing: style.boxSizing,
            overflow: style.overflow,
          },
          parent: parentRect ? { x: parentRect.x, y: parentRect.y, width: parentRect.width, height: parentRect.height } : undefined,
          container: containerRect && containerStyle ? {
            x: containerRect.x,
            y: containerRect.y,
            width: containerRect.width,
            height: containerRect.height,
            position: containerStyle.position,
            left: containerStyle.left,
            right: containerStyle.right,
            top: containerStyle.top,
            bottom: containerStyle.bottom,
          } : undefined,
        };
      });
      latest = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        viewportWidth: diagnostics.viewport.width,
        viewportHeight: diagnostics.viewport.height,
        ...diagnostics,
      };
      return box.x >= -1
        && box.y >= -1
        && box.x + box.width <= diagnostics.viewport.width + 1
        && box.y + box.height <= diagnostics.viewport.height + 1;
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

async function assertMobileShellTouchTargets(page: Page) {
  await expect(page.locator('.topbar .identity-card')).toBeHidden();

  await page.getByRole('button', { name: '更多' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const drawerLogout = page.locator('.mobile-account-row .n-button');
  const drawerBox = await drawerLogout.boundingBox();
  expect(drawerBox?.height ?? 0, '手机账号区退出按钮命中高度不足').toBeGreaterThanOrEqual(44);
}

async function assertMobileContentTouchTargets(page: Page) {
  const offenders = await page.locator('.content-wrap button').evaluateAll((buttons) => buttons
    .map((button) => {
      const element = button as HTMLElement;
      const rect = element.getBoundingClientRect();
      return {
        text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 40),
        height: Math.round(rect.height * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        className: element.className,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden',
      };
    })
    .filter((item) => item.visible && item.height < 36));
  expect(offenders, `${page.url()} 手机内容区发现低于 36px 的按钮：${JSON.stringify(offenders)}`).toEqual([]);
}

async function assertSidebarActiveIndicator(page: Page, title: string, path: string) {
  await page.goto(`${baseUrl}${path}`);
  const item = page.locator(`.nav-item[title="${title}"]`);
  await expect(item).toHaveClass(/active/);
  const indicator = await item.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    const itemRect = element.getBoundingClientRect();
    const iconRect = element.querySelector('.app-icon')?.getBoundingClientRect();
    const left = Number.parseFloat(style.left);
    const width = Number.parseFloat(style.width);
    return {
      content: style.content,
      left,
      width,
      itemWidth: itemRect.width,
      iconLeft: iconRect ? iconRect.left - itemRect.left : Number.NaN,
    };
  });
  expect(indicator.content).not.toBe('none');
  expect(indicator.left).toBeGreaterThanOrEqual(0);
  expect(indicator.left + indicator.width).toBeLessThanOrEqual(indicator.itemWidth);
  expect(indicator.iconLeft - (indicator.left + indicator.width), `${title} 激活竖条与图标间距不足`).toBeGreaterThanOrEqual(8);
}

async function assertShellIdentity(page: Page, compact = false) {
  const sidebarAccount = page.locator('.sidebar-account');
  await expect(sidebarAccount).toBeVisible();
  if (compact) {
    await expect(sidebarAccount.locator('.account-copy')).toBeHidden();
  } else {
    await expect(sidebarAccount.locator('strong')).toHaveText(username);
    await expect(sidebarAccount.locator('small')).toHaveText('系统管理员');
  }
  await expect(sidebarAccount.locator('.account-avatar')).toHaveText(username.slice(0, 1).toUpperCase());

  const identity = page.locator('.identity-card');
  await expect(identity.locator('strong')).toHaveText(username);
  await expect(identity).not.toContainText('系统管理员');
  await expect(identity.locator('small')).toHaveCount(0);
  await assertNoSiblingOverlap(page, '.identity-card', ['.identity-copy', '.n-button'], '右上账号区');

  if (!compact) {
    await expect(page.locator('.app-shell').getByText('系统管理员', { exact: true })).toHaveCount(1);
  }
}

async function assertNoSiblingOverlap(page: Page, parentSelector: string, childSelectors: string[], label: string) {
  const overlaps = await page.locator(parentSelector).evaluateAll((parents, selectors) => {
    const issues: string[] = [];
    const intersects = (a: DOMRect, b: DOMRect) => (
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
    );
    for (const [parentIndex, parent] of parents.entries()) {
      const boxes = (selectors as string[]).map((selector) => {
        const element = parent.querySelector<HTMLElement>(selector);
        return element ? { selector, rect: element.getBoundingClientRect() } : null;
      }).filter((entry): entry is { selector: string; rect: DOMRect } => Boolean(entry));
      for (let left = 0; left < boxes.length; left += 1) {
        for (let right = left + 1; right < boxes.length; right += 1) {
          if (intersects(boxes[left].rect, boxes[right].rect)) {
            issues.push(`#${parentIndex} ${boxes[left].selector} ↔ ${boxes[right].selector}`);
          }
        }
      }
    }
    return issues;
  }, childSelectors);
  expect(overlaps, `${label} 出现元素重叠：${overlaps.join(' | ')}`).toEqual([]);
}

async function assertRouteLayout(page: Page, path: string, mobile: boolean) {
  await page.goto(`${baseUrl}${path}`);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.content-wrap')).not.toBeEmpty();
  await assertNoVisibleLoadError(page);
  await assertNoHorizontalOverflow(page);
  await assertVisibleTextFloor(page);
  if (mobile) {
    await expect(page.locator('.app-sider')).toBeHidden();
    await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    await assertMobileNavigationTargets(page);
    await assertMobileContentTouchTargets(page);
    await assertNoSiblingOverlap(page, '.mobile-bottom-nav > button', ['.app-icon', 'small'], '手机底部导航');
  } else {
    await expect(page.locator('.app-sider')).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  }
}

async function validateKeyOverlays(browser: Browser, options: { width: number; height: number; mobile: boolean }) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: 'light',
    isMobile: options.mobile,
    hasTouch: options.mobile,
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

async function validateBusinessDrawers(browser: Browser, width: number, height: number) {
  if (!drawerFixture) throw new Error('业务抽屉测试夹具尚未创建');
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'light',
    isMobile: false,
    hasTouch: true,
    storageState: authenticatedState,
  });
  try {
    const page = await context.newPage();
    const projectUrl = `${baseUrl}/projects/${encodeURIComponent(drawerFixture.projectId)}`;
    const taskUrl = `${projectUrl}/tasks/${encodeURIComponent(drawerFixture.taskId)}`;

    await page.goto(projectUrl);
    await page.locator('[data-test="project-tab-materials"]').click();
    await expect(page.locator('[data-test="edit-project-materials"]')).toBeVisible();
    await page.locator('[data-test="edit-project-materials"]').click();
    await assertOverlayWithinViewport(page, page.locator('.project-materials-drawer.n-drawer'), '项目物资抽屉');

    await page.goto(projectUrl);
    await page.locator('[data-test="project-tab-demands"]').click();
    await page.locator('[data-test="edit-project-sources"]').click();
    await assertOverlayWithinViewport(page, page.locator('.project-source-drawer.n-drawer'), '项目来源抽屉');

    await page.goto(taskUrl);
    await page.locator(`[data-test="open-supply-${drawerFixture.taskMaterialId}"]`).click();
    await assertOverlayWithinViewport(page, page.locator('.supply-drawer.n-drawer'), '供应进度抽屉');

    await page.goto(taskUrl);
    await page.locator('[data-test="task-section-implementation"]').click();
    await page.locator('[data-test="open-implementation"]').click();
    await assertOverlayWithinViewport(page, page.locator('.task-progress-drawer.n-drawer'), '实施抽屉');

    await page.goto(taskUrl);
    await page.locator('[data-test="task-section-settlement"]').click();
    await page.locator('[data-test="open-settlement"]').click();
    await assertOverlayWithinViewport(page, page.locator('.task-progress-drawer.n-drawer'), '结算抽屉');
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
  compact?: boolean;
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
      await assertMobileShellTouchTargets(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '更多' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await assertNoSiblingOverlap(
        page,
        '.mobile-more-grid > button',
        [':scope > .mobile-more-icon', ':scope > span:nth-child(2)', ':scope > .mobile-more-chevron'],
        `${options.name} 更多菜单`,
      );
      const mobileAccount = page.locator('.mobile-account-row');
      await expect(mobileAccount.locator('.account-avatar')).toHaveText(username.slice(0, 1).toUpperCase());
      await expect(mobileAccount.locator('strong')).toHaveText(username);
      await expect(mobileAccount.locator('small')).toHaveText('系统管理员');
      await assertNoSiblingOverlap(
        page,
        '.mobile-account-row',
        ['.account-avatar', '.mobile-account-copy', '.n-button'],
        `${options.name} 手机账号区`,
      );
      const settingsButton = page.locator('.mobile-more-grid > button').filter({ hasText: '设置' });
      await expect(settingsButton).toBeVisible();
      await settingsButton.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/administration$/);
    } else {
      await page.goto(`${baseUrl}/`);
      await assertShellIdentity(page, options.compact);
      await assertNoSiblingOverlap(page, '.nav-item', ['.app-icon', 'span'], `${options.name} 侧栏图标/文字`);
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
    await expect(page.locator('.identity-card')).toContainText(username);
    authenticatedState = await page.context().storageState();
  });

  test('为业务抽屉响应式验收创建隔离项目和任务夹具', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authenticatedState });
    try {
      const page = await context.newPage();
      await page.goto(baseUrl);
      await expect(page.locator('.app-shell')).toBeVisible();
      drawerFixture = await createDrawerFixture(page);
    } finally {
      await context.close();
    }
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
    { name: 'desktop-low-height-light', width: 1440, height: 600, colorScheme: 'light' as const, mobile: false },
    { name: 'compact-narrow-light', width: 768, height: 900, colorScheme: 'light' as const, mobile: false, compact: true },
    { name: 'compact-low-height-light', width: 768, height: 600, colorScheme: 'light' as const, mobile: false, compact: true },
    { name: 'compact-light', width: 900, height: 900, colorScheme: 'light' as const, mobile: false, compact: true },
    { name: 'compact-wide-light', width: 1100, height: 900, colorScheme: 'light' as const, mobile: false, compact: true },
    { name: 'mobile-narrow-light', width: 320, height: 700, colorScheme: 'light' as const, mobile: true },
    { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' as const, mobile: true },
    { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' as const, mobile: true },
  ]) {
    test(`${options.name} 通过真实登录后的布局和导航验收`, async ({ browser }) => {
      await validateAuthenticatedUi(browser, options);
    });
  }

  test('桌面关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, { width: 1440, height: 900, mobile: false });
  });

  test('紧凑桌面关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, { width: 768, height: 700, mobile: false });
  });

  test('手机关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, { width: 390, height: 844, mobile: true });
  });

  test('窄屏手机关键写入弹层不超出视口', async ({ browser }) => {
    await validateKeyOverlays(browser, { width: 320, height: 700, mobile: true });
  });

  test('手机业务抽屉不超出视口', async ({ browser }) => {
    await validateBusinessDrawers(browser, 390, 844);
  });

  test('窄屏手机业务抽屉不超出视口', async ({ browser }) => {
    await validateBusinessDrawers(browser, 320, 700);
  });
});
