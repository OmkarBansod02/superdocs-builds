import type { ReactNode } from "react";
import {
  ATTORNEY_REVIEW_DISCLAIMER,
  type PolicyDocumentType,
  type PolicyProfile,
} from "@/domain";
import { parseRendererHtml } from "@/documents/parse-html";
import { POLICY_DOCUMENT_TITLES } from "@/documents/spec";

/**
 * Deterministic HTML preview of a generated policy document.
 * This is not the SuperDocs editor. Later phases replace this surface
 * with SuperDocs editing behavior.
 */
export function DocumentPreview({
  documentType,
  html,
  profile,
}: {
  documentType: PolicyDocumentType;
  html: string;
  profile: PolicyProfile;
}) {
  const body = previewBody(html, profile.company.legalName);
  const title =
    body.title ?? POLICY_DOCUMENT_TITLES[documentType];

  return (
    <article
      className="document-preview"
      data-preview-surface="deterministic-html"
      data-policy-document={documentType}
    >
      <p className="document-kicker">Deterministic preview</p>
      <header className="document-header">
        <h1>{title}</h1>
        <p className="document-meta">
          {profile.company.legalName}
          <span aria-hidden="true"> · </span>
          Effective {formatEffectiveDate(profile.company.effectiveDate)}
        </p>
      </header>
      <div className="document-body">
        {body.nodes}
      </div>
      <footer className="document-disclaimer">
        {ATTORNEY_REVIEW_DISCLAIMER}
      </footer>
    </article>
  );
}

function previewBody(
  html: string,
  legalName: string,
): { title: string | null; nodes: ReactNode[] } {
  const blocks = parseRendererHtml(html);
  let title: string | null = null;
  const nodes: ReactNode[] = [];
  let skippedCompanyLine = false;

  for (const [index, block] of blocks.entries()) {
    if (block.kind === "fact") {
      continue;
    }

    if (block.kind === "heading" && block.level === 1 && title === null) {
      title = block.text;
      continue;
    }

    if (
      !skippedCompanyLine &&
      block.kind === "paragraph" &&
      block.text === legalName
    ) {
      skippedCompanyLine = true;
      continue;
    }

    if (block.kind === "heading") {
      nodes.push(<h2 key={`${block.kind}-${index}`}>{block.text}</h2>);
      continue;
    }

    nodes.push(<p key={`${block.kind}-${index}`}>{block.text}</p>);
  }

  return { title, nodes };
}

function formatEffectiveDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return iso;
  }

  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
