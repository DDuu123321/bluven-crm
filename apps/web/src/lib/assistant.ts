import 'server-only';
import { ValidationError } from '@bluven/core';
import { AI_MESSAGES, assistantModel, type AiModel } from '@bluven/integrations';

/** The model to ask, or a plain message for the person who clicked when the assistant is switched off. */
export function requireAssistant(): AiModel {
  const model = assistantModel();
  if (!model) throw new ValidationError(AI_MESSAGES.off);
  return model;
}
