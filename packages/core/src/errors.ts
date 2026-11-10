/** Errors the application layer raises on purpose. Their messages are safe to show to users. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The input is wrong. `fieldErrors` maps field names to messages. */
export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message, 'validation', 400);
    this.fieldErrors = fieldErrors;
  }
}

/** The actor is not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(message = 'You are not allowed to do this.') {
    super(message, 'forbidden', 403);
  }
}

/** The thing does not exist, or the actor may not know that it does. */
export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, 'not_found', 404);
  }
}

/** The request is valid but the current state does not allow it. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'conflict', 409);
  }
}

/** Collects field errors and throws a single ValidationError. */
export class FieldErrors {
  private readonly errors: Record<string, string> = {};
  add(field: string, message: string): void {
    this.errors[field] ??= message;
  }
  get any(): boolean {
    return Object.keys(this.errors).length > 0;
  }
  throwIfAny(message = 'Please correct the highlighted fields.'): void {
    if (this.any) throw new ValidationError(message, this.errors);
  }
}
