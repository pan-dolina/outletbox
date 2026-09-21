import type { IncomingMessage } from 'node:http';
import type { Request, Response } from 'express';
import { Server as TusServer, EVENTS } from '@tus/server';
import type { Upload } from '@tus/utils';
import { ID_RE, newId } from '../crypto.js';
import { log } from '../log.js';
import { audit } from '../services/audit.js';
import { getCase } from '../services/cases.js';
import { completeUpload, failUpload, getItem, LimitError, startUpload } from '../services/items.js';
import type { AppContext } from './context.js';

export const TUS_PATH = '/admin/api/tus';

interface TusHttpError { status_code: number; body: string }

function tusError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): TusHttpError {
  return { status_code: status, body: JSON.stringify({ error: code, message, ...extra }) };
}

/** The tus handlers receive a web-standard Request; the Express request (with the admin session) hangs off its node runtime. */
function expressReq(req: unknown): Request {
  const r = req as { runtime?: { node?: { req?: IncomingMessage } }; node?: { req?: IncomingMessage } };
  const node = r.runtime?.node?.req ?? r.node?.req;
  if (!node) throw new Error('tus: node request unavailable');
  return node as Request;
}

function adminId(req: unknown): string {
  const session = expressReq(req).session;
  if (!session) throw tusError(401, 'unauthorized', 'Administrator session required');
  return session.admin.id;
}

/**
 * Resumable uploads for the administrator's browser.
 *
 * Authorization model:
 *  - Express has already checked the admin session and the CSRF header before
 *    any of this runs (see adminRouter);
 *  - POST names the target case in the upload metadata and the case must be open;
 *  - HEAD/PATCH/DELETE are only accepted while the item is still 'uploading',
 *    so a finished file can never be rewritten through tus;
 *  - GET is refused outright, so tus can never become a download path.
 */
export function createTusServer(ctx: AppContext): TusServer {
  const server = new TusServer({
    path: TUS_PATH,
    datastore: ctx.tusStore,
    relativeLocation: true,
    disableTerminationForFinishedUploads: true,
    namingFunction: () => newId('f'),
    maxSize: () => ctx.cfg.maxFileBytes,

    onIncomingRequest: async (req, uploadId) => {
      const method = expressReq(req).method;
      adminId(req);
      if (method === 'POST' || method === 'OPTIONS') return;
      const item = getItem(ctx.db, uploadId);
      if (!item) throw tusError(404, 'upload_not_found', 'Upload not found');
      if (item.status !== 'uploading') {
        throw tusError(410, 'upload_finished', `Upload is ${item.status} and can no longer be modified`);
      }
    },

    onUploadCreate: async (req, upload: Upload) => {
      const ereq = expressReq(req);
      const admin = adminId(req);
      if (upload.sizeIsDeferred || upload.size === undefined) {
        throw tusError(400, 'length_required', 'Upload-Length is required (deferred length is not supported)');
      }
      const caseId = upload.metadata?.caseId ?? '';
      if (!ID_RE.test(caseId)) throw tusError(400, 'case_required', 'Upload-Metadata must carry a valid caseId');
      const c = getCase(ctx.db, caseId);
      if (!c) throw tusError(404, 'case_not_found', 'Case not found');
      if (c.status !== 'open') throw tusError(403, 'case_closed', 'The case is closed');
      try {
        startUpload(ctx.db, ctx.cfg, {
          id: upload.id,
          caseId,
          originalName: upload.metadata?.filename ?? 'unnamed',
          uploadKind: 'tus',
          declaredSize: upload.size,
          adminId: admin,
        });
      } catch (err) {
        if (err instanceof LimitError) throw tusError(413, err.code, err.message, { limit: err.limit });
        throw err;
      }
      audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.start', caseId, itemId: upload.id, ip: ereq.ip, details: { kind: 'tus', size: upload.size } });
      return {};
    },

    onUploadFinish: async (req, upload: Upload) => {
      const ereq = expressReq(req);
      const admin = adminId(req);
      if (upload.size === undefined || upload.offset !== upload.size) {
        throw tusError(500, 'incomplete', 'Upload finished with unexpected offset');
      }
      const item = getItem(ctx.db, upload.id);
      const changed = completeUpload(ctx.db, upload.id, upload.size);
      if (changed) {
        audit(ctx.db, { actorType: 'admin', actorId: admin, action: 'upload.complete', caseId: item?.case_id, itemId: upload.id, ip: ereq.ip, details: { kind: 'tus', size: upload.size, name: upload.metadata?.filename } });
        // Without its sidecar the upload can no longer be addressed via tus at all.
        ctx.storage.removeTusSidecar(upload.id).catch((e) => log.warn('tus: sidecar cleanup failed', { itemId: upload.id, err: e }));
      }
      return { status_code: 204 };
    },

    onResponseError: async (_req, err) => {
      if ('status_code' in err && typeof err.body === 'string' && err.body.startsWith('{')) return { status_code: err.status_code, body: err.body };
      if ('status_code' in err) return { status_code: err.status_code, body: JSON.stringify({ error: 'tus_error', message: err.body.trim() }) };
      log.error('tus: unexpected error', { err });
      return { status_code: 500, body: JSON.stringify({ error: 'internal', message: 'Internal error' }) };
    },
  });

  // Client-initiated termination of an in-progress upload.
  server.on(EVENTS.POST_TERMINATE, (_req, _res, id: string) => {
    try {
      const item = getItem(ctx.db, id);
      if (item && failUpload(ctx.db, id, 'aborted')) {
        audit(ctx.db, { actorType: 'admin', action: 'upload.cancel', caseId: item.case_id, itemId: id });
      }
    } catch (err) {
      log.warn('tus: terminate bookkeeping failed', { err });
    }
  });

  return server;
}

/** Express adapter. GET is refused so the tus server can never act as a download endpoint. */
export function tusHandler(server: TusServer) {
  return (req: Request, res: Response): void => {
    if (req.method === 'GET') {
      res.status(405).json({ error: 'method_not_allowed', message: 'Uploads cannot be read back through tus' });
      return;
    }
    if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
    server.handle(req, res).catch((err) => {
      log.error('tus: handler failed', { err });
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    });
  };
}
