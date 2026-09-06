import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ValidationProblem } from '../common/problem.js';

/**
 * CLAUDE.md §9 - "Every endpoint validated with a Zod schema at the boundary."
 *
 * Validation happens here rather than inside handlers so that a handler can
 * never receive an unvalidated body. The parsed value REPLACES the input, so
 * coercions (string to number in a query param) are what the handler sees, and
 * unknown keys are stripped rather than passed through to a repository.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationProblem(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    return result.data;
  }
}

/** Convenience: `@Body(zodBody(CreateRideSchema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * The same pipe for a path parameter: `@Param('id', zodParam(UuidSchema))`.
 *
 * Calling `schema.parse(param)` inside a handler instead looks equivalent and
 * is not. A bare `parse` throws a raw `ZodError`, which no filter in this
 * application maps, so a malformed id in a URL answered **500** — telling the
 * caller the server broke when in fact they sent something invalid, and
 * spending an error budget on a client mistake. Going through the pipe raises
 * `ValidationProblem` and returns the 400 the contract publishes.
 */
export function zodParam<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
