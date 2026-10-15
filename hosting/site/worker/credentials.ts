import { fail } from './types.ts';

const encoder = new TextEncoder();

export function randomToken(bytes = 32) {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(text: string) {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}

export async function tokenHash(token: string) {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

async function key(secret: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret ?? '')) fail(503, 'Meeting credential encryption is not configured');
  return crypto.subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(token: string, roomId: string, secret: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(roomId) }, await key(secret), encoder.encode(token));
  return `v1.${encode(nonce)}.${encode(new Uint8Array(encrypted))}`;
}

export async function decryptToken(ciphertext: string, roomId: string, secret: string) {
  const [version, nonce, encrypted] = ciphertext.split('.');
  if (version !== 'v1') fail(503, 'Start a new meeting to reconnect Jira');
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(nonce), additionalData: encoder.encode(roomId) }, await key(secret), decode(encrypted));
    return new TextDecoder().decode(plaintext);
  } catch {
    return fail(503, 'Start a new meeting to reconnect Jira');
  }
}
