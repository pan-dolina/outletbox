import path from 'node:path';

export type StorageBackendKind = 'local' | 's3';
export type MailDriverKind = 'log' | 'smtp' | 'graph' | 'ses';

export interface Brand {
  /** Shown in titles, the top bar (when no logo) and the TOTP issuer. */
  name: string;
  /** Absolute path of a PNG/SVG/JPEG/WebP file served at /brand/logo, or null. */
  logoPath: string | null;
  colorPrimary: string;
  colorTopbar: string;
  colorAccent: string;
  footerText: string;
}

export interface MailConfig {
  driver: MailDriverKind;
  /** Envelope/From address. */
  from: string;
  fromName: string;
  replyTo: string | null;
  smtp: {
    host: string;
    port: number;
    /** true = implicit TLS (465); false = plain/STARTTLS (587, 25). */
    secure: boolean;
    requireTls: boolean;
    user?: string;
    pass?: string;
    /** Only for self-signed certificates on an internal relay. */
    allowInsecureTls: boolean;
  };
  graph: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /** Mailbox (UPN or object id) the message is sent as. */
    sender: string;
    /** Overridable for tests and sovereign clouds. */
    authority: string;
    apiBase: string;
    /** Keep a copy in the mailbox's Sent Items. */
    saveToSentItems: boolean;
  };
  ses: {
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    configurationSet?: string;
  };
}

export interface Config {
  publicUrl: string;
  brand: Brand;
  host: string;
  port: number;
  trustProxy: boolean | number | string;
  dataDir: string;
  databasePath: string;
  storage: StorageBackendKind;
  localStorageDir: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    partSize: number;
  };
  mail: MailConfig;
  maxFileBytes: number;
  uploadChunkBytes: number;
  incompleteUploadTtlMs: number;
  cleanupIntervalMs: number;
  sessionTtlMs: number;
  /** How long a one-time code stays valid. */
  accessCodeTtlMs: number;
  /** How long a recipient stays unlocked after entering a valid code. */
  accessSessionTtlMs: number;
  /** Wrong codes for one challenge before it is destroyed. */
  maxCodeAttempts: number;
  /** Codes that may be requested for one link per hour (anti-mail-bombing). */
  challengeLimitPerLinkPerHour: number;
  /** When true, admins without TOTP must enrol before using the panel. */
  adminRequireTotp: boolean;
  cookieSecure: boolean;
  loginRateLimitPer15Min: number;
  tokenFailureRateLimitPer15Min: number;
  publicRateLimitPerMinute: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

