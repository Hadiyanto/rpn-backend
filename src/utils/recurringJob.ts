/**
 * Runs `job` every N minutes, N read from `envVar` (default `defaultMinutes`; 0 or invalid = off).
 * A slow round never overlaps the next one, and errors are logged, never thrown. `job` may return a
 * line to log (e.g. "2 of 5 changed"); nothing is logged for a quiet round.
 */
export const startRecurringJob = (
    label: string,
    envVar: string,
    defaultMinutes: number,
    job: () => Promise<string | null | void>,
) => {
    const raw = process.env[envVar];
    const minutes = raw === undefined || raw.trim() === '' ? defaultMinutes : Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        console.log(`${label} off (${envVar}=0)`);
        return null;
    }
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const summary = await job();
            if (summary) console.log(`${label}: ${summary}`);
        } catch (err) {
            console.error(`${label} failed:`, (err as Error)?.message ?? err);
        } finally {
            running = false;
        }
    };
    console.log(`${label} every ${minutes} min`);
    return setInterval(tick, minutes * 60 * 1000);
};
