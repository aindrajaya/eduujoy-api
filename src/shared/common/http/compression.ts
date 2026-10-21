import { constants } from 'node:zlib';
import compression from 'compression';
import { type Request, type RequestHandler, type Response } from 'express';

/** Responses smaller than this go uncompressed; below ~1 KB the encoding overhead outweighs the saving. */
export const COMPRESSION_THRESHOLD = 1024;

/**
 * gzip or brotli for responses above the threshold, whichever the client prefers. Server-sent events are
 * never compressed: buffering in the encoder would delay each event (PRD-API §6, contract 0.3.0-v0).
 */
export function createCompression(): RequestHandler {
  return compression({
    threshold: COMPRESSION_THRESHOLD,
    // Brotli's default quality (11) is for static assets; 4 compresses JSON well at gzip-like CPU cost.
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    filter: (req: Request, res: Response) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && type.toLowerCase().startsWith('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  });
}
