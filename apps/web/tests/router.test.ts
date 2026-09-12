import { describe, expect, it } from 'vitest';
import { router } from '../src/router';
import DemandsView from '../src/views/DemandsView.vue';
import ReservesView from '../src/views/ReservesView.vue';
import FinanceView from '../src/views/FinanceView.vue';
import AnalysisView from '../src/views/AnalysisView.vue';
import DeliveryView from '../src/views/DeliveryView.vue';

describe('business routes', () => {
  it('lazy-loads the real demand pool at /demands instead of the P2 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/demands');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(DemandsView);
  });

  it('lazy-loads the real reserve conversion page at /reserves instead of the P3 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/reserves');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(ReservesView);
  });

  it('lazy-loads the real finance workspace at /finance instead of the P4 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/finance');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(FinanceView);
  });

  it('lazy-loads the real analysis workspace at /analysis instead of the P6 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/analysis');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(AnalysisView);
  });

  it('lazy-loads the real delivery and settlement workspace at /delivery instead of the P5 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/delivery');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(DeliveryView);
  });
});
