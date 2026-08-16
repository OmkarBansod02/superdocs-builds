import type { PolicyProfile } from "@/domain";

type FactItem = {
  label: string;
  value: string;
};

export function PolicyFactsPanel({ profile }: { profile: PolicyProfile }) {
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
    </aside>
  );
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
