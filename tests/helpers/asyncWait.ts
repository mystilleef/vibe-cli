/**
 * Bounded condition wait for tests: poll a predicate until it holds or the
 * deadline expires, failing loudly instead of hanging the worker. The
 * immediate first check keeps settled conditions cost-free; the interval
 * only paces genuinely pending conditions.
 */
export async function waitForCondition(
  check: () => boolean,
  {
    timeoutMs = 5_000,
    intervalMs = 1,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, intervalMs));
  }
}
