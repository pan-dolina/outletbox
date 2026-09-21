import fs from 'node:fs';
import path from 'node:path';
import { LOGO_MEDIA_TYPES, type Brand } from '../config.js';
import { log } from '../log.js';
import type { InlineImage } from './types.js';

/** The `cid:` the HTML part points at. Arbitrary, but must not look like an address. */
export const LOGO_CONTENT_ID = 'brand-logo@outletbox';

/**
 * A logo has to travel inside every message, so an oversized file is not a
 * cosmetic problem: 2 MB of base64 on each code e-mail is what gets an instance
 * throttled by its relay. Beyond this the message links the logo instead.
 */
const MAX_INLINE_BYTES = 512 * 1024;

const cache = new Map<string, InlineImage | null>();

/**
 * The configured logo, ready to be attached to a message, or null when there is
 * none, it cannot be read, or it is too big to carry. Read once per path: the
 * file cannot change without a restart anyway, since the path comes from the
 * environment.
 */
export function brandLogoImage(brand: Brand): InlineImage | null {
  if (!brand.logoPath) return null;
  const cached = cache.get(brand.logoPath);
  if (cached !== undefined) return cached;

  let image: InlineImage | null = null;
  const contentType = LOGO_MEDIA_TYPES[path.extname(brand.logoPath).toLowerCase()];
  try {
    const content = fs.readFileSync(brand.logoPath);
    if (!contentType) {
      log.warn('mail: the brand logo has an unsupported type and will be linked, not attached', { logo: brand.logoPath });
    } else if (content.byteLength > MAX_INLINE_BYTES) {
      log.warn('mail: the brand logo is too large to attach and will be linked instead', { logo: brand.logoPath, bytes: content.byteLength, limit: MAX_INLINE_BYTES });
    } else {
      image = { contentId: LOGO_CONTENT_ID, filename: path.basename(brand.logoPath), contentType, content };
    }
  } catch (err) {
    // The pages have the same problem and answer 404; a message is not worth failing over.
    log.warn('mail: the brand logo could not be read and will be linked instead', { logo: brand.logoPath, err: err as Error });
  }
  cache.set(brand.logoPath, image);
  return image;
}

/** Tests boot several instances with different branding in one process. */
export function clearLogoCache(): void {
  cache.clear();
}
