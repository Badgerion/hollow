/**
 * Hydra inlet stub — state provider interface.
 *
 * Wire-in now so any future Hydra state provider plugs into Hollow's
 * session layer without touching pipeline internals.
 *
 * The NullStateProvider is the default — it logs and returns empty state.
 * Replace it with a real provider via registerStateProvider() when Hydra exists.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HydraSessionState {
  cookies?: Record<string, string>;
  localStorage?: Record<string, string>;
  headers?: Record<string, string>;
  userAgent?: string;
}

export interface StateProvider {
  hydrate(sessionId: string, stateId: string): Promise<HydraSessionState>;
  dehydrate(sessionId: string, stateId: string, state: HydraSessionState): Promise<void>;
}

// ─── No-op provider ───────────────────────────────────────────────────────────

export class NullStateProvider implements StateProvider {
  async hydrate(sessionId: string, stateId: string): Promise<HydraSessionState> {
    console.log(
      `[hollow/hydra] hydrate called — ` +
      `stateId: ${stateId} — ` +
      `no provider registered, returning empty state`
    );
    return {};
  }

  async dehydrate(sessionId: string, stateId: string, _state: HydraSessionState): Promise<void> {
    console.log(
      `[hollow/hydra] dehydrate called — ` +
      `stateId: ${stateId} — ` +
      `no provider registered, state not persisted`
    );
  }
}

// ─── Singleton registry ───────────────────────────────────────────────────────

let _provider: StateProvider = new NullStateProvider();

export function registerStateProvider(p: StateProvider): void {
  _provider = p;
  console.log('[hollow/hydra] StateProvider registered');
}

export function getStateProvider(): StateProvider {
  return _provider;
}
