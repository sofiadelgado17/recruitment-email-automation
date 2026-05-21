import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export function createError(message: string, statusCode: number): AppError {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  return err;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? 500;
  const message = err.isOperational ? err.message : 'Internal server error';

  // Always log the full stack server-side so we can debug.
  console.error('[Error]', err);

  // Only expose stack to the client when we're truly running on a developer
  // machine: NODE_ENV !== 'production' AND not on Vercel (Vercel sometimes
  // leaves NODE_ENV unset on preview deploys, which previously could leak
  // stacks). Even then, never include stack on 5xx — those frequently expose
  // internal paths/credentials embedded in stack traces.
  const isLocalDev =
    process.env.NODE_ENV !== 'production' && !process.env.VERCEL;
  const exposeStack = isLocalDev && statusCode < 500;

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(exposeStack && { stack: err.stack }),
  });
}