/** Parses "10GB", "512MiB", "1048576" into bytes. Binary units (1 MB = 1 MiB). */
export function parseSize(input: string, name = 'size'): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(input);
  if (!m) throw new Error(`Invalid ${name}: "${input}"`);
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === '' ? 1 : SIZE_UNITS[unit];
  if (mult === undefined) throw new Error(`Invalid unit in ${name}: "${input}"`);
  const value = Math.floor(Number(m[1]) * mult);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}: "${input}"`);
  return value;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${key}: "${raw}"`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(env: NodeJS.ProcessEnv, key: string, def = ''): string {
  return (env[key] ?? '').trim() || def;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** The logo formats the branding accepts, with the media type each is served as. */
export const LOGO_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const LOGO_EXTENSIONS = Object.keys(LOGO_MEDIA_TYPES);

function color(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const raw = (env[key] ?? '').trim();
  if (!raw) return def;
  if (!HEX_COLOR_RE.test(raw)) throw new Error(`${key} must be a hex colour like #0f766e`);
  return raw.toLowerCase();
}

export function loadBrand(env: NodeJS.ProcessEnv): Brand {
  const name = (env.BRAND_NAME ?? '').trim().slice(0, 60) || 'outletbox';
  let logoPath: string | null = null;
  if (env.BRAND_LOGO_PATH?.trim()) {
    logoPath = path.resolve(env.BRAND_LOGO_PATH.trim());
    if (!LOGO_EXTENSIONS.includes(path.extname(logoPath).toLowerCase())) throw new Error(`BRAND_LOGO_PATH must point to a ${LOGO_EXTENSIONS.join('/')} file`);
  }
  const colorPrimary = color(env, 'BRAND_COLOR_PRIMARY', '#1f6feb');
  return {
    name,
    logoPath,
    colorPrimary,
    colorTopbar: color(env, 'BRAND_COLOR_TOPBAR', '#101418'),
    colorAccent: color(env, 'BRAND_COLOR_ACCENT', colorPrimary),
    footerText: (env.BRAND_FOOTER_TEXT ?? '').trim().slice(0, 200) || '',
  };
}

/**
 * Mail transport. Every driver sends the same message object; only the plumbing
 * differs (see src/mail/). "log" writes the message to the log instead of
 * sending it — the default, so a fresh instance never silently mails anyone.
 */
export function loadMail(env: NodeJS.ProcessEnv, brandName: string): MailConfig {
  const driver = str(env, 'MAIL_DRIVER', 'log') as MailDriverKind;
  if (!['log', 'smtp', 'graph', 'ses'].includes(driver)) throw new Error(`MAIL_DRIVER must be log|smtp|graph|ses, got "${driver}"`);
  const from = str(env, 'MAIL_FROM', driver === 'log' ? 'outletbox@localhost' : '');
  if (!from) throw new Error(`MAIL_FROM is required when MAIL_DRIVER=${driver}`);
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(from)) throw new Error(`MAIL_FROM must be a bare e-mail address (no display name): "${from}"`);

  const smtpPort = num(env, 'SMTP_PORT', 587);
  const mail: MailConfig = {
    driver,
    from,
    fromName: str(env, 'MAIL_FROM_NAME', brandName).slice(0, 100),
    replyTo: str(env, 'MAIL_REPLY_TO') || null,
    smtp: {
      host: str(env, 'SMTP_HOST'),
      port: smtpPort,
      secure: bool(env, 'SMTP_SECURE', smtpPort === 465),
      requireTls: bool(env, 'SMTP_REQUIRE_TLS', true),
      user: str(env, 'SMTP_USER') || undefined,
      pass: env.SMTP_PASSWORD ?? env.SMTP_PASS ?? undefined,
      allowInsecureTls: bool(env, 'SMTP_ALLOW_INSECURE_TLS', false),
    },
    graph: {
      tenantId: str(env, 'GRAPH_TENANT_ID'),
      clientId: str(env, 'GRAPH_CLIENT_ID'),
      clientSecret: str(env, 'GRAPH_CLIENT_SECRET'),
      sender: str(env, 'GRAPH_SENDER', from),
      authority: str(env, 'GRAPH_AUTHORITY', 'https://login.microsoftonline.com').replace(/\/+$/, ''),
      apiBase: str(env, 'GRAPH_API_BASE', 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
      saveToSentItems: bool(env, 'GRAPH_SAVE_TO_SENT_ITEMS', false),
    },
    ses: {
      region: str(env, 'SES_REGION', str(env, 'AWS_REGION', 'eu-central-1')),
      endpoint: str(env, 'SES_ENDPOINT') || undefined,
      accessKeyId: str(env, 'SES_ACCESS_KEY_ID') || undefined,
      secretAccessKey: str(env, 'SES_SECRET_ACCESS_KEY') || undefined,
      configurationSet: str(env, 'SES_CONFIGURATION_SET') || undefined,
    },
  };

  if (driver === 'smtp') {
    if (!mail.smtp.host) throw new Error('SMTP_HOST is required when MAIL_DRIVER=smtp');
    if (mail.smtp.port < 1 || mail.smtp.port > 65535) throw new Error(`Invalid SMTP_PORT: ${mail.smtp.port}`);
    if (mail.smtp.user && mail.smtp.pass === undefined) throw new Error('SMTP_PASSWORD is required when SMTP_USER is set');
  }
  if (driver === 'graph') {
    for (const key of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'] as const) {
      if (!str(env, key)) throw new Error(`${key} is required when MAIL_DRIVER=graph`);
    }
  }
  return mail;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(publicUrl); } catch { throw new Error(`PUBLIC_URL is not a valid URL: "${publicUrl}"`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_URL must start with http:// or https://');

  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const storage = (env.STORAGE_BACKEND ?? 'local') as StorageBackendKind;
  if (!['local', 's3'].includes(storage)) throw new Error(`STORAGE_BACKEND must be "local" or "s3", got "${storage}"`);

  const trustRaw = (env.TRUST_PROXY ?? 'false').trim();
  let trustProxy: boolean | number | string = false;
  if (['true', 'yes', 'on'].includes(trustRaw.toLowerCase())) {
    // Blanket trust would let clients pick their own X-Forwarded-For (rate limits, audit IPs).
    throw new Error('TRUST_PROXY=true is not allowed: use the number of proxy hops (e.g. 1) or a list of proxy addresses/CIDRs');
  } else if (/^\d+$/.test(trustRaw)) trustProxy = Number(trustRaw);
  else if (trustRaw && !['false', '0', 'no', 'off'].includes(trustRaw.toLowerCase())) trustProxy = trustRaw;

  const s3PartSize = parseSize(env.S3_PART_SIZE ?? '8MB', 'S3_PART_SIZE');
  if (storage === 's3') {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_BACKEND=s3');
    if (s3PartSize < 5 * 1024 * 1024) throw new Error('S3_PART_SIZE must be at least 5MB');
  }

  const maxFileBytes = parseSize(env.MAX_FILE_SIZE ?? '10GB', 'MAX_FILE_SIZE');
  if (maxFileBytes < 1) throw new Error('MAX_FILE_SIZE must be positive');
  const uploadChunkBytes = parseSize(env.UPLOAD_CHUNK_SIZE ?? '32MB', 'UPLOAD_CHUNK_SIZE');
  if (uploadChunkBytes < 1024 * 1024) throw new Error('UPLOAD_CHUNK_SIZE must be at least 1MB');

  const logLevel = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error(`Invalid LOG_LEVEL: ${logLevel}`);

  const databasePath = env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, 'outletbox.sqlite');
  const localStorageDir = env.LOCAL_STORAGE_DIR ? path.resolve(env.LOCAL_STORAGE_DIR) : path.join(dataDir, 'files');
  if (storage === 'local' && path.dirname(databasePath) === localStorageDir) {
    throw new Error('The database must not live inside LOCAL_STORAGE_DIR (the orphan sweep only touches that directory, keep them apart)');
  }

  const brand = loadBrand(env);
  const maxCodeAttempts = num(env, 'MAX_CODE_ATTEMPTS', 5);
  if (maxCodeAttempts < 1) throw new Error('MAX_CODE_ATTEMPTS must be at least 1');

  return {
    publicUrl,
    brand,
    host: env.HOST ?? '0.0.0.0',
    port: num(env, 'PORT', 3000),
    trustProxy,
    dataDir,
    databasePath,
    storage,
    localStorageDir,
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: bool(env, 'S3_FORCE_PATH_STYLE', true),
      partSize: s3PartSize,
    },
    mail: loadMail(env, brand.name),
    maxFileBytes,
    uploadChunkBytes,
    incompleteUploadTtlMs: num(env, 'INCOMPLETE_UPLOAD_TTL_HOURS', 24) * 3600_000,
    cleanupIntervalMs: num(env, 'CLEANUP_INTERVAL_MINUTES', 30) * 60_000,
    sessionTtlMs: num(env, 'SESSION_TTL_HOURS', 12) * 3600_000,
    accessCodeTtlMs: num(env, 'ACCESS_CODE_TTL_MINUTES', 15) * 60_000,
    accessSessionTtlMs: num(env, 'ACCESS_SESSION_TTL_MINUTES', 60) * 60_000,
    maxCodeAttempts,
    challengeLimitPerLinkPerHour: num(env, 'CHALLENGE_LIMIT_PER_LINK_PER_HOUR', 5),
    adminRequireTotp: bool(env, 'ADMIN_REQUIRE_TOTP', false),
    cookieSecure: bool(env, 'COOKIE_SECURE', parsed.protocol === 'https:'),
    loginRateLimitPer15Min: num(env, 'LOGIN_RATE_LIMIT_PER_15MIN', 10),
    tokenFailureRateLimitPer15Min: num(env, 'TOKEN_FAILURE_RATE_LIMIT_PER_15MIN', 30),
    publicRateLimitPerMinute: num(env, 'PUBLIC_RATE_LIMIT_PER_MINUTE', 600),
    logLevel,
  };
}
