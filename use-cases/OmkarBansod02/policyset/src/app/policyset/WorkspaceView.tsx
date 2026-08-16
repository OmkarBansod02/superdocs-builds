"use client";

import { useState } from "react";
import {
  POLICY_DOCUMENT_TYPES,
  type PolicyDocumentType,
  type ValidationResult,
} from "@/domain";
import { DocumentPreview } from "./DocumentPreview";
import type { PolicyWorkspaceState } from "./generate-workspace";
import { PolicyFactsPanel } from "./PolicyFactsPanel";

const TAB_LABELS: Record<PolicyDocumentType, string> = {
  terms: "Terms",
  privacy: "Privacy",
  warranty: "Warranty",
  returns: "Returns",
};

export function WorkspaceView({
  workspace,
  onEditIntake,
}: {
  workspace: PolicyWorkspaceState;
  onEditIntake: () => void;
}) {
  const [activeTab, setActiveTab] = useState<PolicyDocumentType>("terms");
  const { profile, documents, validation } = workspace;

  return (
    <div className="app-frame workspace">
      <header className="chrome workspace-chrome">
        <div className="chrome-identity">
          <p className="brand">Policy Set</p>
          <p className="chrome-subtitle">{profile.company.legalName}</p>
        </div>
        <div className="workspace-chrome-actions">
          <ConsistencyStatus validation={validation} />
          <button className="text-button" type="button" onClick={onEditIntake}>
            Edit intake
          </button>
        </div>
      </header>

      <div className="workspace-body">
        <section className="workspace-main" aria-label="Policy documents">
          <div className="document-tabs" role="tablist" aria-label="Documents">
            {POLICY_DOCUMENT_TYPES.map((documentType) => (
              <button
                key={documentType}
                type="button"
                role="tab"
                aria-selected={activeTab === documentType}
                className={
                  activeTab === documentType
                    ? "document-tab is-active"
                    : "document-tab"
                }
                onClick={() => setActiveTab(documentType)}
              >
                {TAB_LABELS[documentType]}
              </button>
            ))}
          </div>

          <div className="document-stage" role="tabpanel">
            <DocumentPreview
              documentType={activeTab}
              html={documents[activeTab]}
              profile={profile}
            />
          </div>
        </section>

        <PolicyFactsPanel profile={profile} />
      </div>
    </div>
  );
}

function ConsistencyStatus({ validation }: { validation: ValidationResult }) {
  if (validation.ok) {
    return (
      <p className="status status-ok" role="status">
        ✓ Policy set consistent
      </p>
    );
  }

  return (
    <div className="status status-attention" role="status">
      <p>Policy set needs attention</p>
      <ul>
        {validation.issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
