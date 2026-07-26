export { BUILTIN_PATTERNS, placeholder, type SecretPattern } from "./patterns.js";
export { MIN_KNOWN_SECRET_LENGTH, redactEvent, redactString } from "./redact.js";
export {
  redactAll,
  redactEventForRole,
  redactExceptDriver,
  type RedactionConfig,
  type RedactionPolicy,
} from "./policy.js";
