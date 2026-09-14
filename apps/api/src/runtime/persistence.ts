import type { RuntimeBindings } from '../runtime-env';
import type { PersistencePorts } from '../ports/runtime';

export function resolvePersistence(bindings: RuntimeBindings): PersistencePorts {
  if (bindings.PERSISTENCE) return bindings.PERSISTENCE;
  throw new Error('Persistence runtime is not configured');
}
