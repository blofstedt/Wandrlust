/**
 * Generate a VAPID keypair for Web Push.
 *
 *   npm run vapid
 *
 * VAPID (Voluntary Application Server Identification) is how a push service
 * verifies that the server sending a notification is the one the browser
 * subscribed to. The public key goes in the client bundle; the private key
 * NEVER does.
 *
 * Uses node:crypto directly so this works before `web-push` is installed.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// The last 65 bytes of the SPKI DER encoding are the uncompressed EC point.
const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
const pub = pubDer.subarray(pubDer.length - 65);

// Bytes 36..68 of the PKCS8 DER encoding are the 32-byte private scalar.
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
const priv = privDer.subarray(36, 68);

if (pub.length !== 65 || priv.length !== 32) {
  console.error('Unexpected key length — refusing to emit a malformed keypair.');
  process.exit(1);
}

// randomBytes rather than the global Web Crypto, which is only guaranteed on
// newer Node versions and made this script fail on older ones.
const dispatchSecret = b64url(randomBytes(24));

console.log(`
VAPID keypair generated.

Add to .env:
------------------------------------------------------------
VITE_VAPID_PUBLIC_KEY=${b64url(pub)}
VAPID_PRIVATE_KEY=${b64url(priv)}
VAPID_SUBJECT=mailto:you@yourdomain.com
PUSH_DISPATCH_SECRET=${dispatchSecret}
------------------------------------------------------------

The PUBLIC key ships in the client bundle — that is expected.
The PRIVATE key must never leave the server. Do not commit it.

If you rotate these, every existing subscription becomes invalid and
users must re-enable alerts.
`);