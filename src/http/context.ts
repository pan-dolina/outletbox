import type { DataStore } from '@tus/utils';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { Lang } from '../i18n.js';
import type { Mailer } from '../mail/index.js';
import type { StorageBackend } from '../storage/index.js';
import type { Session } from '../services/auth.js';
import type { AccessSession } from '../services/access.js';
import type { ResolvedLink } from '../services/links.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  storage: StorageBackend;
  tusStore: DataStore;
  mailer: Mailer;
}

// Request-scoped data attached by middleware.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** UI language for this request (cookie, then Accept-Language, then English). */
      lang: Lang;
      session?: Session;
      sessionId?: string;
      /** The delivery link addressed by /d/<token>. */
      delivery?: ResolvedLink;
      /** Clear-text token of the current delivery link (used to build in-page URLs). */
      deliveryToken?: string;
      /** Recipient session, once a one-time code has been accepted. */
      access?: AccessSession;
      accessId?: string;
      /** Per-browser token for the unlock flow (double-submit CSRF, challenge binding). */
      flowToken?: string;
    }
  }
}

export const SESSION_COOKIE = 'outletbox_sid';
export const ACCESS_COOKIE = 'outletbox_access';
export const FLOW_COOKIE = 'outletbox_flow';
