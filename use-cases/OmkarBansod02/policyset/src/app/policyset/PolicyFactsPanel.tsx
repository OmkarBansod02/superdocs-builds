import type { ChangeSet, PolicyProfile } from "@/domain";

type FactItem = {
  label: string;
  value: string;
};

export function PolicyFactsPanel({
  profile,
  returnWindowInput,
  activeChangeSet,
  disabled,
  onReturnWindowInputChange,
  onProposeReturnWindow,
}: {
  profile: PolicyProfile;
  returnWindowInput: string;
  activeChangeSet: ChangeSet | null;
  disabled: boolean;
  onReturnWindowInputChange: (value: string) => void;
  onProposeReturnWindow: () => void;
}) {
  const facts = factsFromProfile(profile);

  return (
    <aside className="facts-panel" aria-label="Policy Facts">
      <header className="facts-header">
        <h2>Policy Facts</h2>
        <p>These facts keep the four documents synchronized.</p>
      </header>
      <dl className="facts-list">
        {facts.map((fact) => (
          <div key={fact.label} className="facts-item">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <form
        className="shared-fact-editor"
        onSubmit={(event) => {
          event.preventDefault();
          onProposeReturnWindow();
        }}
      >
        <p className="shared-fact-eyebrow">Editable shared fact</p>
        <label htmlFor="return-window-days">Return window</label>
        <p className="shared-fact-current">
          Current: <strong>{profile.returns.windowDays} days</strong>
        </p>
        <div className="shared-fact-input-row">
          <input
            id="return-window-days"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={returnWindowInput}
            disabled={disabled}
            onChange={(event) => onReturnWindowInputChange(event.target.value)}
          />
          <span>days</span>
        </div>
        <button
          className="primary-button"
          type="submit"
          disabled={disabled || returnWindowInput.trim() === ""}
        >
          Propose synchronized update
        </button>
        {activeChangeSet ? (
          <div className="shared-fact-change" aria-label="Current ChangeSet">
            <p>
              <strong>{String(activeChangeSet.previousValue)} days</strong>
              <span aria-hidden="true"> → </span>
              <strong>{String(activeChangeSet.nextValue)} days</strong>
            </p>
            <p>Affected</p>
            <ul>
              {activeChangeSet.affectedDocuments.map((documentType) => (
                <li key={documentType}>{factDocumentLabel(documentType)}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </aside>
  );
}

function factDocumentLabel(documentType: ChangeSet["affectedDocuments"][number]) {
  return documentType === "terms"
    ? "Terms"
    : documentType === "returns"
      ? "Returns"
      : documentType === "privacy"
        ? "Privacy"
        : "Warranty";
}

function factsFromProfile(profile: PolicyProfile): FactItem[] {
  return [
    { label: "Company", value: profile.company.legalName },
    { label: "Effective date", value: profile.company.effectiveDate },
    { label: "Support email", value: profile.company.supportEmail },
    { label: "Jurisdiction", value: profile.company.governingJurisdiction },
    { label: "Returns", value: `${profile.returns.windowDays} days` },
    { label: "Warranty", value: `${profile.warranty.durationMonths} months` },
    {
      label: "Privacy retention",
      value: profile.privacy.retentionSummary,
    },
  ];
}
