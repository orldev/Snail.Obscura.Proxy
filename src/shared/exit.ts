export interface Exit {
  ip: string;
  place: string;
}

const TIMEOUT = 8000;

/**
 * Exit address through the current proxy: requests from extension pages follow
 * the same proxy settings as the profile's tabs.
 */
export async function checkExit(): Promise<Exit> {
  try {
    const response = await fetch('https://ipinfo.io/json', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) });
    const body = (await response.json()) as { ip?: string; country?: string; city?: string };
    if (body.ip) return { ip: body.ip, place: [body.country, body.city].filter(Boolean).join(', ') };
  } catch {
    // ipinfo may have rate-limited us — fall back to a service without geodata
  }
  const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) });
  const body = (await response.json()) as { ip: string };
  return { ip: body.ip, place: '' };
}
