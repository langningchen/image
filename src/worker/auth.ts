export async function secretMatches(supplied: string, secret: string): Promise<boolean> {
    if (!supplied || supplied.length > 1024) return false;
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([supplied, secret].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
    const left = new Uint8Array(a);
    const right = new Uint8Array(b);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
}
