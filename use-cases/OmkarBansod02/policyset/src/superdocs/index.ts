/**
 * Server-side SuperDocs adapter. Do not import from Client Components.
 * All calls require SUPERDOCS_API_KEY from the process environment.
 */

export { SuperDocsClient, buildStartChatPayload, createSessionId } from "./client";
export { getSuperDocsApiKey } from "./config";
export {
  SuperDocsError,
  SuperDocsInvalidResponse,
  SuperDocsRequestError,
} from "./errors";
export {
  DOCX_MIME,
  PDF_MIME,
  SUPERDOCS_API_BASE,
  SUPERDOCS_JOB_STATUSES,
  SUPERDOCS_OPEN_MODES,
  type ExportArtifact,
  type ExportFormat,
  type FocusedDocument,
  type IngestedDocument,
  type JobReference,
  type JobSnapshot,
  type PendingChange,
  type ReviewDecision,
  type ReviewReceipt,
  type SessionDocument,
  type SessionDocumentIdentity,
  type StartChatInput,
  type SuperDocsClientOptions,
  type SuperDocsJobStatus,
  type SuperDocsOpenMode,
} from "./types";
