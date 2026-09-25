// All business dates are Asia/Jakarta (WIB). The server itself runs in UTC (Render), so never
// rely on the server's local timezone for "today" or for turning a YYYY-MM-DD into a weekday.

/** Today's date in Asia/Jakarta as YYYY-MM-DD. */
export const todayWIB = (now: Date = new Date()): string =>
    now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

/** A calendar date (YYYY-MM-DD) as a Date at 12:00 UTC — the same calendar day in every timezone we care about. */
const atNoonUTC = (date: string) => new Date(`${date}T12:00:00Z`);

/** Weekday of a calendar date: 0 = Sunday … 6 = Saturday, independent of server timezone. */
export const dayOfWeek = (date: string): number => atNoonUTC(date).getUTCDay();

/** e.g. "Senin, 2 Maret 2026" for a YYYY-MM-DD calendar date. */
export const formatDateID = (date: string): string =>
    atNoonUTC(date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
