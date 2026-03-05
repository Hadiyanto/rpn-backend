const BASE_URL = process.env.BITESHIP_BASE_URL || 'https://api-sandbox.biteship.com/v1';
const API_KEY = process.env.BITESHIP_KEY || '';

function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
    };
}

export async function biteshipGet<T = any>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || data.message || `Biteship GET ${path} failed: ${res.status}`);
    }
    return data as T;
}

export async function biteshipPost<T = any>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || data.message || `Biteship POST ${path} failed: ${res.status}`);
    }
    return data as T;
}
