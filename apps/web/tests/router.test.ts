import { describe, expect, it } from 'vitest';
import { router } from '../src/router';
import DemandsView from '../src/views/DemandsView.vue';

describe('P2 routes', () => {
  it('lazy-loads the real demand pool at /demands instead of the P2 placeholder', async () => {
    const route = router.getRoutes().find((item) => item.path === '/demands');
    expect(route).toBeTruthy();
    const loader = route?.components?.default;
    expect(typeof loader).toBe('function');
    const resolved = await (loader as () => Promise<{ default: unknown }>)();
    expect(resolved.default).toBe(DemandsView);
  });
});
