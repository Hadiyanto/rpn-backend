/** Parses a Cookie header into name → value (first occurrence wins). */
export const parseCookies = (header: string | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        const name = part.slice(0, eq).trim();
        if (!name || name in out) continue;
        let value = part.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    }
    return out;
};
