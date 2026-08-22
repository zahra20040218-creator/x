import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentRequestContext, type Logger } from '../common/logger.js';
import { internalProblem, ProblemError, type ProblemBody } from '../common/problem.js';
import { IdempotencyInProgressError } from '../idempotency/idempotency.service.js';

/**
 * The single exit point for every error. CLAUDE.md §9 - RFC 9457 problem+json.
 *
 * The important property is not the format, it is that a handler CANNOT return
 * an ad-hoc error shape. Anything that is not a `ProblemError` becomes a
 * generic 500 with no detail taken from the original exception, because an
 * unplanned error's message was never reviewed for what it discloses - a
 * Postgres constraint violation happily includes the row values, and those
 * include phone numbers.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger?: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const requestId = currentRequestContext()?.requestId;
    const instance = request.originalUrl;

    const body = this.toBody(exception, requestId, instance);

    if (body.status >= 500) {
      // Logged with the full error; the CLIENT gets none of it.
      this.logger?.error(
        { err: exception, event: 'request.failed', status: body.status },
        'unhandled error',
      );
    }

    response
      .status(body.status)
      .setHeader('Content-Type', 'application/problem+json')
      .json(body);
  }

  private toBody(
    exception: unknown,
    requestId: string | undefined,
    instance: string,
  ): ProblemBody {
    if (exception instanceof ProblemError) {
      return exception.toBody(requestId, instance);
    }

    if (exception instanceof IdempotencyInProgressError) {
      return {
        type: `https://api.rideapp.iq/problems/${exception.type}`,
        title: 'Request already in progress',
        status: exception.status,
        detail: exception.message,
        ...(instance ? { instance } : {}),
        ...(requestId ? { requestId } : {}),
      };
    }

    // Nest's own exceptions (404 for an unknown route, 405, payload too large).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: `https://api.rideapp.iq/problems/http-${status}`,
        title: exception.name,
        status,
        // Only Nest's own message, which is a fixed string. A 5xx carries no
        // detail at all - see the note above about unreviewed error text.
        ...(status < 500 ? { detail: exception.message } : {}),
        ...(instance ? { instance } : {}),
        ...(requestId ? { requestId } : {}),
      };
    }

    return internalProblem(requestId, instance);
  }
}
