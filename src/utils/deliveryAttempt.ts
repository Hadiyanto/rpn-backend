// Statuses an order_delivery_attempts row never leaves. A FAILED attempt is final too: the admin may
// already have retried (a new PENDING/ALLOCATED attempt), and only one attempt per order may be active.
export const FINAL_ATTEMPT_STATUSES = ['FAILED', 'CANCELLED', 'DELIVERED'];

/** The attempt's status after a provider update (refresh or webhook); null = no recognised status. */
export const nextAttemptStatus = (current: string, incoming: string | null): string | null =>
    FINAL_ATTEMPT_STATUSES.includes(current) ? current : incoming;

/**
 * Biteship's own explanation of an order's current status, from GET /orders/:id: the note of the latest
 * courier.history entry with that status (else the latest entry). Null when there is none.
 */
export const providerStatusNote = (remote: any): string | null => {
    const history: any[] = Array.isArray(remote?.courier?.history) ? remote.courier.history : [];
    const entry = [...history].reverse().find(h => h?.status === remote?.status) ?? history[history.length - 1];
    const note = typeof entry?.note === 'string' ? entry.note.trim() : '';
    return note || null;
};
